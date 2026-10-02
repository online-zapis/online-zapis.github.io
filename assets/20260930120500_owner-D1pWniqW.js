const e=`-- Функции кабинета владельца. Вызывает только authenticated; студия каждый раз
-- подтверждается членством в tenant_members на сервере, а не параметром клиента.

create or replace function private.owner_booking(p_booking_id uuid) returns public.bookings
language plpgsql security definer set search_path = '' as $$
declare
  b public.bookings;
begin
  select * into b from public.bookings where id = p_booking_id;
  if not found then perform private.fail('booking_not_found'); end if;
  perform private.assert_member(b.tenant_id);
  return b;
end $$;

create or replace function private.owner_booking_row(p_booking_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', b.id, 'code', b.code, 'status', b.status, 'source', b.source, 'is_demo', b.is_demo,
    'service_id', b.service_id, 'service_name', s.name,
    'resource_id', b.resource_id, 'resource_name', r.name,
    'starts_at', b.starts_at, 'ends_at', b.ends_at, 'occupied_until', b.occupied_until,
    'price_minor', b.price_minor, 'price_is_from', b.price_is_from, 'currency', b.currency,
    'customer_name', b.customer_name, 'customer_phone', b.customer_phone,
    'car', b.car, 'comment', b.comment, 'owner_note', b.owner_note,
    'arrived_at', b.arrived_at, 'completed_at', b.completed_at, 'cancelled_at', b.cancelled_at,
    'created_at', b.created_at, 'version', b.version,
    'paid_minor', coalesce((select sum(case when p.kind = 'payment' then p.amount_minor else -p.amount_minor end)
                              from public.payments p where p.booking_id = b.id), 0),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'kind', p.kind, 'amount_minor', p.amount_minor,
                                                             'method', p.method, 'paid_at', p.paid_at) order by p.paid_at)
                            from public.payments p where p.booking_id = b.id), '[]'::jsonb))
  from public.bookings b
  join public.services s on s.id = b.service_id
  join public.resources r on r.id = b.resource_id
  where b.id = p_booking_id
$$;

create or replace function public.owner_tenants() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then return private.err('not_authenticated'); end if;
  return jsonb_build_object('ok', true, 'tenants', coalesce((
    select jsonb_agg(jsonb_build_object('id', t.id, 'slug', t.slug, 'name', t.name, 'status', t.status,
                                        'timezone', t.timezone, 'currency', t.currency, 'role', m.role) order by t.name)
      from public.tenant_members m join public.tenants t on t.id = m.tenant_id
     where m.user_id = auth.uid()), '[]'::jsonb));
end $$;

create or replace function public.owner_list_bookings(p_tenant_id uuid, p_from date, p_to date, p_status text default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  t public.tenants;
begin
  begin
    perform private.assert_member(p_tenant_id);
    if p_to < p_from or p_to - p_from > 92 then perform private.fail('invalid_range'); end if;
  exception when sqlstate 'P0001' then
    return private.err(sqlerrm);
  end;
  select * into t from public.tenants where id = p_tenant_id;
  return jsonb_build_object('ok', true, 'bookings', coalesce((
    select jsonb_agg(private.owner_booking_row(b.id) order by b.starts_at)
      from public.bookings b
     where b.tenant_id = t.id
       -- многодневная запись видна во все дни, которые она занимает
       and b.starts_at < private.local_midnight(p_to + 1, t.timezone)
       and b.occupied_until > private.local_midnight(p_from, t.timezone)
       and (p_status is null or b.status = p_status)), '[]'::jsonb));
end $$;

create or replace function public.owner_get_booking(p_booking_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  begin
    perform private.owner_booking(p_booking_id);
  exception when sqlstate 'P0001' then
    return private.err(sqlerrm);
  end;
  return jsonb_build_object('ok', true, 'booking', private.owner_booking_row(p_booking_id));
end $$;

-- Переходы статусов: new → confirmed → arrived → completed; new/confirmed → cancelled / no_show.
create or replace function public.owner_set_status(p_booking_id uuid, p_status text, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  b public.bookings;
  v_allowed boolean;
begin
  begin
    b := private.owner_booking(p_booking_id);
    if b.status = p_status then
      return jsonb_build_object('ok', true, 'booking', private.owner_booking_row(b.id)); -- идемпотентно
    end if;
    v_allowed := case b.status
      when 'new' then p_status in ('confirmed', 'arrived', 'cancelled', 'no_show')
      when 'confirmed' then p_status in ('arrived', 'cancelled', 'no_show')
      when 'arrived' then p_status in ('completed')
      else false end;
    if not v_allowed then perform private.fail('invalid_transition', b.status || ' -> ' || p_status); end if;

    if p_status = 'cancelled' then
      perform private.cancel_core(b.id, p_reason, 'owner');
    else
      update public.bookings
         set status = p_status,
             arrived_at = case when p_status = 'arrived' then now() else arrived_at end,
             completed_at = case when p_status = 'completed' then now() else completed_at end
       where id = b.id;
      if p_status = 'no_show' then
        update public.resource_occupancies set released_at = now() where booking_id = b.id and released_at is null;
      elsif p_status = 'completed' then
        -- пост освобождается с момента выдачи машины, если работа закончилась раньше
        update public.resource_occupancies
           set period = tstzrange(lower(period), greatest(lower(period) + interval '1 minute', least(upper(period), now())), '[)')
         where booking_id = b.id and released_at is null;
      end if;
    end if;
  exception when sqlstate 'P0001' then
    return private.err(sqlerrm);
  end;
  return jsonb_build_object('ok', true, 'booking', private.owner_booking_row(b.id));
end $$;

create or replace function public.owner_update_note(p_booking_id uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform private.owner_booking(p_booking_id);
    update public.bookings set owner_note = left(coalesce(p_note, ''), 1000) where id = p_booking_id;
  exception when sqlstate 'P0001' then
    return private.err(sqlerrm);
  end;
  return jsonb_build_object('ok', true, 'booking', private.owner_booking_row(p_booking_id));
end $$;

create or replace function public.owner_reschedule(p_booking_id uuid, p_new_starts_at timestamptz, p_resource_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform private.owner_booking(p_booking_id);
    perform private.reschedule_core(p_booking_id, p_new_starts_at, 'owner', p_resource_id);
  exception when sqlstate 'P0001' then
    return private.err(sqlerrm);
  end;
  return jsonb_build_object('ok', true, 'booking', private.owner_booking_row(p_booking_id));
end $$;

-- Запись по звонку. Владелец может выбрать любое время и пост, конфликты режет EXCLUDE.
create or replace function public.owner_create_booking(
  p_tenant_id uuid, p_service_id uuid, p_starts_at timestamptz, p_resource_id uuid,
  p_customer_name text, p_customer_phone text, p_car text, p_comment text, p_idempotency_key uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_req text;
  v_existing public.idempotency_keys;
  v_booking uuid;
begin
  begin
    perform private.assert_member(p_tenant_id);
    if p_idempotency_key is null then perform private.fail('idempotency_key_required'); end if;
    v_req := md5(jsonb_build_array(p_service_id, p_starts_at, p_resource_id, p_customer_phone)::text);
    insert into public.idempotency_keys (tenant_id, action, key, request_hash)
    values (p_tenant_id, 'owner_create', p_idempotency_key, v_req)
    on conflict do nothing;
    if not found then
      select * into v_existing from public.idempotency_keys
       where tenant_id = p_tenant_id and action = 'owner_create' and key = p_idempotency_key;
      if v_existing.request_hash <> v_req then perform private.fail('idempotency_conflict'); end if;
      return jsonb_build_object('ok', true, 'replayed', true, 'booking', private.owner_booking_row(v_existing.booking_id),
                                'access_token', private.token_for(p_tenant_id, p_idempotency_key));
    end if;
    v_booking := private.create_booking_core(p_tenant_id, p_service_id, p_starts_at, p_customer_name, p_customer_phone,
                                             p_car, p_comment, 'owner', p_idempotency_key, p_resource_id, false);
    update public.bookings set status = 'confirmed' where id = v_booking;
    update public.idempotency_keys set booking_id = v_booking
     where tenant_id = p_tenant_id and action = 'owner_create' and key = p_idempotency_key;
  exception when sqlstate 'P0001' then
    return private.err(sqlerrm);
  end;
  return jsonb_build_object('ok', true, 'replayed', false, 'booking', private.owner_booking_row(v_booking),
                            'access_token', private.token_for(p_tenant_id, p_idempotency_key));
end $$;

create or replace function public.owner_resources(p_tenant_id uuid, p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  begin
    perform private.assert_member(p_tenant_id);
  exception when sqlstate 'P0001' then
    return private.err(sqlerrm);
  end;
  return jsonb_build_object('ok', true, 'resources', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id, 'key', r.key, 'name', r.name, 'is_active', r.is_active,
      'occupancies', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', o.id, 'kind', o.kind, 'booking_id', o.booking_id, 'reason', o.reason,
          'starts_at', lower(o.period), 'ends_at', upper(o.period),
          'label', case when o.kind = 'booking' then (select s.name || ', ' || b.customer_name
                                                        from public.bookings b join public.services s on s.id = b.service_id
                                                       where b.id = o.booking_id)
                        else o.reason end) order by lower(o.period))
          from public.resource_occupancies o
         where o.resource_id = r.id and o.released_at is null
           and o.period && tstzrange(p_from, p_to, '[)')), '[]'::jsonb))
      order by r.sort, r.key)
      from public.resources r where r.tenant_id = p_tenant_id), '[]'::jsonb),
    'services', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'duration_minutes', s.duration_minutes,
                                          'resource_ids', (select jsonb_agg(sr.resource_id) from public.service_resources sr
                                                            where sr.service_id = s.id)) order by s.sort)
        from public.services s where s.tenant_id = p_tenant_id and s.is_active), '[]'::jsonb));
end $$;

-- Блокировка поста живёт в той же таблице занятости, что и брони.
create or replace function public.owner_block_resource(
  p_tenant_id uuid, p_resource_id uuid, p_from timestamptz, p_to timestamptz, p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  begin
    perform private.assert_member(p_tenant_id);
    if p_to <= p_from or p_to - p_from > interval '60 days' then perform private.fail('invalid_range'); end if;
    if not exists (select 1 from public.resources where tenant_id = p_tenant_id and id = p_resource_id) then
      perform private.fail('resource_not_found');
    end if;
    begin
      insert into public.resource_occupancies (tenant_id, resource_id, period, kind, reason, created_by)
      values (p_tenant_id, p_resource_id, tstzrange(p_from, p_to, '[)'), 'block', left(coalesce(p_reason, ''), 200), auth.uid())
      returning id into v_id;
    exception when exclusion_violation then
      perform private.fail('resource_busy');
    end;
  exception when sqlstate 'P0001' then
    return private.err(sqlerrm);
  end;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.owner_unblock(p_occupancy_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  o public.resource_occupancies;
begin
  begin
    select * into o from public.resource_occupancies where id = p_occupancy_id and kind = 'block';
    if not found then perform private.fail('block_not_found'); end if;
    perform private.assert_member(o.tenant_id);
    update public.resource_occupancies set released_at = now() where id = o.id and released_at is null;
  exception when sqlstate 'P0001' then
    return private.err(sqlerrm);
  end;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.owner_add_payment(
  p_booking_id uuid, p_amount_minor bigint, p_method text, p_kind text, p_note text, p_idempotency_key uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  b public.bookings;
begin
  begin
    b := private.owner_booking(p_booking_id);
    if p_idempotency_key is null then perform private.fail('idempotency_key_required'); end if;
    if p_amount_minor is null or p_amount_minor <= 0 or p_amount_minor > 100000000 then perform private.fail('invalid_amount'); end if;
    if b.status in ('cancelled') and coalesce(p_kind, 'payment') = 'payment' then perform private.fail('booking_cancelled'); end if;
    insert into public.idempotency_keys (tenant_id, action, key, request_hash, booking_id)
    values (b.tenant_id, 'payment', p_idempotency_key,
            md5(jsonb_build_array(b.id, p_amount_minor, p_method, p_kind)::text), b.id)
    on conflict do nothing;
    if found then
      insert into public.payments (tenant_id, booking_id, kind, amount_minor, method, note, created_by, is_demo)
      values (b.tenant_id, b.id, coalesce(p_kind, 'payment'), p_amount_minor, p_method, left(coalesce(p_note, ''), 300),
              auth.uid(), b.is_demo);
    end if;
  exception when sqlstate 'P0001' then
    return private.err(sqlerrm);
  end;
  return jsonb_build_object('ok', true, 'booking', private.owner_booking_row(b.id));
end $$;

create or replace function public.owner_register_push(p_tenant_id uuid, p_endpoint text, p_p256dh text, p_auth text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform private.assert_member(p_tenant_id);
    if coalesce(p_endpoint, '') !~ '^https://' or length(p_endpoint) > 1000 then perform private.fail('invalid_subscription'); end if;
    insert into public.push_subscriptions (tenant_id, audience, user_id, endpoint, p256dh, auth_secret)
    values (p_tenant_id, 'owner', auth.uid(), p_endpoint, p_p256dh, p_auth)
    on conflict (tenant_id, audience, endpoint, booking_id)
    do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth_secret = excluded.auth_secret,
                  disabled_at = null, fail_count = 0;
  exception when sqlstate 'P0001' then
    return private.err(sqlerrm);
  end;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.owner_unregister_push(p_tenant_id uuid, p_endpoint text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform private.assert_member(p_tenant_id);
    update public.push_subscriptions set disabled_at = now()
     where tenant_id = p_tenant_id and audience = 'owner' and endpoint = p_endpoint and user_id = auth.uid();
  exception when sqlstate 'P0001' then
    return private.err(sqlerrm);
  end;
  return jsonb_build_object('ok', true);
end $$;

-- Честный статус уведомлений для экрана «Ещё»: что реально ушло, что ждёт, что упало.
create or replace function public.owner_notification_status(p_tenant_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  begin
    perform private.assert_member(p_tenant_id);
  exception when sqlstate 'P0001' then
    return private.err(sqlerrm);
  end;
  return jsonb_build_object('ok', true,
    'subscriptions', (select count(*) from public.push_subscriptions
                       where tenant_id = p_tenant_id and audience = 'owner' and user_id = auth.uid() and disabled_at is null),
    'jobs', coalesce((select jsonb_object_agg(status, n) from (
       select status, count(*) n from public.notification_jobs
        where tenant_id = p_tenant_id and created_at > now() - interval '7 days' group by status) x), '{}'::jsonb));
end $$;
`;export{e as default};
