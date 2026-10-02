const e=`-- Повторная публикация конфига не перезаписывает разделы, которые владелец изменил в кабинете\r
-- (tenants.owner_managed): контакты, карточки, логотип, главное фото, работы, услуги, боксы,\r
-- часы и выходные. Остальное (название, тексты, тема, правила записи) по-прежнему из business.json.\r
\r
create or replace function public.publish_tenant_config(p_config jsonb) returns jsonb\r
language plpgsql security definer set search_path = '' as $$\r
declare\r
  v_slug text := lower(p_config ->> 'slug');\r
  v_hash text := md5(p_config::text);\r
  t public.tenants;\r
  v_created boolean := false;\r
  v_changed boolean;\r
  r jsonb;\r
  s jsonb;\r
  v_service_id uuid;\r
  v_price public.service_prices;\r
begin\r
  if v_slug is null or v_slug !~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$' then\r
    return private.err('invalid_slug');\r
  end if;\r
\r
  select * into t from public.tenants where slug = v_slug for update;\r
  if not found then\r
    insert into public.tenants (slug, name, timezone) values (v_slug, p_config ->> 'name', p_config ->> 'timezone')\r
    returning * into t;\r
    v_created := true;\r
  end if;\r
  v_changed := t.config_hash is distinct from v_hash;\r
\r
  update public.tenants set\r
    name = p_config ->> 'name',\r
    timezone = p_config ->> 'timezone',\r
    currency = coalesce(p_config ->> 'currency', 'RUB'),\r
    slot_step_minutes = coalesce((p_config -> 'booking' ->> 'slot_step_minutes')::int, 30),\r
    min_notice_minutes = coalesce((p_config -> 'booking' ->> 'min_notice_minutes')::int, 60),\r
    horizon_days = coalesce((p_config -> 'booking' ->> 'horizon_days')::int, 30),\r
    change_cutoff_minutes = coalesce((p_config -> 'booking' ->> 'change_cutoff_minutes')::int, 120),\r
    public_config = coalesce(p_config -> 'public', '{}'::jsonb)\r
      || case when 'contacts' = any (owner_managed) then jsonb_build_object('contacts', public_config -> 'contacts') else '{}'::jsonb end\r
      || case when 'cards' = any (owner_managed) then jsonb_build_object('cards', public_config -> 'cards') else '{}'::jsonb end\r
      || case when 'logo' = any (owner_managed) and public_config -> 'brand' is not null\r
              then jsonb_build_object('brand', coalesce(p_config -> 'public' -> 'brand', '{}'::jsonb) || jsonb_build_object('icon', public_config -> 'brand' -> 'icon'))\r
              else '{}'::jsonb end,\r
    config_hash = v_hash,\r
    config_version = case when v_changed then config_version + 1 else config_version end\r
  where id = t.id\r
  returning * into t;\r
\r
  -- Посты: upsert по ключу; убранные из конфига выключаются, чтобы не терять историю.\r
  if not ('resources' = any (t.owner_managed)) then\r
  for r in select * from jsonb_array_elements(coalesce(p_config -> 'resources', '[]'::jsonb)) loop\r
    insert into public.resources (tenant_id, key, name, sort, is_active)\r
    values (t.id, r ->> 'key', r ->> 'name', coalesce((r ->> 'sort')::int, 0), true)\r
    on conflict (tenant_id, key) do update set name = excluded.name, sort = excluded.sort, is_active = true;\r
  end loop;\r
  update public.resources set is_active = false\r
   where tenant_id = t.id\r
     and key not in (select x ->> 'key' from jsonb_array_elements(coalesce(p_config -> 'resources', '[]'::jsonb)) x);\r
  end if;\r
\r
  -- Услуги, цены (новая строка только при изменении) и подходящие посты.\r
  if not ('services' = any (t.owner_managed)) then\r
  for s in select * from jsonb_array_elements(coalesce(p_config -> 'services', '[]'::jsonb)) loop\r
    insert into public.services (tenant_id, key, name, description, category, duration_minutes, buffer_minutes, image, sort, is_active)\r
    values (t.id, s ->> 'key', s ->> 'name', coalesce(s ->> 'description', ''), coalesce(s ->> 'category', ''),\r
            (s ->> 'duration_minutes')::int, coalesce((s ->> 'buffer_minutes')::int, 0),\r
            coalesce(s ->> 'image', ''), coalesce((s ->> 'sort')::int, 0), true)\r
    on conflict (tenant_id, key) do update set\r
      name = excluded.name, description = excluded.description, category = excluded.category,\r
      duration_minutes = excluded.duration_minutes, buffer_minutes = excluded.buffer_minutes,\r
      image = excluded.image, sort = excluded.sort, is_active = true\r
    returning id into v_service_id;\r
\r
    select * into v_price from public.service_prices\r
     where service_id = v_service_id and valid_from <= now() order by valid_from desc limit 1;\r
    if not found or v_price.price_minor <> (s ->> 'price_minor')::bigint\r
       or v_price.price_is_from <> coalesce((s ->> 'price_is_from')::boolean, false) then\r
      insert into public.service_prices (tenant_id, service_id, price_minor, price_is_from, valid_from)\r
      values (t.id, v_service_id, (s ->> 'price_minor')::bigint, coalesce((s ->> 'price_is_from')::boolean, false), clock_timestamp());\r
    end if;\r
\r
    delete from public.service_resources where service_id = v_service_id;\r
    insert into public.service_resources (tenant_id, service_id, resource_id)\r
    select t.id, v_service_id, res.id\r
      from jsonb_array_elements_text(coalesce(s -> 'resources', '[]'::jsonb)) k\r
      join public.resources res on res.tenant_id = t.id and res.key = k;\r
  end loop;\r
  update public.services set is_active = false\r
   where tenant_id = t.id\r
     and key not in (select x ->> 'key' from jsonb_array_elements(coalesce(p_config -> 'services', '[]'::jsonb)) x);\r
  end if;\r
\r
  if not ('hours' = any (t.owner_managed)) then\r
  delete from public.working_hours where tenant_id = t.id;\r
  insert into public.working_hours (tenant_id, weekday, opens, closes)\r
  select t.id, (h ->> 'weekday')::smallint, (h ->> 'opens')::time, (h ->> 'closes')::time\r
    from jsonb_array_elements(coalesce(p_config -> 'hours', '[]'::jsonb)) h;\r
  end if;\r
\r
  if not ('exceptions' = any (t.owner_managed)) then\r
  delete from public.schedule_exceptions where tenant_id = t.id;\r
  insert into public.schedule_exceptions (tenant_id, day, is_closed, opens, closes, note)\r
  select t.id, (e ->> 'day')::date, coalesce((e ->> 'closed')::boolean, true),\r
         (e ->> 'opens')::time, (e ->> 'closes')::time, coalesce(e ->> 'note', '')\r
    from jsonb_array_elements(coalesce(p_config -> 'exceptions', '[]'::jsonb)) e;\r
  end if;\r
\r
  -- Фото из конфига заменяются, фото владельца (source = owner) остаются.\r
  delete from public.tenant_media\r
   where tenant_id = t.id and source = 'config' and not (kind = any (t.owner_managed));\r
  insert into public.tenant_media (tenant_id, kind, service_key, url, alt, source, sort)\r
  select t.id, m ->> 'kind', m ->> 'service_key', m ->> 'url', coalesce(m ->> 'alt', ''), 'config', ord::int\r
    from jsonb_array_elements(coalesce(p_config -> 'media', '[]'::jsonb)) with ordinality as x(m, ord)\r
   where not ((m ->> 'kind') = any (t.owner_managed));\r
\r
  if v_changed then\r
    insert into public.tenant_publications (tenant_id, version, config_hash, config)\r
    values (t.id, t.config_version, v_hash, p_config);\r
  end if;\r
\r
  return jsonb_build_object('ok', true, 'tenant_id', t.id, 'slug', t.slug, 'status', t.status,\r
                            'version', t.config_version, 'created', v_created, 'changed', v_changed);\r
end $$;\r
\r
\r
-- Свободное время: теперь отдаются и занятые моменты (free = 0), чтобы интерфейс явно показывал «занято».\r
-- Дни без единого момента приёма (выходные) по-прежнему не возвращаются.\r
create or replace function public.get_availability(p_slug text, p_service_id uuid, p_from date, p_to date)\r
returns jsonb\r
language plpgsql security definer set search_path = '' as $$\r
declare\r
  t public.tenants;\r
  s public.services;\r
  v_len interval;\r
  v_days jsonb;\r
begin\r
  if not private.hit_rate_limit('avail:' || private.client_ip(), 240, 60) then\r
    return private.err('rate_limited');\r
  end if;\r
  begin\r
    t := private.public_tenant(p_slug);\r
    select * into s from public.services where tenant_id = t.id and id = p_service_id and is_active;\r
    if not found then perform private.fail('service_not_found'); end if;\r
    if p_to < p_from or p_to - p_from > 31 then perform private.fail('invalid_range'); end if;\r
  exception when sqlstate 'P0001' then\r
    return private.err(sqlerrm);\r
  end;\r
  v_len := make_interval(mins => s.duration_minutes + s.buffer_minutes);\r
\r
  select coalesce(jsonb_agg(day_json order by day), '[]'::jsonb) into v_days\r
  from (\r
    select c.local_day as day,\r
           jsonb_build_object('date', c.local_day, 'slots', jsonb_agg(\r
             jsonb_build_object('starts_at', c.starts_at, 'time', to_char(c.local_time, 'HH24:MI'), 'free', c.free)\r
             order by c.starts_at)) as day_json\r
      from (\r
        select st.starts_at, st.local_day, st.local_time,\r
               (select count(*) from public.service_resources sr\r
                  join public.resources r on r.id = sr.resource_id and r.tenant_id = sr.tenant_id and r.is_active\r
                 where sr.service_id = s.id\r
                   and not exists (\r
                     select 1 from public.resource_occupancies o\r
                      where o.tenant_id = t.id and o.resource_id = sr.resource_id and o.released_at is null\r
                        and o.period && tstzrange(st.starts_at, st.starts_at + v_len, '[)'))) as free\r
          from private.slot_starts(t.id, p_from, p_to) st\r
      ) c\r
     group by c.local_day\r
  ) d;\r
\r
  return jsonb_build_object('ok', true, 'timezone', t.timezone, 'days', v_days);\r
end $$;\r
\r
\r
grant execute on function public.publish_tenant_config(jsonb) to service_role;\r
grant execute on function public.get_availability(text, uuid, date, date) to anon, authenticated;\r
`;export{e as default};
