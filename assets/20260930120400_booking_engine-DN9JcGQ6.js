const e=`-- Движок записи. Клиент не передаёт цену, студию или длительность: всё берётся на сервере.\r
-- Услуга занимает конкретный подходящий пост на непрерывный диапазон\r
-- [начало, начало + длительность + буфер), даже если он длится несколько дней.\r
\r
-- Сетка моментов приёма по рабочим часам и исключениям, в часовом поясе студии.\r
create or replace function private.slot_starts(p_tenant_id uuid, p_from date, p_to date)\r
returns table (starts_at timestamptz, local_day date, local_time time)\r
language plpgsql stable security definer set search_path = '' as $$\r
declare\r
  t public.tenants;\r
begin\r
  select * into t from public.tenants where id = p_tenant_id;\r
  return query\r
  with days as (\r
    select d::date as day from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') d\r
  ),\r
  intervals as (\r
    select days.day, e.opens, e.closes\r
      from days join public.schedule_exceptions e on e.tenant_id = t.id and e.day = days.day\r
     where not e.is_closed\r
    union all\r
    select days.day, w.opens, w.closes\r
      from days join public.working_hours w on w.tenant_id = t.id and w.weekday = extract(isodow from days.day)\r
     where not exists (select 1 from public.schedule_exceptions e where e.tenant_id = t.id and e.day = days.day)\r
  ),\r
  grid as (\r
    select i.day, (i.day + i.opens) + make_interval(mins => n * t.slot_step_minutes) as local_ts\r
      from intervals i,\r
           generate_series(0, ((extract(epoch from (i.closes - i.opens)) / 60)::int - 1) / t.slot_step_minutes) n\r
  )\r
  select (g.local_ts at time zone t.timezone), g.day, g.local_ts::time\r
    from grid g\r
   where (g.local_ts at time zone t.timezone) >= now() + make_interval(mins => t.min_notice_minutes)\r
     and (g.local_ts at time zone t.timezone) < now() + make_interval(days => t.horizon_days)\r
   order by 1;\r
end $$;\r
\r
-- Занять подходящий свободный пост. Возвращает id поста или null.\r
-- Конкурентные транзакции разводит EXCLUDE: вторая ждёт первую и получает 23P01.\r
create or replace function private.occupy(\r
  p_tenant_id uuid, p_service_id uuid, p_start timestamptz, p_booking_id uuid,\r
  p_is_demo boolean, p_preferred uuid default null, p_only uuid default null\r
) returns uuid\r
language plpgsql security definer set search_path = '' as $$\r
declare\r
  s public.services;\r
  r record;\r
  v_period tstzrange;\r
begin\r
  select * into s from public.services where tenant_id = p_tenant_id and id = p_service_id;\r
  v_period := tstzrange(p_start, p_start + make_interval(mins => s.duration_minutes + s.buffer_minutes), '[)');\r
  for r in\r
    select res.id\r
      from public.service_resources sr\r
      join public.resources res on res.tenant_id = sr.tenant_id and res.id = sr.resource_id\r
     where sr.tenant_id = p_tenant_id and sr.service_id = p_service_id and res.is_active\r
       and (p_only is null or res.id = p_only)\r
     order by (res.id = p_preferred) desc nulls last, res.sort, res.key\r
  loop\r
    begin\r
      insert into public.resource_occupancies (tenant_id, resource_id, period, kind, booking_id, is_demo)\r
      values (p_tenant_id, r.id, v_period, 'booking', p_booking_id, p_is_demo);\r
      return r.id;\r
    exception when exclusion_violation then\r
      null; -- пост занят, пробуем следующий\r
    end;\r
  end loop;\r
  return null;\r
end $$;\r
\r
create or replace function private.assert_client_start(p_tenant_id uuid, p_start timestamptz) returns void\r
language plpgsql stable security definer set search_path = '' as $$\r
declare\r
  v_day date;\r
begin\r
  select (p_start at time zone t.timezone)::date into v_day from public.tenants t where t.id = p_tenant_id;\r
  if not exists (select 1 from private.slot_starts(p_tenant_id, v_day, v_day) s where s.starts_at = p_start) then\r
    perform private.fail('slot_not_offered');\r
  end if;\r
end $$;\r
\r
-- Представление записи для клиента (без внутренних полей).\r
create or replace function private.booking_view(p_booking_id uuid) returns jsonb\r
language sql stable security definer set search_path = '' as $$\r
  select jsonb_build_object(\r
    'id', b.id, 'code', b.code, 'status', b.status,\r
    'service', jsonb_build_object('id', s.id, 'name', s.name, 'duration_minutes', b.duration_minutes),\r
    'resource_name', r.name,\r
    'starts_at', b.starts_at, 'ends_at', b.ends_at,\r
    'price_minor', b.price_minor, 'price_is_from', b.price_is_from, 'currency', b.currency,\r
    'customer_name', b.customer_name, 'car', b.car, 'comment', b.comment,\r
    'can_change', b.status in ('new', 'confirmed') and now() < b.starts_at - make_interval(mins => t.change_cutoff_minutes),\r
    'change_deadline', b.starts_at - make_interval(mins => t.change_cutoff_minutes),\r
    'tenant', jsonb_build_object('slug', t.slug, 'name', t.name, 'timezone', t.timezone, 'status', t.status,\r
                                 'address', t.public_config -> 'contacts' ->> 'address'),\r
    'is_demo', b.is_demo)\r
  from public.bookings b\r
  join public.services s on s.id = b.service_id\r
  join public.resources r on r.id = b.resource_id\r
  join public.tenants t on t.id = b.tenant_id\r
  where b.id = p_booking_id\r
$$;\r
\r
-- Ядро создания записи. Общая для клиента и владельца.\r
create or replace function private.create_booking_core(\r
  p_tenant_id uuid, p_service_id uuid, p_start timestamptz,\r
  p_name text, p_phone text, p_car text, p_comment text,\r
  p_source text, p_access_key uuid, p_resource_id uuid default null, p_is_demo boolean default false\r
) returns uuid\r
language plpgsql security definer set search_path = '' as $$\r
declare\r
  t public.tenants;\r
  s public.services;\r
  pr public.service_prices;\r
  v_phone text := private.normalize_phone(p_phone);\r
  v_name text := btrim(coalesce(p_name, ''));\r
  v_id uuid := gen_random_uuid();\r
  v_resource uuid;\r
  v_code text;\r
  v_demo boolean;\r
begin\r
  select * into t from public.tenants where id = p_tenant_id;\r
  -- в режиме preview любая запись считается демонстрационной и удаляется при активации\r
  v_demo := p_is_demo or t.status <> 'live';\r
  select * into s from public.services where tenant_id = p_tenant_id and id = p_service_id and is_active;\r
  if not found then perform private.fail('service_not_found'); end if;\r
  select * into pr from public.service_prices\r
   where tenant_id = p_tenant_id and service_id = s.id and valid_from <= now()\r
   order by valid_from desc limit 1;\r
  if not found then perform private.fail('service_not_priced'); end if;\r
  if length(v_name) not between 1 and 80 then perform private.fail('invalid_name'); end if;\r
  if v_phone is null then perform private.fail('invalid_phone'); end if;\r
  if length(coalesce(p_car, '')) > 120 or length(coalesce(p_comment, '')) > 1000 then perform private.fail('too_long'); end if;\r
  if p_start < now() - interval '1 minute' and p_source <> 'demo' then perform private.fail('start_in_past'); end if;\r
\r
  v_resource := private.occupy(t.id, s.id, p_start, v_id, v_demo, null, p_resource_id);\r
  if v_resource is null then perform private.fail('slot_unavailable'); end if;\r
\r
  loop\r
    v_code := private.new_booking_code();\r
    exit when not exists (select 1 from public.bookings where tenant_id = t.id and code = v_code);\r
  end loop;\r
\r
  insert into public.bookings (\r
    id, tenant_id, code, service_id, resource_id, service_price_id, starts_at, ends_at, occupied_until,\r
    duration_minutes, buffer_minutes, price_minor, price_is_from, currency,\r
    customer_name, customer_phone, car, comment, source, is_demo)\r
  values (\r
    v_id, t.id, v_code, s.id, v_resource, pr.id, p_start,\r
    p_start + make_interval(mins => s.duration_minutes),\r
    p_start + make_interval(mins => s.duration_minutes + s.buffer_minutes),\r
    s.duration_minutes, s.buffer_minutes, pr.price_minor, pr.price_is_from, t.currency,\r
    v_name, v_phone, btrim(coalesce(p_car, '')), btrim(coalesce(p_comment, '')), p_source, v_demo);\r
\r
  insert into public.booking_access_tokens (tenant_id, booking_id, token_hash)\r
  values (t.id, v_id, private.hash_token(private.token_for(t.id, p_access_key)));\r
\r
  perform private.enqueue_booking_notifications(v_id, 'created', case when p_source = 'owner' then 'owner' else 'client' end);\r
  return v_id;\r
end $$;\r
\r
-- Перенос: старая занятость снимается и новая ставится в одной транзакции.\r
-- Если нового места нет, ошибка откатывает всё, и исходная бронь остаётся на месте.\r
create or replace function private.reschedule_core(\r
  p_booking_id uuid, p_new_start timestamptz, p_by text, p_resource_id uuid default null\r
) returns void\r
language plpgsql security definer set search_path = '' as $$\r
declare\r
  b public.bookings;\r
  v_resource uuid;\r
begin\r
  select * into b from public.bookings where id = p_booking_id for update;\r
  if b.status not in ('new', 'confirmed') then perform private.fail('booking_not_active'); end if;\r
  if b.starts_at = p_new_start and (p_resource_id is null or p_resource_id = b.resource_id) then\r
    return; -- ничего не меняется\r
  end if;\r
\r
  update public.resource_occupancies set released_at = now()\r
   where booking_id = b.id and released_at is null;\r
\r
  v_resource := private.occupy(b.tenant_id, b.service_id, p_new_start, b.id, b.is_demo,\r
                               b.resource_id, p_resource_id);\r
  if v_resource is null then perform private.fail('slot_unavailable'); end if;\r
\r
  update public.bookings\r
     set starts_at = p_new_start,\r
         ends_at = p_new_start + make_interval(mins => b.duration_minutes),\r
         occupied_until = p_new_start + make_interval(mins => b.duration_minutes + b.buffer_minutes),\r
         resource_id = v_resource,\r
         version = b.version + 1\r
   where id = b.id;\r
\r
  perform private.enqueue_booking_notifications(b.id, 'rescheduled', p_by);\r
end $$;\r
\r
create or replace function private.cancel_core(p_booking_id uuid, p_reason text, p_by text) returns void\r
language plpgsql security definer set search_path = '' as $$\r
declare\r
  b public.bookings;\r
begin\r
  select * into b from public.bookings where id = p_booking_id for update;\r
  if b.status = 'cancelled' then return; end if; -- повторная отмена ничего не делает\r
  if b.status not in ('new', 'confirmed') then perform private.fail('booking_not_active'); end if;\r
  update public.resource_occupancies set released_at = now() where booking_id = b.id and released_at is null;\r
  update public.bookings\r
     set status = 'cancelled', cancelled_at = now(), cancel_reason = left(coalesce(p_reason, ''), 300),\r
         version = b.version + 1\r
   where id = b.id;\r
  perform private.enqueue_booking_notifications(b.id, 'cancelled', p_by);\r
end $$;\r
\r
create or replace function private.booking_by_token(p_token text, p_lock boolean default false) returns public.bookings\r
language plpgsql security definer set search_path = '' as $$\r
declare\r
  b public.bookings;\r
begin\r
  select bk.* into b\r
    from public.booking_access_tokens a\r
    join public.bookings bk on bk.id = a.booking_id and bk.tenant_id = a.tenant_id\r
   where a.token_hash = private.hash_token(p_token) and a.revoked_at is null;\r
  if not found then perform private.fail('booking_not_found'); end if;\r
  return b;\r
end $$;\r
\r
-- ===================== Публичные функции (anon) =====================\r
\r
create or replace function public.get_public_tenant(p_slug text) returns jsonb\r
language plpgsql stable security definer set search_path = '' as $$\r
declare\r
  t public.tenants;\r
begin\r
  begin\r
    t := private.public_tenant(p_slug);\r
  exception when sqlstate 'P0001' then\r
    return private.err(sqlerrm);\r
  end;\r
  return jsonb_build_object(\r
    'ok', true,\r
    'tenant', jsonb_build_object(\r
      'id', t.id, 'slug', t.slug, 'name', t.name, 'status', t.status, 'timezone', t.timezone,\r
      'currency', t.currency, 'config', t.public_config, 'config_version', t.config_version,\r
      'change_cutoff_minutes', t.change_cutoff_minutes, 'horizon_days', t.horizon_days),\r
    'services', coalesce((\r
      select jsonb_agg(jsonb_build_object(\r
               'id', s.id, 'key', s.key, 'name', s.name, 'description', s.description, 'category', s.category,\r
               'duration_minutes', s.duration_minutes, 'image', s.image,\r
               'price_minor', p.price_minor, 'price_is_from', p.price_is_from) order by s.sort, s.name)\r
        from public.services s\r
        join lateral (select sp.price_minor, sp.price_is_from from public.service_prices sp\r
                       where sp.service_id = s.id and sp.valid_from <= now()\r
                       order by sp.valid_from desc limit 1) p on true\r
       where s.tenant_id = t.id and s.is_active\r
         and exists (select 1 from public.service_resources sr\r
                       join public.resources r on r.id = sr.resource_id and r.is_active\r
                      where sr.service_id = s.id)), '[]'::jsonb),\r
    'hours', coalesce((\r
      select jsonb_agg(jsonb_build_object('weekday', w.weekday, 'opens', to_char(w.opens, 'HH24:MI'),\r
                                          'closes', to_char(w.closes, 'HH24:MI')) order by w.weekday, w.opens)\r
        from public.working_hours w where w.tenant_id = t.id), '[]'::jsonb),\r
    'media', coalesce((\r
      select jsonb_agg(jsonb_build_object('kind', m.kind, 'url', m.url, 'alt', m.alt, 'service_key', m.service_key)\r
                       order by m.kind, m.source desc, m.sort)\r
        from public.tenant_media m where m.tenant_id = t.id), '[]'::jsonb));\r
end $$;\r
\r
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
     where c.free > 0\r
     group by c.local_day\r
  ) d;\r
\r
  return jsonb_build_object('ok', true, 'timezone', t.timezone, 'days', v_days);\r
end $$;\r
\r
create or replace function public.create_booking(\r
  p_slug text, p_service_id uuid, p_starts_at timestamptz,\r
  p_customer_name text, p_customer_phone text, p_car text, p_comment text,\r
  p_consent boolean, p_idempotency_key uuid\r
) returns jsonb\r
language plpgsql security definer set search_path = '' as $$\r
declare\r
  t public.tenants;\r
  v_req text;\r
  v_existing public.idempotency_keys;\r
  v_booking uuid;\r
begin\r
  if not private.hit_rate_limit('create:' || private.client_ip(), 20, 3600) then\r
    return private.err('rate_limited');\r
  end if;\r
  begin\r
    t := private.public_tenant(p_slug);\r
    if p_idempotency_key is null then perform private.fail('idempotency_key_required'); end if;\r
    if not coalesce(p_consent, false) then perform private.fail('consent_required'); end if;\r
\r
    v_req := md5(jsonb_build_array(p_service_id, p_starts_at, btrim(coalesce(p_customer_name, '')),\r
                                   private.normalize_phone(p_customer_phone),\r
                                   btrim(coalesce(p_car, '')), btrim(coalesce(p_comment, '')))::text);\r
\r
    insert into public.idempotency_keys (tenant_id, action, key, request_hash)\r
    values (t.id, 'create', p_idempotency_key, v_req)\r
    on conflict do nothing;\r
    if not found then\r
      -- повтор того же запроса: возвращаем ту же запись и тот же токен\r
      select * into v_existing from public.idempotency_keys\r
       where tenant_id = t.id and action = 'create' and key = p_idempotency_key;\r
      if v_existing.request_hash <> v_req then perform private.fail('idempotency_conflict'); end if;\r
      return jsonb_build_object('ok', true, 'replayed', true,\r
        'booking', private.booking_view(v_existing.booking_id),\r
        'access_token', private.token_for(t.id, p_idempotency_key));\r
    end if;\r
\r
    if not private.hit_rate_limit('create:phone:' || t.id || ':' || coalesce(private.normalize_phone(p_customer_phone), '-'), 6, 86400) then\r
      perform private.fail('rate_limited');\r
    end if;\r
    perform private.assert_client_start(t.id, p_starts_at);\r
    v_booking := private.create_booking_core(t.id, p_service_id, p_starts_at, p_customer_name, p_customer_phone,\r
                                             p_car, p_comment, 'client', p_idempotency_key, null, false);\r
    update public.idempotency_keys set booking_id = v_booking\r
     where tenant_id = t.id and action = 'create' and key = p_idempotency_key;\r
  exception when sqlstate 'P0001' then\r
    return private.err(sqlerrm);\r
  end;\r
  return jsonb_build_object('ok', true, 'replayed', false,\r
    'booking', private.booking_view(v_booking),\r
    'access_token', private.token_for(t.id, p_idempotency_key));\r
end $$;\r
\r
create or replace function public.get_booking_by_token(p_token text) returns jsonb\r
language plpgsql security definer set search_path = '' as $$\r
declare\r
  b public.bookings;\r
begin\r
  if not private.hit_rate_limit('token:' || private.client_ip(), 120, 60) then\r
    return private.err('rate_limited');\r
  end if;\r
  begin\r
    b := private.booking_by_token(p_token);\r
  exception when sqlstate 'P0001' then\r
    return private.err(sqlerrm);\r
  end;\r
  return jsonb_build_object('ok', true, 'booking', private.booking_view(b.id));\r
end $$;\r
\r
create or replace function public.reschedule_booking(p_token text, p_new_starts_at timestamptz, p_idempotency_key uuid)\r
returns jsonb\r
language plpgsql security definer set search_path = '' as $$\r
declare\r
  b public.bookings;\r
  t public.tenants;\r
  v_req text;\r
  v_existing public.idempotency_keys;\r
begin\r
  if not private.hit_rate_limit('change:' || private.client_ip(), 30, 3600) then\r
    return private.err('rate_limited');\r
  end if;\r
  begin\r
    b := private.booking_by_token(p_token);\r
    select * into t from public.tenants where id = b.tenant_id;\r
    if p_idempotency_key is null then perform private.fail('idempotency_key_required'); end if;\r
    v_req := md5(jsonb_build_array(b.id, p_new_starts_at)::text);\r
    insert into public.idempotency_keys (tenant_id, action, key, request_hash, booking_id)\r
    values (t.id, 'reschedule', p_idempotency_key, v_req, b.id)\r
    on conflict do nothing;\r
    if not found then\r
      select * into v_existing from public.idempotency_keys\r
       where tenant_id = t.id and action = 'reschedule' and key = p_idempotency_key;\r
      if v_existing.request_hash <> v_req then perform private.fail('idempotency_conflict'); end if;\r
      return jsonb_build_object('ok', true, 'replayed', true, 'booking', private.booking_view(b.id));\r
    end if;\r
    if now() >= b.starts_at - make_interval(mins => t.change_cutoff_minutes) then\r
      perform private.fail('change_window_closed');\r
    end if;\r
    perform private.assert_client_start(t.id, p_new_starts_at);\r
    perform private.reschedule_core(b.id, p_new_starts_at, 'client');\r
  exception when sqlstate 'P0001' then\r
    return private.err(sqlerrm);\r
  end;\r
  return jsonb_build_object('ok', true, 'replayed', false, 'booking', private.booking_view(b.id));\r
end $$;\r
\r
create or replace function public.cancel_booking(p_token text, p_reason text default null) returns jsonb\r
language plpgsql security definer set search_path = '' as $$\r
declare\r
  b public.bookings;\r
  t public.tenants;\r
begin\r
  if not private.hit_rate_limit('change:' || private.client_ip(), 30, 3600) then\r
    return private.err('rate_limited');\r
  end if;\r
  begin\r
    b := private.booking_by_token(p_token);\r
    select * into t from public.tenants where id = b.tenant_id;\r
    if b.status <> 'cancelled' and now() >= b.starts_at - make_interval(mins => t.change_cutoff_minutes) then\r
      perform private.fail('change_window_closed');\r
    end if;\r
    perform private.cancel_core(b.id, p_reason, 'client');\r
  exception when sqlstate 'P0001' then\r
    return private.err(sqlerrm);\r
  end;\r
  return jsonb_build_object('ok', true, 'booking', private.booking_view(b.id));\r
end $$;\r
\r
create or replace function public.register_client_push(p_token text, p_endpoint text, p_p256dh text, p_auth text)\r
returns jsonb\r
language plpgsql security definer set search_path = '' as $$\r
declare\r
  b public.bookings;\r
begin\r
  if not private.hit_rate_limit('push:' || private.client_ip(), 30, 3600) then\r
    return private.err('rate_limited');\r
  end if;\r
  begin\r
    b := private.booking_by_token(p_token);\r
    if coalesce(p_endpoint, '') !~ '^https://' or length(p_endpoint) > 1000\r
       or length(coalesce(p_p256dh, '')) not between 20 and 200 or length(coalesce(p_auth, '')) not between 8 and 100 then\r
      perform private.fail('invalid_subscription');\r
    end if;\r
    insert into public.push_subscriptions (tenant_id, audience, booking_id, endpoint, p256dh, auth_secret)\r
    values (b.tenant_id, 'client', b.id, p_endpoint, p_p256dh, p_auth)\r
    on conflict (tenant_id, audience, endpoint, booking_id)\r
    do update set p256dh = excluded.p256dh, auth_secret = excluded.auth_secret, disabled_at = null, fail_count = 0;\r
  exception when sqlstate 'P0001' then\r
    return private.err(sqlerrm);\r
  end;\r
  return jsonb_build_object('ok', true);\r
end $$;\r
`;export{e as default};
