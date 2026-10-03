const e=`-- 1) Напоминания клиенту в Telegram. После записи клиент получает одноразовую ссылку
--    t.me/<бот>?start=c<код>; бот привязывает чат к этой записи. Напоминания за 24 и 2 часа
--    (те же задания outbox) уходят и в Telegram. Хранится только хеш кода, код живёт 30 минут.
-- 2) Еженедельный отчёт владельцу в Telegram: в понедельник утром по поясу студии —
--    сколько записей пришло через сайт, по звонку, отмены и полученные деньги за прошлую неделю.

create table public.client_telegram (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  booking_id uuid not null,
  chat_id bigint,
  link_code_hash text unique,
  code_expires_at timestamptz,
  linked_at timestamptz,
  disabled_at timestamptz,
  last_success_at timestamptz,
  fail_count int not null default 0,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, booking_id) references public.bookings (tenant_id, id) on delete cascade,
  unique (booking_id)
);
alter table public.client_telegram enable row level security;
revoke all on public.client_telegram from anon, authenticated;

create table public.weekly_reports (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  week_start date not null,
  sent_at timestamptz not null default now(),
  primary key (tenant_id, week_start)
);
alter table public.weekly_reports enable row level security;
revoke all on public.weekly_reports from anon, authenticated;

-- Клиент по токену своей записи получает код для бота.
create or replace function public.client_telegram_link(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  b public.bookings;
  v_code text := encode(extensions.gen_random_bytes(12), 'hex');
begin
  if not private.hit_rate_limit('tglink:' || private.client_ip(), 20, 3600) then
    return private.err('rate_limited');
  end if;
  begin
    b := private.booking_by_token(p_token);
    if b.status not in ('new', 'confirmed') or b.starts_at < now() then
      perform private.fail('booking_not_active');
    end if;
  exception when sqlstate 'P0001' then
    return private.err(sqlerrm);
  end;
  insert into public.client_telegram (tenant_id, booking_id, link_code_hash, code_expires_at)
  values (b.tenant_id, b.id, private.telegram_code_hash(v_code), now() + interval '30 minutes')
  on conflict (booking_id)
  do update set link_code_hash = excluded.link_code_hash, code_expires_at = excluded.code_expires_at;
  return jsonb_build_object('ok', true, 'code', v_code);
end $$;

-- Вызывает бот (service_role): клиент нажал «Старт» по ссылке со своей записи.
create or replace function public.telegram_link_client(p_code text, p_chat_id bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.client_telegram;
  t public.tenants;
  b public.bookings;
begin
  if coalesce(p_code, '') !~ '^[0-9a-f]{24}$' or p_chat_id is null then
    return private.err('invalid_code');
  end if;
  select * into r from public.client_telegram
   where link_code_hash = private.telegram_code_hash(p_code) and code_expires_at > now()
   for update;
  if not found then
    return private.err('invalid_code');
  end if;
  update public.client_telegram
     set chat_id = p_chat_id, linked_at = now(), disabled_at = null, fail_count = 0,
         link_code_hash = null, code_expires_at = null
   where id = r.id;
  select * into b from public.bookings where id = r.booking_id;
  select * into t from public.tenants where id = r.tenant_id;
  return jsonb_build_object('ok', true, 'tenant_name', t.name,
    'when', to_char(b.starts_at at time zone t.timezone, 'DD.MM в HH24:MI'));
end $$;

-- /stop отключает чат и у владельцев, и у клиентов.
create or replace function public.telegram_unlink_chat(p_chat_id bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner int;
  v_client int;
begin
  update public.owner_telegram
     set disabled_at = now(), chat_id = null, chat_name = null, linked_at = null
   where chat_id = p_chat_id and disabled_at is null;
  get diagnostics v_owner = row_count;
  update public.client_telegram
     set disabled_at = now(), chat_id = null
   where chat_id = p_chat_id and disabled_at is null;
  get diagnostics v_client = row_count;
  return jsonb_build_object('ok', true, 'unlinked', v_owner + v_client);
end $$;

-- Задание воркера: у клиентских напоминаний тоже есть чаты Telegram.
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
  v_tg jsonb := '[]'::jsonb;
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
    select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'chat_id', o.chat_id)), '[]')
      into v_tg
      from public.owner_telegram o
      join public.tenant_members m on m.tenant_id = o.tenant_id and m.user_id = o.user_id
     where o.tenant_id = n.tenant_id and o.chat_id is not null and o.disabled_at is null;
    if n.kind in ('owner_created', 'owner_rescheduled') then
      v_body := v_body || ', ' || b.customer_phone;
    end if;
  else
    v_url := '/s/' || t.slug || '/my';
    select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'endpoint', p.endpoint, 'p256dh', p.p256dh, 'auth', p.auth_secret)), '[]')
      into v_subs
      from public.push_subscriptions p
     where p.tenant_id = n.tenant_id and p.audience = 'client' and p.booking_id = n.booking_id and p.disabled_at is null;
    select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'chat_id', c.chat_id)), '[]')
      into v_tg
      from public.client_telegram c
     where c.booking_id = n.booking_id and c.chat_id is not null and c.disabled_at is null;
    if t.public_config #>> '{contacts,address}' is not null then
      v_body := v_body || E'\\n' || (t.public_config #>> '{contacts,address}');
    end if;
  end if;

  return jsonb_build_object(
    'id', n.id, 'kind', n.kind, 'audience', n.audience, 'attempts', n.attempts,
    'title', v_title, 'body', v_body, 'url', v_url, 'tag', n.kind || ':' || n.booking_id,
    'tenant_name', case when n.audience = 'owner' then t.name end,
    'subscriptions', v_subs, 'telegram', v_tg);
end $$;

-- Отчёт воркера: id чатов могут быть и владельческими, и клиентскими.
create or replace function public.complete_notification_job(
  p_job_id uuid, p_worker text, p_outcome text, p_error text default null,
  p_delivered uuid[] default '{}', p_gone uuid[] default '{}',
  p_tg_delivered uuid[] default '{}', p_tg_gone uuid[] default '{}'
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
  update public.owner_telegram set last_success_at = now(), fail_count = 0 where id = any (p_tg_delivered);
  update public.owner_telegram set disabled_at = now(), fail_count = fail_count + 1 where id = any (p_tg_gone);
  update public.client_telegram set last_success_at = now(), fail_count = 0 where id = any (p_tg_delivered);
  update public.client_telegram set disabled_at = now(), fail_count = fail_count + 1 where id = any (p_tg_gone);

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

-- Еженедельные отчёты: студии, у которых в их поясе понедельник с 9 утра и отчёт за прошлую неделю
-- ещё не отправлен. Вызов сразу отмечает отправку (повторно в ту же неделю не придёт).
-- p_now — для тестов.
create or replace function public.claim_weekly_reports(p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t record;
  v_out jsonb := '[]'::jsonb;
  v_local timestamp;
  v_week date;
  v_from timestamptz;
  v_to timestamptz;
  v_online int;
  v_phone int;
  v_cancelled int;
  v_paid bigint;
  v_chats jsonb;
begin
  for t in
    select * from public.tenants where status = 'live'
  loop
    v_local := p_now at time zone t.timezone;
    continue when extract(isodow from v_local) <> 1 or extract(hour from v_local) < 9;
    v_week := (v_local::date - 7);                         -- понедельник прошлой недели
    select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'chat_id', o.chat_id)), '[]') into v_chats
      from public.owner_telegram o
      join public.tenant_members m on m.tenant_id = o.tenant_id and m.user_id = o.user_id
     where o.tenant_id = t.id and o.chat_id is not null and o.disabled_at is null;
    continue when v_chats = '[]'::jsonb;
    insert into public.weekly_reports (tenant_id, week_start) values (t.id, v_week)
    on conflict do nothing;
    continue when not found;

    v_from := v_week::timestamp at time zone t.timezone;
    v_to := (v_week + 7)::timestamp at time zone t.timezone;
    select count(*) filter (where source = 'client'), count(*) filter (where source <> 'client'),
           count(*) filter (where status = 'cancelled')
      into v_online, v_phone, v_cancelled
      from public.bookings where tenant_id = t.id and not is_demo and created_at >= v_from and created_at < v_to;
    select coalesce(sum(case when kind = 'payment' then amount_minor else -amount_minor end), 0) into v_paid
      from public.payments where tenant_id = t.id and not is_demo and paid_at >= v_from and paid_at < v_to;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'tenant_name', t.name,
      'period', to_char(v_week, 'DD.MM') || '–' || to_char(v_week + 6, 'DD.MM'),
      'online', v_online, 'phone', v_phone, 'cancelled', v_cancelled, 'paid_minor', v_paid,
      'currency', t.currency, 'telegram', v_chats));
  end loop;
  return v_out;
end $$;

revoke execute on function public.client_telegram_link(text) from public;
revoke execute on function public.telegram_link_client(text, bigint) from public, anon, authenticated;
revoke execute on function public.telegram_unlink_chat(bigint) from public, anon, authenticated;
revoke execute on function public.claim_weekly_reports(timestamptz) from public, anon, authenticated;
revoke execute on function public.complete_notification_job(uuid, text, text, text, uuid[], uuid[], uuid[], uuid[]) from public, anon, authenticated;

grant execute on function public.client_telegram_link(text) to anon, authenticated;
grant execute on function public.telegram_link_client(text, bigint) to service_role;
grant execute on function public.telegram_unlink_chat(bigint) to service_role;
grant execute on function public.claim_weekly_reports(timestamptz) to service_role;
grant execute on function public.complete_notification_job(uuid, text, text, text, uuid[], uuid[], uuid[], uuid[]) to service_role;
`;export{e as default};
