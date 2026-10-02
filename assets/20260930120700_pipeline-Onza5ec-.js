const e=`-- Конвейер студий. Вызывается скриптами tenant:* с service-role ключом.
-- business.json — вход конвейера, БД — источник во время работы.
-- Публикация обновляет студию по ключам и никогда не удаляет записи, оплаты и фото владельца.

create or replace function public.publish_tenant_config(p_config jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_slug text := lower(p_config ->> 'slug');
  v_hash text := md5(p_config::text);
  t public.tenants;
  v_created boolean := false;
  v_changed boolean;
  r jsonb;
  s jsonb;
  v_service_id uuid;
  v_price public.service_prices;
begin
  if v_slug is null or v_slug !~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$' then
    return private.err('invalid_slug');
  end if;

  select * into t from public.tenants where slug = v_slug for update;
  if not found then
    insert into public.tenants (slug, name, timezone) values (v_slug, p_config ->> 'name', p_config ->> 'timezone')
    returning * into t;
    v_created := true;
  end if;
  v_changed := t.config_hash is distinct from v_hash;

  update public.tenants set
    name = p_config ->> 'name',
    timezone = p_config ->> 'timezone',
    currency = coalesce(p_config ->> 'currency', 'RUB'),
    slot_step_minutes = coalesce((p_config -> 'booking' ->> 'slot_step_minutes')::int, 30),
    min_notice_minutes = coalesce((p_config -> 'booking' ->> 'min_notice_minutes')::int, 60),
    horizon_days = coalesce((p_config -> 'booking' ->> 'horizon_days')::int, 30),
    change_cutoff_minutes = coalesce((p_config -> 'booking' ->> 'change_cutoff_minutes')::int, 120),
    public_config = coalesce(p_config -> 'public', '{}'::jsonb),
    config_hash = v_hash,
    config_version = case when v_changed then config_version + 1 else config_version end
  where id = t.id
  returning * into t;

  -- Посты: upsert по ключу; убранные из конфига выключаются, чтобы не терять историю.
  for r in select * from jsonb_array_elements(coalesce(p_config -> 'resources', '[]'::jsonb)) loop
    insert into public.resources (tenant_id, key, name, sort, is_active)
    values (t.id, r ->> 'key', r ->> 'name', coalesce((r ->> 'sort')::int, 0), true)
    on conflict (tenant_id, key) do update set name = excluded.name, sort = excluded.sort, is_active = true;
  end loop;
  update public.resources set is_active = false
   where tenant_id = t.id
     and key not in (select x ->> 'key' from jsonb_array_elements(coalesce(p_config -> 'resources', '[]'::jsonb)) x);

  -- Услуги, цены (новая строка только при изменении) и подходящие посты.
  for s in select * from jsonb_array_elements(coalesce(p_config -> 'services', '[]'::jsonb)) loop
    insert into public.services (tenant_id, key, name, description, category, duration_minutes, buffer_minutes, image, sort, is_active)
    values (t.id, s ->> 'key', s ->> 'name', coalesce(s ->> 'description', ''), coalesce(s ->> 'category', ''),
            (s ->> 'duration_minutes')::int, coalesce((s ->> 'buffer_minutes')::int, 0),
            coalesce(s ->> 'image', ''), coalesce((s ->> 'sort')::int, 0), true)
    on conflict (tenant_id, key) do update set
      name = excluded.name, description = excluded.description, category = excluded.category,
      duration_minutes = excluded.duration_minutes, buffer_minutes = excluded.buffer_minutes,
      image = excluded.image, sort = excluded.sort, is_active = true
    returning id into v_service_id;

    select * into v_price from public.service_prices
     where service_id = v_service_id and valid_from <= now() order by valid_from desc limit 1;
    if not found or v_price.price_minor <> (s ->> 'price_minor')::bigint
       or v_price.price_is_from <> coalesce((s ->> 'price_is_from')::boolean, false) then
      insert into public.service_prices (tenant_id, service_id, price_minor, price_is_from, valid_from)
      values (t.id, v_service_id, (s ->> 'price_minor')::bigint, coalesce((s ->> 'price_is_from')::boolean, false), clock_timestamp());
    end if;

    delete from public.service_resources where service_id = v_service_id;
    insert into public.service_resources (tenant_id, service_id, resource_id)
    select t.id, v_service_id, res.id
      from jsonb_array_elements_text(coalesce(s -> 'resources', '[]'::jsonb)) k
      join public.resources res on res.tenant_id = t.id and res.key = k;
  end loop;
  update public.services set is_active = false
   where tenant_id = t.id
     and key not in (select x ->> 'key' from jsonb_array_elements(coalesce(p_config -> 'services', '[]'::jsonb)) x);

  delete from public.working_hours where tenant_id = t.id;
  insert into public.working_hours (tenant_id, weekday, opens, closes)
  select t.id, (h ->> 'weekday')::smallint, (h ->> 'opens')::time, (h ->> 'closes')::time
    from jsonb_array_elements(coalesce(p_config -> 'hours', '[]'::jsonb)) h;

  delete from public.schedule_exceptions where tenant_id = t.id;
  insert into public.schedule_exceptions (tenant_id, day, is_closed, opens, closes, note)
  select t.id, (e ->> 'day')::date, coalesce((e ->> 'closed')::boolean, true),
         (e ->> 'opens')::time, (e ->> 'closes')::time, coalesce(e ->> 'note', '')
    from jsonb_array_elements(coalesce(p_config -> 'exceptions', '[]'::jsonb)) e;

  -- Фото из конфига заменяются, фото владельца (source = owner) остаются.
  delete from public.tenant_media where tenant_id = t.id and source = 'config';
  insert into public.tenant_media (tenant_id, kind, service_key, url, alt, source, sort)
  select t.id, m ->> 'kind', m ->> 'service_key', m ->> 'url', coalesce(m ->> 'alt', ''), 'config', ord::int
    from jsonb_array_elements(coalesce(p_config -> 'media', '[]'::jsonb)) with ordinality as x(m, ord);

  if v_changed then
    insert into public.tenant_publications (tenant_id, version, config_hash, config)
    values (t.id, t.config_version, v_hash, p_config);
  end if;

  return jsonb_build_object('ok', true, 'tenant_id', t.id, 'slug', t.slug, 'status', t.status,
                            'version', t.config_version, 'created', v_created, 'changed', v_changed);
end $$;

create or replace function public.admin_add_member(p_slug text, p_user_id uuid, p_role text default 'owner') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid;
begin
  select id into v_tenant from public.tenants where slug = p_slug;
  if not found then return private.err('tenant_not_found'); end if;
  insert into public.tenant_members (tenant_id, user_id, role) values (v_tenant, p_user_id, coalesce(p_role, 'owner'))
  on conflict (tenant_id, user_id) do update set role = excluded.role;
  return jsonb_build_object('ok', true);
end $$;

-- Проверки готовности студии. Используются активацией и tenant:verify.
create or replace function public.tenant_health(p_slug text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  t public.tenants;
  v_checks jsonb;
begin
  select * into t from public.tenants where slug = p_slug;
  if not found then return private.err('tenant_not_found'); end if;
  v_checks := jsonb_build_object(
    'has_resources', exists (select 1 from public.resources where tenant_id = t.id and is_active),
    'has_bookable_services', exists (
      select 1 from public.services s
       where s.tenant_id = t.id and s.is_active
         and exists (select 1 from public.service_prices p where p.service_id = s.id and p.valid_from <= now())
         and exists (select 1 from public.service_resources sr join public.resources r on r.id = sr.resource_id and r.is_active
                      where sr.service_id = s.id)),
    'every_service_has_resource', not exists (
      select 1 from public.services s where s.tenant_id = t.id and s.is_active
         and not exists (select 1 from public.service_resources sr join public.resources r on r.id = sr.resource_id and r.is_active
                          where sr.service_id = s.id)),
    'has_working_hours', exists (select 1 from public.working_hours where tenant_id = t.id),
    'has_contact_phone', coalesce(t.public_config -> 'contacts' ->> 'phone', '') <> '',
    'has_owner', exists (select 1 from public.tenant_members where tenant_id = t.id and role = 'owner'),
    'published', t.config_version > 0);
  return jsonb_build_object('ok', true, 'slug', t.slug, 'status', t.status, 'version', t.config_version,
    'checks', v_checks,
    'ready', not exists (select 1 from jsonb_each(v_checks) c where c.value = 'false'::jsonb),
    'counts', jsonb_build_object(
      'bookings', (select count(*) from public.bookings where tenant_id = t.id),
      'demo_bookings', (select count(*) from public.bookings where tenant_id = t.id and is_demo),
      'owner_media', (select count(*) from public.tenant_media where tenant_id = t.id and source = 'owner')));
end $$;

-- Перевод в live: только если бизнес-настройки прошли проверку. Демо-данные удаляются.
create or replace function public.activate_tenant(p_slug text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_health jsonb := public.tenant_health(p_slug);
  v_tenant uuid;
begin
  if not coalesce((v_health ->> 'ok')::boolean, false) then return v_health; end if;
  if not (v_health ->> 'ready')::boolean then
    return jsonb_build_object('ok', false, 'error', 'not_ready', 'checks', v_health -> 'checks');
  end if;
  select id into v_tenant from public.tenants where slug = p_slug for update;
  delete from public.notification_jobs where tenant_id = v_tenant and booking_id in
    (select id from public.bookings where tenant_id = v_tenant and is_demo);
  delete from public.resource_occupancies where tenant_id = v_tenant and is_demo;
  delete from public.bookings where tenant_id = v_tenant and is_demo;
  update public.tenants set status = 'live', activated_at = coalesce(activated_at, now()) where id = v_tenant;
  return jsonb_build_object('ok', true, 'slug', p_slug, 'status', 'live');
end $$;

create or replace function public.deactivate_tenant(p_slug text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  update public.tenants set status = 'preview' where slug = p_slug;
  if not found then return private.err('tenant_not_found'); end if;
  return jsonb_build_object('ok', true, 'slug', p_slug, 'status', 'preview');
end $$;

-- Демо-записи для preview: прошлые (выполненные и оплаченные) и будущие. Все помечены is_demo.
create or replace function public.seed_demo_bookings(p_slug text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t public.tenants;
  s record;
  v_day int;
  v_start timestamptz;
  v_id uuid;
  v_names text[] := array['Артём К.', 'Марина Л.', 'Ильдар Г.', 'Олег В.', 'Светлана Р.', 'Денис Т.', 'Руслан М.', 'Алина С.'];
  v_cars text[] := array['Kia Rio, белый', 'Toyota Camry, чёрный', 'BMW X5, серый', 'Hyundai Solaris', 'Lexus RX', 'VW Polo', 'Haval Jolion', 'Škoda Octavia'];
  v_count int := 0;
begin
  select * into t from public.tenants where slug = p_slug;
  if not found then return private.err('tenant_not_found'); end if;
  if t.status <> 'preview' then return private.err('only_preview'); end if;

  delete from public.notification_jobs where tenant_id = t.id and booking_id in (select id from public.bookings where tenant_id = t.id and is_demo);
  delete from public.resource_occupancies where tenant_id = t.id and is_demo;
  delete from public.bookings where tenant_id = t.id and is_demo;

  for v_day in -6..5 loop
    for s in
      select sv.id, sv.duration_minutes, row_number() over (order by sv.sort) rn
        from public.services sv where sv.tenant_id = t.id and sv.is_active and sv.duration_minutes <= 480
       order by sv.sort limit 3
    loop
      v_start := private.local_midnight((now() at time zone t.timezone)::date + v_day, t.timezone)
                 + make_interval(hours => 9 + (s.rn::int - 1) * 3);
      begin
        v_id := private.create_booking_core(t.id, s.id, v_start,
          v_names[1 + ((v_day + 6) * 3 + s.rn::int) % 8], '+7900' || lpad((1000000 + (v_day + 6) * 10 + s.rn::int)::text, 7, '0'),
          v_cars[1 + ((v_day + 6) + s.rn::int) % 8], '', 'demo', gen_random_uuid(), null, true);
      exception when sqlstate 'P0001' then
        continue;
      end;
      v_count := v_count + 1;
      if v_day < 0 then
        update public.bookings
           set status = case when (v_day + s.rn::int) % 7 = 0 then 'no_show' else 'completed' end,
               arrived_at = case when (v_day + s.rn::int) % 7 = 0 then null else v_start + interval '5 minutes' end,
               completed_at = case when (v_day + s.rn::int) % 7 = 0 then null else ends_at end
         where id = v_id;
        insert into public.payments (tenant_id, booking_id, kind, amount_minor, method, paid_at, is_demo)
        select t.id, b.id, 'payment', b.price_minor, case when s.rn % 2 = 0 then 'cash' else 'card' end, b.ends_at, true
          from public.bookings b where b.id = v_id and b.status = 'completed' and b.price_minor > 0;
      elsif v_day = 0 and s.rn = 1 then
        update public.bookings set status = 'confirmed' where id = v_id;
      end if;
    end loop;
  end loop;
  return jsonb_build_object('ok', true, 'created', v_count);
end $$;
`;export{e as default};
