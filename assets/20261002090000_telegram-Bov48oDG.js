const e=`-- Уведомления владельцу в Telegram. В кабинете владелец получает одноразовую ссылку\r
-- t.me/<бот>?start=<код>; бот (Edge Function telegram-webhook) по коду привязывает свой чат.\r
-- В базе хранится только хеш кода, код действует 15 минут. Таблица закрыта для API, доступ через функции.\r
\r
create table public.owner_telegram (\r
  id uuid primary key default gen_random_uuid(),\r
  tenant_id uuid not null references public.tenants (id) on delete cascade,\r
  user_id uuid not null references auth.users (id) on delete cascade,\r
  chat_id bigint,\r
  chat_name text,\r
  link_code_hash text unique,\r
  code_expires_at timestamptz,\r
  linked_at timestamptz,\r
  disabled_at timestamptz,\r
  last_success_at timestamptz,\r
  fail_count int not null default 0,\r
  created_at timestamptz not null default now(),\r
  unique (tenant_id, user_id)\r
);\r
alter table public.owner_telegram enable row level security;\r
revoke all on public.owner_telegram from anon, authenticated;\r
\r
create or replace function private.telegram_code_hash(p_code text) returns text\r
language sql immutable set search_path = '' as $$\r
  select encode(extensions.digest(p_code, 'sha256'), 'hex')\r
$$;\r
\r
-- Ссылка для привязки: каждый вызов выдаёт новый код, старый перестаёт действовать.\r
create or replace function public.owner_telegram_link(p_tenant_id uuid) returns jsonb\r
language plpgsql security definer set search_path = '' as $$\r
declare\r
  v_code text := encode(extensions.gen_random_bytes(12), 'hex');\r
begin\r
  begin\r
    perform private.assert_member(p_tenant_id);\r
  exception when sqlstate 'P0001' then\r
    return private.err(sqlerrm);\r
  end;\r
  insert into public.owner_telegram (tenant_id, user_id, link_code_hash, code_expires_at)\r
  values (p_tenant_id, auth.uid(), private.telegram_code_hash(v_code), now() + interval '15 minutes')\r
  on conflict (tenant_id, user_id)\r
  do update set link_code_hash = excluded.link_code_hash, code_expires_at = excluded.code_expires_at;\r
  return jsonb_build_object('ok', true, 'code', v_code);\r
end $$;\r
\r
create or replace function public.owner_telegram_status(p_tenant_id uuid) returns jsonb\r
language plpgsql stable security definer set search_path = '' as $$\r
declare\r
  r public.owner_telegram;\r
begin\r
  begin\r
    perform private.assert_member(p_tenant_id);\r
  exception when sqlstate 'P0001' then\r
    return private.err(sqlerrm);\r
  end;\r
  select * into r from public.owner_telegram where tenant_id = p_tenant_id and user_id = auth.uid();\r
  return jsonb_build_object('ok', true,\r
    'linked', coalesce(r.chat_id is not null and r.disabled_at is null, false),\r
    'chat_name', r.chat_name,\r
    'linked_at', r.linked_at);\r
end $$;\r
\r
create or replace function public.owner_telegram_unlink(p_tenant_id uuid) returns jsonb\r
language plpgsql security definer set search_path = '' as $$\r
begin\r
  begin\r
    perform private.assert_member(p_tenant_id);\r
  exception when sqlstate 'P0001' then\r
    return private.err(sqlerrm);\r
  end;\r
  update public.owner_telegram\r
     set chat_id = null, chat_name = null, linked_at = null, disabled_at = now(), link_code_hash = null\r
   where tenant_id = p_tenant_id and user_id = auth.uid();\r
  return jsonb_build_object('ok', true);\r
end $$;\r
\r
-- Вызывает бот (service_role), когда владелец нажал «Старт» по ссылке из кабинета.\r
create or replace function public.telegram_link_chat(p_code text, p_chat_id bigint, p_chat_name text) returns jsonb\r
language plpgsql security definer set search_path = '' as $$\r
declare\r
  r public.owner_telegram;\r
  v_name text;\r
begin\r
  if coalesce(p_code, '') !~ '^[0-9a-f]{24}$' or p_chat_id is null then\r
    return private.err('invalid_code');\r
  end if;\r
  select * into r from public.owner_telegram\r
   where link_code_hash = private.telegram_code_hash(p_code) and code_expires_at > now()\r
   for update;\r
  if not found then\r
    return private.err('invalid_code');\r
  end if;\r
  update public.owner_telegram\r
     set chat_id = p_chat_id, chat_name = left(nullif(trim(p_chat_name), ''), 100), linked_at = now(),\r
         disabled_at = null, fail_count = 0, link_code_hash = null, code_expires_at = null\r
   where id = r.id;\r
  select name into v_name from public.tenants where id = r.tenant_id;\r
  return jsonb_build_object('ok', true, 'tenant_name', v_name);\r
end $$;\r
\r
-- Команда /stop в боте: чат больше ничего не получает ни от одной студии.\r
create or replace function public.telegram_unlink_chat(p_chat_id bigint) returns jsonb\r
language plpgsql security definer set search_path = '' as $$\r
declare\r
  v_count int;\r
begin\r
  update public.owner_telegram\r
     set disabled_at = now(), chat_id = null, chat_name = null, linked_at = null\r
   where chat_id = p_chat_id and disabled_at is null;\r
  get diagnostics v_count = row_count;\r
  return jsonb_build_object('ok', true, 'unlinked', v_count);\r
end $$;\r
\r
-- Задание воркера теперь несёт и чаты Telegram владельцев студии.\r
create or replace function private.render_job(p_job_id uuid) returns jsonb\r
language plpgsql stable security definer set search_path = '' as $$\r
declare\r
  n public.notification_jobs;\r
  t public.tenants;\r
  b public.bookings;\r
  s public.services;\r
  v_when text;\r
  v_title text;\r
  v_body text;\r
  v_url text;\r
  v_subs jsonb;\r
  v_tg jsonb := '[]'::jsonb;\r
begin\r
  select * into n from public.notification_jobs where id = p_job_id;\r
  select * into t from public.tenants where id = n.tenant_id;\r
  select * into b from public.bookings where id = n.booking_id;\r
  select * into s from public.services where id = b.service_id;\r
  v_when := to_char(b.starts_at at time zone t.timezone, 'DD.MM в HH24:MI');\r
\r
  case n.kind\r
    when 'owner_created' then v_title := 'Новая запись'; v_body := s.name || ', ' || v_when || '. ' || b.customer_name;\r
    when 'owner_rescheduled' then v_title := 'Запись перенесена'; v_body := s.name || ', теперь ' || v_when || '. ' || b.customer_name;\r
    when 'owner_cancelled' then v_title := 'Запись отменена'; v_body := s.name || ', ' || v_when || '. ' || b.customer_name;\r
    when 'client_reminder_24h' then v_title := t.name; v_body := 'Завтра ' || v_when || ': ' || s.name || '. Ждём вас!';\r
    when 'client_reminder_2h' then v_title := t.name; v_body := 'Через 2 часа, ' || v_when || ': ' || s.name || '.';\r
    else v_title := t.name; v_body := s.name || ', ' || v_when;\r
  end case;\r
\r
  if n.audience = 'owner' then\r
    v_url := '/s/' || t.slug || '/owner/?booking=' || b.id;\r
    select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'endpoint', p.endpoint, 'p256dh', p.p256dh, 'auth', p.auth_secret)), '[]')\r
      into v_subs\r
      from public.push_subscriptions p\r
      join public.tenant_members m on m.tenant_id = p.tenant_id and m.user_id = p.user_id\r
     where p.tenant_id = n.tenant_id and p.audience = 'owner' and p.disabled_at is null;\r
    select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'chat_id', o.chat_id)), '[]')\r
      into v_tg\r
      from public.owner_telegram o\r
      join public.tenant_members m on m.tenant_id = o.tenant_id and m.user_id = o.user_id\r
     where o.tenant_id = n.tenant_id and o.chat_id is not null and o.disabled_at is null;\r
    -- телефон клиента в Telegram: владельцу удобно сразу перезвонить\r
    if n.kind in ('owner_created', 'owner_rescheduled') then\r
      v_body := v_body || ', ' || b.customer_phone;\r
    end if;\r
  else\r
    v_url := '/s/' || t.slug || '/my';\r
    select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'endpoint', p.endpoint, 'p256dh', p.p256dh, 'auth', p.auth_secret)), '[]')\r
      into v_subs\r
      from public.push_subscriptions p\r
     where p.tenant_id = n.tenant_id and p.audience = 'client' and p.booking_id = n.booking_id and p.disabled_at is null;\r
  end if;\r
\r
  return jsonb_build_object(\r
    'id', n.id, 'kind', n.kind, 'audience', n.audience, 'attempts', n.attempts,\r
    'title', v_title, 'body', v_body, 'url', v_url, 'tag', n.kind || ':' || n.booking_id,\r
    'tenant_name', t.name,\r
    'subscriptions', v_subs, 'telegram', v_tg);\r
end $$;\r
\r
-- Отчёт воркера с учётом Telegram: p_tg_gone — чаты, где бот заблокирован или чат удалён.\r
drop function public.complete_notification_job(uuid, text, text, text, uuid[], uuid[]);\r
create or replace function public.complete_notification_job(\r
  p_job_id uuid, p_worker text, p_outcome text, p_error text default null,\r
  p_delivered uuid[] default '{}', p_gone uuid[] default '{}',\r
  p_tg_delivered uuid[] default '{}', p_tg_gone uuid[] default '{}'\r
) returns jsonb\r
language plpgsql security definer set search_path = '' as $$\r
declare\r
  n public.notification_jobs;\r
begin\r
  select * into n from public.notification_jobs where id = p_job_id for update;\r
  if not found or n.status <> 'processing' or n.locked_by is distinct from p_worker then\r
    return private.err('lease_lost');\r
  end if;\r
\r
  update public.push_subscriptions set last_success_at = now(), fail_count = 0 where id = any (p_delivered);\r
  update public.push_subscriptions set disabled_at = now(), fail_count = fail_count + 1 where id = any (p_gone);\r
  update public.owner_telegram set last_success_at = now(), fail_count = 0 where id = any (p_tg_delivered);\r
  update public.owner_telegram set disabled_at = now(), fail_count = fail_count + 1 where id = any (p_tg_gone);\r
\r
  if p_outcome = 'sent' then\r
    update public.notification_jobs set status = 'sent', sent_at = now(), lease_until = null, last_error = null where id = n.id;\r
  elsif p_outcome = 'no_targets' then\r
    update public.notification_jobs set status = 'skipped', lease_until = null, last_error = 'нет активных подписок' where id = n.id;\r
  elsif p_outcome = 'failed' then\r
    if n.attempts >= n.max_attempts then\r
      update public.notification_jobs set status = 'failed', lease_until = null, last_error = p_error where id = n.id;\r
    else\r
      update public.notification_jobs\r
         set status = 'pending', lease_until = null, last_error = p_error,\r
             run_at = now() + make_interval(mins => n.attempts * n.attempts)\r
       where id = n.id;\r
    end if;\r
  else\r
    return private.err('invalid_outcome');\r
  end if;\r
  return jsonb_build_object('ok', true);\r
end $$;\r
\r
-- Статус для экрана «Ещё»: push-подписки и Telegram вместе.\r
create or replace function public.owner_notification_status(p_tenant_id uuid) returns jsonb\r
language plpgsql stable security definer set search_path = '' as $$\r
begin\r
  begin\r
    perform private.assert_member(p_tenant_id);\r
  exception when sqlstate 'P0001' then\r
    return private.err(sqlerrm);\r
  end;\r
  return jsonb_build_object('ok', true,\r
    'subscriptions', (select count(*) from public.push_subscriptions\r
                       where tenant_id = p_tenant_id and audience = 'owner' and user_id = auth.uid() and disabled_at is null),\r
    'telegram', exists (select 1 from public.owner_telegram\r
                         where tenant_id = p_tenant_id and user_id = auth.uid() and chat_id is not null and disabled_at is null),\r
    'jobs', coalesce((select jsonb_object_agg(status, n) from (\r
       select status, count(*) n from public.notification_jobs\r
        where tenant_id = p_tenant_id and created_at > now() - interval '7 days' group by status) x), '{}'::jsonb));\r
end $$;\r
\r
-- Права: новые функции закрыты для всех, затем выдаются поимённо.\r
revoke execute on function private.telegram_code_hash(text) from public, anon, authenticated;\r
revoke execute on function public.owner_telegram_link(uuid) from public, anon;\r
revoke execute on function public.owner_telegram_status(uuid) from public, anon;\r
revoke execute on function public.owner_telegram_unlink(uuid) from public, anon;\r
revoke execute on function public.telegram_link_chat(text, bigint, text) from public, anon, authenticated;\r
revoke execute on function public.telegram_unlink_chat(bigint) from public, anon, authenticated;\r
revoke execute on function public.complete_notification_job(uuid, text, text, text, uuid[], uuid[], uuid[], uuid[]) from public, anon, authenticated;\r
\r
grant execute on function public.owner_telegram_link(uuid) to authenticated;\r
grant execute on function public.owner_telegram_status(uuid) to authenticated;\r
grant execute on function public.owner_telegram_unlink(uuid) to authenticated;\r
grant execute on function public.telegram_link_chat(text, bigint, text) to service_role;\r
grant execute on function public.telegram_unlink_chat(bigint) to service_role;\r
grant execute on function public.complete_notification_job(uuid, text, text, text, uuid[], uuid[], uuid[], uuid[]) to service_role;\r
`;export{e as default};
