const n=`-- Outbox уведомлений. Воркер (Edge Function notify-dispatch по Supabase Cron) забирает
-- задания с арендой, отправляет Web Push и отчитывается. Повторы и дедупликация в БД.

create or replace function private.enqueue_job(
  p_booking public.bookings, p_kind text, p_audience text, p_run_at timestamptz
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_preview boolean;
begin
  select (t.status <> 'live') or p_booking.is_demo into v_preview
  from public.tenants t where t.id = p_booking.tenant_id;

  insert into public.notification_jobs (tenant_id, booking_id, kind, audience, run_at, status, dedupe_key, last_error)
  values (
    p_booking.tenant_id, p_booking.id, p_kind, p_audience, p_run_at,
    case when v_preview then 'skipped' else 'pending' end,
    p_kind || ':' || p_booking.id || ':v' || p_booking.version,
    case when v_preview then 'preview: реальные уведомления не отправляются' end)
  on conflict (tenant_id, dedupe_key) do nothing;
end $$;

-- p_event: created | rescheduled | cancelled. p_by: client | owner
create or replace function private.enqueue_booking_notifications(p_booking_id uuid, p_event text, p_by text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  b public.bookings;
begin
  select * into b from public.bookings where id = p_booking_id;

  if p_event in ('rescheduled', 'cancelled') then
    -- старые напоминания относятся к прежнему времени
    update public.notification_jobs
       set status = 'cancelled', last_error = 'booking ' || p_event, lease_until = null
     where booking_id = b.id and audience = 'client' and status in ('pending', 'processing');
  end if;

  if p_by = 'client' then
    perform private.enqueue_job(b, 'owner_' || p_event, 'owner', now());
  end if;

  if p_event in ('created', 'rescheduled') and b.status in ('new', 'confirmed') then
    if b.starts_at - interval '24 hours' > now() + interval '5 minutes' then
      perform private.enqueue_job(b, 'client_reminder_24h', 'client', b.starts_at - interval '24 hours');
    end if;
    if b.starts_at - interval '2 hours' > now() + interval '5 minutes' then
      perform private.enqueue_job(b, 'client_reminder_2h', 'client', b.starts_at - interval '2 hours');
    end if;
  end if;
end $$;

-- Захват заданий воркером. Истёкшая аренда (упавший воркер) возвращает задание в работу.
create or replace function public.claim_notification_jobs(p_worker text, p_limit int default 20, p_lease_seconds int default 60)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_out jsonb := '[]'::jsonb;
  j record;
begin
  -- напоминания по отменённым или завершённым записям не отправляем
  update public.notification_jobs n
     set status = 'cancelled', last_error = 'booking no longer active', lease_until = null
    from public.bookings b
   where b.id = n.booking_id and n.audience = 'client' and n.status = 'pending'
     and b.status not in ('new', 'confirmed');

  for j in
    with due as (
      select n.id from public.notification_jobs n
       where (n.status = 'pending' and n.run_at <= now())
          or (n.status = 'processing' and n.lease_until < now())
       order by n.run_at
       limit greatest(1, least(p_limit, 100))
       for update skip locked
    )
    update public.notification_jobs n
       set status = 'processing', attempts = n.attempts + 1, locked_by = p_worker,
           lease_until = now() + make_interval(secs => p_lease_seconds)
      from due where n.id = due.id
    returning n.*
  loop
    v_out := v_out || jsonb_build_array(private.render_job(j.id));
  end loop;
  return v_out;
end $$;

create or replace function private.render_job(p_job_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  n public.notification_jobs;
  t public.tenants;
  b public.bookings;
  s public.services;
  v_when text;
  v_title text;
  v_body text;
  v_url text;
  v_subs jsonb;
begin
  select * into n from public.notification_jobs where id = p_job_id;
  select * into t from public.tenants where id = n.tenant_id;
  select * into b from public.bookings where id = n.booking_id;
  select * into s from public.services where id = b.service_id;
  v_when := to_char(b.starts_at at time zone t.timezone, 'DD.MM в HH24:MI');

  case n.kind
    when 'owner_created' then v_title := 'Новая запись'; v_body := s.name || ', ' || v_when || '. ' || b.customer_name;
    when 'owner_rescheduled' then v_title := 'Запись перенесена'; v_body := s.name || ', теперь ' || v_when || '. ' || b.customer_name;
    when 'owner_cancelled' then v_title := 'Запись отменена'; v_body := s.name || ', ' || v_when || '. ' || b.customer_name;
    when 'client_reminder_24h' then v_title := t.name; v_body := 'Завтра ' || v_when || ': ' || s.name || '. Ждём вас!';
    when 'client_reminder_2h' then v_title := t.name; v_body := 'Через 2 часа, ' || v_when || ': ' || s.name || '.';
    else v_title := t.name; v_body := s.name || ', ' || v_when;
  end case;

  if n.audience = 'owner' then
    v_url := '/s/' || t.slug || '/owner/?booking=' || b.id;
    select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'endpoint', p.endpoint, 'p256dh', p.p256dh, 'auth', p.auth_secret)), '[]')
      into v_subs
      from public.push_subscriptions p
      join public.tenant_members m on m.tenant_id = p.tenant_id and m.user_id = p.user_id
     where p.tenant_id = n.tenant_id and p.audience = 'owner' and p.disabled_at is null;
  else
    v_url := '/s/' || t.slug || '/my';
    select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'endpoint', p.endpoint, 'p256dh', p.p256dh, 'auth', p.auth_secret)), '[]')
      into v_subs
      from public.push_subscriptions p
     where p.tenant_id = n.tenant_id and p.audience = 'client' and p.booking_id = n.booking_id and p.disabled_at is null;
  end if;

  return jsonb_build_object(
    'id', n.id, 'kind', n.kind, 'audience', n.audience, 'attempts', n.attempts,
    'title', v_title, 'body', v_body, 'url', v_url, 'tag', n.kind || ':' || n.booking_id,
    'subscriptions', v_subs);
end $$;

-- Отчёт воркера. p_outcome: sent | no_targets | failed.
-- p_gone: подписки, на которые push-сервис ответил 404/410, отключаются.
create or replace function public.complete_notification_job(
  p_job_id uuid, p_worker text, p_outcome text, p_error text default null,
  p_delivered uuid[] default '{}', p_gone uuid[] default '{}'
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  n public.notification_jobs;
begin
  select * into n from public.notification_jobs where id = p_job_id for update;
  if not found or n.status <> 'processing' or n.locked_by is distinct from p_worker then
    return private.err('lease_lost');
  end if;

  update public.push_subscriptions set last_success_at = now(), fail_count = 0 where id = any (p_delivered);
  update public.push_subscriptions set disabled_at = now(), fail_count = fail_count + 1 where id = any (p_gone);

  if p_outcome = 'sent' then
    update public.notification_jobs set status = 'sent', sent_at = now(), lease_until = null, last_error = null where id = n.id;
  elsif p_outcome = 'no_targets' then
    update public.notification_jobs set status = 'skipped', lease_until = null, last_error = 'нет активных подписок' where id = n.id;
  elsif p_outcome = 'failed' then
    if n.attempts >= n.max_attempts then
      update public.notification_jobs set status = 'failed', lease_until = null, last_error = p_error where id = n.id;
    else
      update public.notification_jobs
         set status = 'pending', lease_until = null, last_error = p_error,
             run_at = now() + make_interval(mins => n.attempts * n.attempts)
       where id = n.id;
    end if;
  else
    return private.err('invalid_outcome');
  end if;
  return jsonb_build_object('ok', true);
end $$;
`;export{n as default};
