const e=`-- Настройки студии из кабинета владельца.\r
-- business.json задаёт студию при создании, дальше владелец правит данные сам.\r
-- Раздел, который владелец хоть раз изменил, попадает в tenants.owner_managed,\r
-- и повторная публикация конфига его больше не перезаписывает.\r
\r
alter table public.tenants add column if not exists owner_managed text[] not null default '{}';\r
\r
alter table public.tenant_media drop constraint if exists tenant_media_kind;\r
alter table public.tenant_media add constraint tenant_media_kind check (kind in ('cover', 'logo', 'gallery', 'service'));\r
alter table public.tenant_media add column if not exists updated_at timestamptz not null default now();\r
\r
-- Адрес картинки: относительный путь сайта или https. Никаких javascript:, data: и прочего.\r
create or replace function private.valid_media_url(p_url text) returns boolean\r
language sql immutable as $$\r
  select p_url is not null and length(p_url) <= 1000 and (\r
    p_url ~ '^/[A-Za-z0-9/_.~%-]+$'\r
    or p_url ~ '^https://[^\\s"''<>]+$'\r
    -- локальный стенд разработки\r
    or p_url ~ '^http://(127\\.0\\.0\\.1|localhost)(:[0-9]+)?/[^\\s"''<>]+$')\r
$$;\r
\r
create or replace function private.mark_owner_managed(p_tenant uuid, p_section text) returns void\r
language sql security definer set search_path = '' as $$\r
  update public.tenants set owner_managed = array(select distinct unnest(owner_managed || array[p_section]))\r
   where id = p_tenant;\r
$$;\r
\r
-- ---------- чтение настроек ----------\r
create or replace function public.owner_get_settings(p_tenant_id uuid) returns jsonb\r
language plpgsql stable security definer set search_path = '' as $$\r
declare\r
  t public.tenants;\r
begin\r
  begin\r
    perform private.assert_member(p_tenant_id);\r
  exception when sqlstate 'P0001' then\r
    return private.err(sqlerrm);\r
  end;\r
  select * into t from public.tenants where id = p_tenant_id;\r
  return jsonb_build_object('ok', true,\r
    'tenant', jsonb_build_object('id', t.id, 'slug', t.slug, 'name', t.name, 'timezone', t.timezone, 'currency', t.currency,\r
                                 'status', t.status, 'owner_managed', to_jsonb(t.owner_managed)),\r
    'contacts', coalesce(t.public_config -> 'contacts', '{}'::jsonb),\r
    'texts', coalesce(t.public_config -> 'texts', '{}'::jsonb),\r
    'cards', coalesce(t.public_config -> 'cards', '[]'::jsonb),\r
    'resources', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'is_active', r.is_active,\r
        'future_bookings', (select count(*) from public.bookings b where b.resource_id = r.id\r
                             and b.status in ('new', 'confirmed') and b.starts_at > now())) order by r.sort, r.name)\r
      from public.resources r where r.tenant_id = t.id), '[]'::jsonb),\r
    'services', coalesce((select jsonb_agg(jsonb_build_object(\r
        'id', s.id, 'name', s.name, 'description', s.description, 'category', s.category,\r
        'duration_minutes', s.duration_minutes, 'buffer_minutes', s.buffer_minutes, 'is_active', s.is_active, 'image', s.image,\r
        'price_minor', p.price_minor, 'price_is_from', p.price_is_from,\r
        'resource_ids', coalesce((select jsonb_agg(sr.resource_id) from public.service_resources sr where sr.service_id = s.id), '[]'::jsonb))\r
        order by s.is_active desc, s.sort, s.name)\r
      from public.services s\r
      left join lateral (select sp.price_minor, sp.price_is_from from public.service_prices sp\r
                          where sp.service_id = s.id and sp.valid_from <= now() order by sp.valid_from desc limit 1) p on true\r
      where s.tenant_id = t.id), '[]'::jsonb),\r
    'hours', coalesce((select jsonb_agg(jsonb_build_object('weekday', w.weekday, 'opens', to_char(w.opens, 'HH24:MI'),\r
                                                           'closes', to_char(w.closes, 'HH24:MI')) order by w.weekday, w.opens)\r
      from public.working_hours w where w.tenant_id = t.id), '[]'::jsonb),\r
    'exceptions', coalesce((select jsonb_agg(jsonb_build_object('day', e.day, 'closed', e.is_closed,\r
                                                                'opens', to_char(e.opens, 'HH24:MI'), 'closes', to_char(e.closes, 'HH24:MI'),\r
                                                                'note', e.note) order by e.day)\r
      from public.schedule_exceptions e where e.tenant_id = t.id and e.day >= (now() at time zone t.timezone)::date - 1), '[]'::jsonb),\r
    'media', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'kind', m.kind, 'url', m.url, 'caption', m.alt,\r
                                                           'source', m.source, 'sort', m.sort) order by m.kind, m.sort, m.created_at)\r
      from public.tenant_media m where m.tenant_id = t.id), '[]'::jsonb));\r
end $$;\r
\r
-- ---------- контакты и три карточки ----------\r
create or replace function public.owner_update_contacts(p_tenant_id uuid, p_contacts jsonb) returns jsonb\r
language plpgsql security definer set search_path = '' as $$\r
declare\r
  v_phone text := btrim(coalesce(p_contacts ->> 'phone', ''));\r
  v_address text := btrim(coalesce(p_contacts ->> 'address', ''));\r
begin\r
  begin\r
    perform private.assert_member(p_tenant_id);\r
    if length(regexp_replace(v_phone, '\\D', '', 'g')) not between 10 and 15 then perform private.fail('invalid_phone'); end if;\r
    if length(v_address) not between 3 and 200 then perform private.fail('invalid_address'); end if;\r
    if length(coalesce(p_contacts ->> 'whatsapp', '')) > 40 or length(coalesce(p_contacts ->> 'telegram', '')) > 60\r
       or length(coalesce(p_contacts ->> 'email', '')) > 120 or length(coalesce(p_contacts ->> 'mapUrl', '')) > 500 then\r
      perform private.fail('too_long');\r
    end if;\r
    if coalesce(p_contacts ->> 'mapUrl', '') <> '' and p_contacts ->> 'mapUrl' !~ '^https://' then perform private.fail('invalid_url'); end if;\r
    update public.tenants set public_config = jsonb_set(public_config, '{contacts}', jsonb_build_object(\r
        'phone', v_phone, 'address', v_address,\r
        'whatsapp', btrim(coalesce(p_contacts ->> 'whatsapp', '')), 'telegram', btrim(coalesce(p_contacts ->> 'telegram', '')),\r
        'email', btrim(coalesce(p_contacts ->> 'email', '')), 'mapUrl', btrim(coalesce(p_contacts ->> 'mapUrl', ''))), true)\r
     where id = p_tenant_id;\r
    perform private.mark_owner_managed(p_tenant_id, 'contacts');\r
  exception when sqlstate 'P0001' then\r
    return private.err(sqlerrm);\r
  end;\r
  return public.owner_get_settings(p_tenant_id);\r
end $$;\r
\r
create or replace function public.owner_update_cards(p_tenant_id uuid, p_cards jsonb) returns jsonb\r
language plpgsql security definer set search_path = '' as $$\r
declare\r
  c jsonb;\r
  v_clean jsonb := '[]'::jsonb;\r
begin\r
  begin\r
    perform private.assert_member(p_tenant_id);\r
    if jsonb_typeof(p_cards) <> 'array' or jsonb_array_length(p_cards) <> 3 then perform private.fail('cards_must_be_three'); end if;\r
    for c in select * from jsonb_array_elements(p_cards) loop\r
      if length(btrim(coalesce(c ->> 'title', ''))) not between 1 and 40 or length(coalesce(c ->> 'text', '')) > 160 then\r
        perform private.fail('invalid_card');\r
      end if;\r
      v_clean := v_clean || jsonb_build_array(jsonb_build_object('title', btrim(c ->> 'title'), 'text', btrim(coalesce(c ->> 'text', ''))));\r
    end loop;\r
    update public.tenants set public_config = jsonb_set(public_config, '{cards}', v_clean, true) where id = p_tenant_id;\r
    perform private.mark_owner_managed(p_tenant_id, 'cards');\r
  exception when sqlstate 'P0001' then\r
    return private.err(sqlerrm);\r
  end;\r
  return public.owner_get_settings(p_tenant_id);\r
end $$;\r
\r
-- ---------- услуги ----------\r
-- p_service: { id?, name, description, category, duration_minutes, buffer_minutes, price_minor, price_is_from, resource_ids[], is_active }\r
-- price_minor = 0 означает «цена по запросу».\r
create or replace function public.owner_upsert_service(p_tenant_id uuid, p_service jsonb) returns jsonb\r
language plpgsql security definer set search_path = '' as $$\r
declare\r
  v_id uuid := nullif(p_service ->> 'id', '')::uuid;\r
  v_name text := btrim(coalesce(p_service ->> 'name', ''));\r
  v_duration int := (p_service ->> 'duration_minutes')::int;\r
  v_buffer int := coalesce((p_service ->> 'buffer_minutes')::int, 0);\r
  v_price bigint := coalesce((p_service ->> 'price_minor')::bigint, 0);\r
  v_from boolean := coalesce((p_service ->> 'price_is_from')::boolean, false);\r
  v_current public.service_prices;\r
  v_resources uuid[];\r
begin\r
  begin\r
    perform private.assert_member(p_tenant_id);\r
    if length(v_name) not between 2 and 60 then perform private.fail('invalid_name'); end if;\r
    if v_duration is null or v_duration not between 5 and 20160 then perform private.fail('invalid_duration'); end if;\r
    if v_buffer not between 0 and 1440 then perform private.fail('invalid_buffer'); end if;\r
    if v_price < 0 or v_price > 1000000000 then perform private.fail('invalid_amount'); end if;\r
    select array_agg(x::uuid) into v_resources from jsonb_array_elements_text(coalesce(p_service -> 'resource_ids', '[]'::jsonb)) x;\r
    if coalesce(array_length(v_resources, 1), 0) = 0 then perform private.fail('service_needs_resource'); end if;\r
    if exists (select 1 from unnest(v_resources) r where not exists (\r
         select 1 from public.resources res where res.tenant_id = p_tenant_id and res.id = r)) then\r
      perform private.fail('resource_not_found');\r
    end if;\r
\r
    if v_id is null then\r
      insert into public.services (tenant_id, key, name, description, category, duration_minutes, buffer_minutes, sort, is_active)\r
      values (p_tenant_id, 'svc-' || substr(md5(random()::text), 1, 8), v_name, left(coalesce(p_service ->> 'description', ''), 300),\r
              left(coalesce(p_service ->> 'category', ''), 40), v_duration, v_buffer,\r
              coalesce((select max(sort) + 1 from public.services where tenant_id = p_tenant_id), 1),\r
              coalesce((p_service ->> 'is_active')::boolean, true))\r
      returning id into v_id;\r
    else\r
      update public.services set name = v_name, description = left(coalesce(p_service ->> 'description', ''), 300),\r
             category = left(coalesce(p_service ->> 'category', ''), 40), duration_minutes = v_duration, buffer_minutes = v_buffer,\r
             is_active = coalesce((p_service ->> 'is_active')::boolean, true)\r
       where tenant_id = p_tenant_id and id = v_id;\r
      if not found then perform private.fail('service_not_found'); end if;\r
    end if;\r
\r
    -- цена: новая строка истории только при изменении, прошлые записи сохраняют свою цену\r
    select * into v_current from public.service_prices\r
     where service_id = v_id and valid_from <= now() order by valid_from desc limit 1;\r
    if not found or v_current.price_minor <> v_price or v_current.price_is_from <> v_from then\r
      insert into public.service_prices (tenant_id, service_id, price_minor, price_is_from, valid_from)\r
      values (p_tenant_id, v_id, v_price, v_from, now()); -- now(): цена видна уже в ответе этой же функции\r
    end if;\r
\r
    delete from public.service_resources where service_id = v_id;\r
    insert into public.service_resources (tenant_id, service_id, resource_id)\r
    select p_tenant_id, v_id, r from unnest(v_resources) r;\r
    perform private.mark_owner_managed(p_tenant_id, 'services');\r
  exception when sqlstate 'P0001' then\r
    return private.err(sqlerrm);\r
  end;\r
  return public.owner_get_settings(p_tenant_id);\r
end $$;\r
\r
-- ---------- боксы ----------\r
create or replace function public.owner_upsert_resource(p_tenant_id uuid, p_id uuid, p_name text, p_is_active boolean) returns jsonb\r
language plpgsql security definer set search_path = '' as $$\r
begin\r
  begin\r
    perform private.assert_member(p_tenant_id);\r
    if length(btrim(coalesce(p_name, ''))) not between 1 and 40 then perform private.fail('invalid_name'); end if;\r
    if p_id is null then\r
      insert into public.resources (tenant_id, key, name, sort, is_active)\r
      values (p_tenant_id, 'bay-' || substr(md5(random()::text), 1, 8), btrim(p_name),\r
              coalesce((select max(sort) + 1 from public.resources where tenant_id = p_tenant_id), 1), coalesce(p_is_active, true));\r
    else\r
      update public.resources set name = btrim(p_name), is_active = coalesce(p_is_active, true)\r
       where tenant_id = p_tenant_id and id = p_id;\r
      if not found then perform private.fail('resource_not_found'); end if;\r
    end if;\r
    perform private.mark_owner_managed(p_tenant_id, 'resources');\r
  exception when sqlstate 'P0001' then\r
    return private.err(sqlerrm);\r
  end;\r
  return public.owner_get_settings(p_tenant_id);\r
end $$;\r
\r
-- ---------- часы работы и выходные ----------\r
create or replace function public.owner_set_hours(p_tenant_id uuid, p_hours jsonb) returns jsonb\r
language plpgsql security definer set search_path = '' as $$\r
declare\r
  h jsonb;\r
begin\r
  begin\r
    perform private.assert_member(p_tenant_id);\r
    if jsonb_typeof(p_hours) <> 'array' or jsonb_array_length(p_hours) > 21 then perform private.fail('invalid_hours'); end if;\r
    delete from public.working_hours where tenant_id = p_tenant_id;\r
    for h in select * from jsonb_array_elements(p_hours) loop\r
      if (h ->> 'weekday')::int not between 1 and 7 or (h ->> 'opens')::time >= (h ->> 'closes')::time then\r
        perform private.fail('invalid_hours');\r
      end if;\r
      insert into public.working_hours (tenant_id, weekday, opens, closes)\r
      values (p_tenant_id, (h ->> 'weekday')::smallint, (h ->> 'opens')::time, (h ->> 'closes')::time);\r
    end loop;\r
    perform private.mark_owner_managed(p_tenant_id, 'hours');\r
  exception\r
    when sqlstate 'P0001' then return private.err(sqlerrm);\r
    when invalid_datetime_format or unique_violation then return private.err('invalid_hours');\r
  end;\r
  return public.owner_get_settings(p_tenant_id);\r
end $$;\r
\r
create or replace function public.owner_set_exception(\r
  p_tenant_id uuid, p_day date, p_closed boolean, p_opens time, p_closes time, p_note text\r
) returns jsonb\r
language plpgsql security definer set search_path = '' as $$\r
begin\r
  begin\r
    perform private.assert_member(p_tenant_id);\r
    if p_day is null then perform private.fail('invalid_day'); end if;\r
    if not coalesce(p_closed, true) and (p_opens is null or p_closes is null or p_opens >= p_closes) then\r
      perform private.fail('invalid_hours');\r
    end if;\r
    insert into public.schedule_exceptions (tenant_id, day, is_closed, opens, closes, note)\r
    values (p_tenant_id, p_day, coalesce(p_closed, true),\r
            case when coalesce(p_closed, true) then null else p_opens end,\r
            case when coalesce(p_closed, true) then null else p_closes end, left(coalesce(p_note, ''), 120))\r
    on conflict (tenant_id, day) do update set is_closed = excluded.is_closed, opens = excluded.opens,\r
      closes = excluded.closes, note = excluded.note;\r
    perform private.mark_owner_managed(p_tenant_id, 'exceptions');\r
  exception when sqlstate 'P0001' then\r
    return private.err(sqlerrm);\r
  end;\r
  return public.owner_get_settings(p_tenant_id);\r
end $$;\r
\r
create or replace function public.owner_delete_exception(p_tenant_id uuid, p_day date) returns jsonb\r
language plpgsql security definer set search_path = '' as $$\r
begin\r
  begin\r
    perform private.assert_member(p_tenant_id);\r
    delete from public.schedule_exceptions where tenant_id = p_tenant_id and day = p_day;\r
    perform private.mark_owner_managed(p_tenant_id, 'exceptions');\r
  exception when sqlstate 'P0001' then\r
    return private.err(sqlerrm);\r
  end;\r
  return public.owner_get_settings(p_tenant_id);\r
end $$;\r
\r
-- ---------- фото: логотип, главное фото, работы ----------\r
create or replace function public.owner_set_brand_media(p_tenant_id uuid, p_kind text, p_url text) returns jsonb\r
language plpgsql security definer set search_path = '' as $$\r
begin\r
  begin\r
    perform private.assert_member(p_tenant_id);\r
    if p_kind not in ('cover', 'logo') then perform private.fail('invalid_kind'); end if;\r
    if not private.valid_media_url(p_url) then perform private.fail('invalid_url'); end if;\r
    delete from public.tenant_media where tenant_id = p_tenant_id and kind = p_kind;\r
    insert into public.tenant_media (tenant_id, kind, url, alt, source, sort) values (p_tenant_id, p_kind, p_url, '', 'owner', 0);\r
    if p_kind = 'logo' then\r
      update public.tenants set public_config = jsonb_set(public_config, '{brand,icon}', to_jsonb(p_url), true) where id = p_tenant_id;\r
    end if;\r
    perform private.mark_owner_managed(p_tenant_id, p_kind);\r
  exception when sqlstate 'P0001' then\r
    return private.err(sqlerrm);\r
  end;\r
  return public.owner_get_settings(p_tenant_id);\r
end $$;\r
\r
-- Три отдельных действия с работами: добавить карточку, заменить фото конкретной карточки,\r
-- изменить подпись конкретной карточки. Остальные работы не трогаются.\r
create or replace function public.owner_add_work(p_tenant_id uuid, p_url text, p_caption text) returns jsonb\r
language plpgsql security definer set search_path = '' as $$\r
begin\r
  begin\r
    perform private.assert_member(p_tenant_id);\r
    if not private.valid_media_url(p_url) then perform private.fail('invalid_url'); end if;\r
    if (select count(*) from public.tenant_media where tenant_id = p_tenant_id and kind = 'gallery') >= 40 then\r
      perform private.fail('too_many_photos');\r
    end if;\r
    insert into public.tenant_media (tenant_id, kind, url, alt, source, sort)\r
    values (p_tenant_id, 'gallery', p_url, left(btrim(coalesce(p_caption, '')), 120), 'owner',\r
            coalesce((select max(sort) + 1 from public.tenant_media where tenant_id = p_tenant_id and kind = 'gallery'), 1));\r
    perform private.mark_owner_managed(p_tenant_id, 'gallery');\r
  exception when sqlstate 'P0001' then\r
    return private.err(sqlerrm);\r
  end;\r
  return public.owner_get_settings(p_tenant_id);\r
end $$;\r
\r
create or replace function private.owner_work(p_media_id uuid) returns public.tenant_media\r
language plpgsql security definer set search_path = '' as $$\r
declare\r
  m public.tenant_media;\r
begin\r
  select * into m from public.tenant_media where id = p_media_id and kind = 'gallery';\r
  if not found then perform private.fail('photo_not_found'); end if;\r
  perform private.assert_member(m.tenant_id);\r
  return m;\r
end $$;\r
\r
create or replace function public.owner_replace_work_photo(p_media_id uuid, p_url text) returns jsonb\r
language plpgsql security definer set search_path = '' as $$\r
declare\r
  m public.tenant_media;\r
begin\r
  begin\r
    m := private.owner_work(p_media_id);\r
    if not private.valid_media_url(p_url) then perform private.fail('invalid_url'); end if;\r
    update public.tenant_media set url = p_url, source = 'owner', updated_at = now() where id = m.id;\r
    perform private.mark_owner_managed(m.tenant_id, 'gallery');\r
  exception when sqlstate 'P0001' then\r
    return private.err(sqlerrm);\r
  end;\r
  return public.owner_get_settings(m.tenant_id);\r
end $$;\r
\r
create or replace function public.owner_update_work_caption(p_media_id uuid, p_caption text) returns jsonb\r
language plpgsql security definer set search_path = '' as $$\r
declare\r
  m public.tenant_media;\r
begin\r
  begin\r
    m := private.owner_work(p_media_id);\r
    update public.tenant_media set alt = left(btrim(coalesce(p_caption, '')), 120), source = 'owner', updated_at = now() where id = m.id;\r
    perform private.mark_owner_managed(m.tenant_id, 'gallery');\r
  exception when sqlstate 'P0001' then\r
    return private.err(sqlerrm);\r
  end;\r
  return public.owner_get_settings(m.tenant_id);\r
end $$;\r
\r
create or replace function public.owner_delete_work(p_media_id uuid) returns jsonb\r
language plpgsql security definer set search_path = '' as $$\r
declare\r
  m public.tenant_media;\r
begin\r
  begin\r
    m := private.owner_work(p_media_id);\r
    delete from public.tenant_media where id = m.id;\r
    perform private.mark_owner_managed(m.tenant_id, 'gallery');\r
  exception when sqlstate 'P0001' then\r
    return private.err(sqlerrm);\r
  end;\r
  return public.owner_get_settings(m.tenant_id);\r
end $$;\r
\r
grant execute on function public.owner_get_settings(uuid) to authenticated;\r
grant execute on function public.owner_update_contacts(uuid, jsonb) to authenticated;\r
grant execute on function public.owner_update_cards(uuid, jsonb) to authenticated;\r
grant execute on function public.owner_upsert_service(uuid, jsonb) to authenticated;\r
grant execute on function public.owner_upsert_resource(uuid, uuid, text, boolean) to authenticated;\r
grant execute on function public.owner_set_hours(uuid, jsonb) to authenticated;\r
grant execute on function public.owner_set_exception(uuid, date, boolean, time, time, text) to authenticated;\r
grant execute on function public.owner_delete_exception(uuid, date) to authenticated;\r
grant execute on function public.owner_set_brand_media(uuid, text, text) to authenticated;\r
grant execute on function public.owner_add_work(uuid, text, text) to authenticated;\r
grant execute on function public.owner_replace_work_photo(uuid, text) to authenticated;\r
grant execute on function public.owner_update_work_caption(uuid, text) to authenticated;\r
grant execute on function public.owner_delete_work(uuid) to authenticated;\r
\r
-- ---------- Supabase Storage: фото студии ----------\r
-- Бакет публичный на чтение; писать может только член студии и только в папку {tenant_id}/.\r
do $$\r
begin\r
  if exists (select 1 from pg_namespace where nspname = 'storage')\r
     and exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'storage' and c.relname = 'buckets') then\r
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)\r
    values ('tenant-media', 'tenant-media', true, 8388608, array['image/jpeg', 'image/png', 'image/webp'])\r
    on conflict (id) do nothing;\r
\r
    execute $p$\r
      create policy tenant_media_member_insert on storage.objects for insert to authenticated\r
      with check (bucket_id = 'tenant-media' and private.is_member(((storage.foldername(name))[1])::uuid))\r
    $p$;\r
    execute $p$\r
      create policy tenant_media_member_update on storage.objects for update to authenticated\r
      using (bucket_id = 'tenant-media' and private.is_member(((storage.foldername(name))[1])::uuid))\r
    $p$;\r
    execute $p$\r
      create policy tenant_media_member_delete on storage.objects for delete to authenticated\r
      using (bucket_id = 'tenant-media' and private.is_member(((storage.foldername(name))[1])::uuid))\r
    $p$;\r
  end if;\r
end $$;\r
`;export{e as default};
