const e=`-- RLS и права. Supabase по умолчанию выдаёт anon/authenticated всё на новые объекты public,\r
-- поэтому сначала всё отзываем, затем выдаём поимённо.\r
-- anon не читает ни одной таблицы: только публичные функции без персональных данных.\r
-- authenticated читает строки своей студии (RLS), пишет только через функции.\r
\r
revoke all on all tables in schema public from anon, authenticated;\r
revoke all on all sequences in schema public from anon, authenticated;\r
revoke execute on all functions in schema public from public, anon, authenticated;\r
revoke all on all tables in schema private from public, anon, authenticated;\r
revoke execute on all functions in schema private from public, anon, authenticated;\r
revoke all on schema private from anon, authenticated;\r
\r
alter default privileges in schema public revoke all on tables from anon, authenticated;\r
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;\r
alter default privileges in schema private revoke execute on functions from public;\r
\r
grant usage on schema public to anon, authenticated, service_role;\r
\r
do $$\r
declare\r
  tbl text;\r
begin\r
  foreach tbl in array array[\r
    'tenants', 'tenant_members', 'resources', 'services', 'service_prices', 'service_resources',\r
    'working_hours', 'schedule_exceptions', 'bookings', 'resource_occupancies', 'booking_access_tokens',\r
    'idempotency_keys', 'payments', 'push_subscriptions', 'notification_jobs', 'rate_limits',\r
    'tenant_media', 'tenant_publications']\r
  loop\r
    execute format('alter table public.%I enable row level security', tbl);\r
  end loop;\r
end $$;\r
\r
-- Чтение для членов студии. Токены, ключи идемпотентности, счётчики и outbox\r
-- не доступны никому, кроме функций.\r
create policy tenants_member_read on public.tenants for select to authenticated\r
  using (private.is_member(id));\r
create policy members_self_read on public.tenant_members for select to authenticated\r
  using (user_id = auth.uid());\r
create policy resources_member_read on public.resources for select to authenticated\r
  using (private.is_member(tenant_id));\r
create policy services_member_read on public.services for select to authenticated\r
  using (private.is_member(tenant_id));\r
create policy prices_member_read on public.service_prices for select to authenticated\r
  using (private.is_member(tenant_id));\r
create policy service_resources_member_read on public.service_resources for select to authenticated\r
  using (private.is_member(tenant_id));\r
create policy hours_member_read on public.working_hours for select to authenticated\r
  using (private.is_member(tenant_id));\r
create policy exceptions_member_read on public.schedule_exceptions for select to authenticated\r
  using (private.is_member(tenant_id));\r
create policy bookings_member_read on public.bookings for select to authenticated\r
  using (private.is_member(tenant_id));\r
create policy occupancies_member_read on public.resource_occupancies for select to authenticated\r
  using (private.is_member(tenant_id));\r
create policy payments_member_read on public.payments for select to authenticated\r
  using (private.is_member(tenant_id));\r
create policy media_member_read on public.tenant_media for select to authenticated\r
  using (private.is_member(tenant_id));\r
\r
grant select on public.tenants, public.tenant_members, public.resources, public.services, public.service_prices,\r
  public.service_resources, public.working_hours, public.schedule_exceptions, public.bookings,\r
  public.resource_occupancies, public.payments, public.tenant_media to authenticated;\r
\r
-- Функции, которые политики вызывают от имени authenticated.\r
grant usage on schema private to authenticated;\r
grant execute on function private.is_member(uuid) to authenticated;\r
\r
-- Публичные функции (клиент без регистрации).\r
grant execute on function public.get_public_tenant(text) to anon, authenticated;\r
grant execute on function public.get_availability(text, uuid, date, date) to anon, authenticated;\r
grant execute on function public.create_booking(text, uuid, timestamptz, text, text, text, text, boolean, uuid) to anon, authenticated;\r
grant execute on function public.get_booking_by_token(text) to anon, authenticated;\r
grant execute on function public.reschedule_booking(text, timestamptz, uuid) to anon, authenticated;\r
grant execute on function public.cancel_booking(text, text) to anon, authenticated;\r
grant execute on function public.register_client_push(text, text, text, text) to anon, authenticated;\r
\r
-- Кабинет владельца: членство проверяется внутри каждой функции.\r
grant execute on function public.owner_tenants() to authenticated;\r
grant execute on function public.owner_list_bookings(uuid, date, date, text) to authenticated;\r
grant execute on function public.owner_get_booking(uuid) to authenticated;\r
grant execute on function public.owner_set_status(uuid, text, text) to authenticated;\r
grant execute on function public.owner_update_note(uuid, text) to authenticated;\r
grant execute on function public.owner_reschedule(uuid, timestamptz, uuid) to authenticated;\r
grant execute on function public.owner_create_booking(uuid, uuid, timestamptz, uuid, text, text, text, text, uuid) to authenticated;\r
grant execute on function public.owner_resources(uuid, timestamptz, timestamptz) to authenticated;\r
grant execute on function public.owner_block_resource(uuid, uuid, timestamptz, timestamptz, text) to authenticated;\r
grant execute on function public.owner_unblock(uuid) to authenticated;\r
grant execute on function public.owner_add_payment(uuid, bigint, text, text, text, uuid) to authenticated;\r
grant execute on function public.owner_register_push(uuid, text, text, text) to authenticated;\r
grant execute on function public.owner_unregister_push(uuid, text) to authenticated;\r
grant execute on function public.owner_notification_status(uuid) to authenticated;\r
grant execute on function public.owner_stats(uuid, date, date) to authenticated;\r
\r
-- Только сервер: конвейер студий и воркер уведомлений.\r
grant execute on function public.publish_tenant_config(jsonb) to service_role;\r
grant execute on function public.admin_add_member(text, uuid, text) to service_role;\r
grant execute on function public.tenant_health(text) to service_role;\r
grant execute on function public.activate_tenant(text) to service_role;\r
grant execute on function public.deactivate_tenant(text) to service_role;\r
grant execute on function public.seed_demo_bookings(text) to service_role;\r
grant execute on function public.claim_notification_jobs(text, int, int) to service_role;\r
grant execute on function public.complete_notification_job(uuid, text, text, text, uuid[], uuid[]) to service_role;\r
`;export{e as default};
