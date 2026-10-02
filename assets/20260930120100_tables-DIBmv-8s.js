const n=`-- Основные таблицы. Все зависимые данные несут tenant_id и ссылаются на родителя
-- составным ключом (tenant_id, id), поэтому строка одной студии не может сослаться
-- на услугу, пост или запись другой.

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  status text not null default 'preview',
  name text not null,
  timezone text not null,
  currency text not null default 'RUB',
  slot_step_minutes int not null default 30,
  min_notice_minutes int not null default 60,
  horizon_days int not null default 30,
  change_cutoff_minutes int not null default 120,
  public_config jsonb not null default '{}'::jsonb,
  config_version int not null default 0,
  config_hash text,
  activated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tenants_slug_format check (slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
  constraint tenants_status check (status in ('preview', 'live', 'archived')),
  constraint tenants_currency check (currency ~ '^[A-Z]{3}$'),
  constraint tenants_step check (slot_step_minutes between 5 and 240),
  constraint tenants_notice check (min_notice_minutes between 0 and 10080),
  constraint tenants_horizon check (horizon_days between 1 and 365),
  constraint tenants_cutoff check (change_cutoff_minutes between 0 and 10080)
);

create table public.tenant_members (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'owner',
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id),
  constraint tenant_members_role check (role in ('owner', 'staff'))
);
create index tenant_members_user_idx on public.tenant_members (user_id);

create table public.resources (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  key text not null,
  name text not null,
  sort int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, key)
);

create table public.services (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  key text not null,
  name text not null,
  description text not null default '',
  category text not null default '',
  duration_minutes int not null,
  buffer_minutes int not null default 0,
  image text not null default '',
  sort int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, key),
  -- до 14 дней: многодневные работы (керамика, оклейка) занимают пост непрерывно
  constraint services_duration check (duration_minutes between 5 and 20160),
  constraint services_buffer check (buffer_minutes between 0 and 1440)
);

-- История цен: запись фиксирует цену, действовавшую в момент бронирования.
create table public.service_prices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  service_id uuid not null,
  price_minor bigint not null,
  price_is_from boolean not null default false,
  valid_from timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (service_id, valid_from),
  foreign key (tenant_id, service_id) references public.services (tenant_id, id) on delete cascade,
  constraint service_prices_amount check (price_minor >= 0)
);

create table public.service_resources (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  service_id uuid not null,
  resource_id uuid not null,
  primary key (service_id, resource_id),
  foreign key (tenant_id, service_id) references public.services (tenant_id, id) on delete cascade,
  foreign key (tenant_id, resource_id) references public.resources (tenant_id, id) on delete cascade
);

-- Рабочие часы задают моменты приёма машины, а не длительность работы.
-- weekday по ISO: 1 = понедельник, 7 = воскресенье.
create table public.working_hours (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  weekday smallint not null,
  opens time not null,
  closes time not null,
  unique (tenant_id, weekday, opens),
  constraint working_hours_weekday check (weekday between 1 and 7),
  constraint working_hours_range check (opens < closes)
);

create table public.schedule_exceptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  day date not null,
  is_closed boolean not null default true,
  opens time,
  closes time,
  note text not null default '',
  unique (tenant_id, day),
  constraint schedule_exceptions_hours check (is_closed or (opens is not null and closes is not null and opens < closes))
);

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  code text not null,
  service_id uuid not null,
  resource_id uuid not null,
  service_price_id uuid,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  occupied_until timestamptz not null,
  duration_minutes int not null,
  buffer_minutes int not null,
  price_minor bigint not null,
  price_is_from boolean not null,
  currency text not null,
  status text not null default 'new',
  customer_name text not null,
  customer_phone text not null,
  car text not null default '',
  comment text not null default '',
  owner_note text not null default '',
  source text not null default 'client',
  is_demo boolean not null default false,
  version int not null default 1,
  arrived_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, code),
  foreign key (tenant_id, service_id) references public.services (tenant_id, id),
  foreign key (tenant_id, resource_id) references public.resources (tenant_id, id),
  foreign key (tenant_id, service_price_id) references public.service_prices (tenant_id, id),
  constraint bookings_status check (status in ('new', 'confirmed', 'arrived', 'completed', 'cancelled', 'no_show')),
  constraint bookings_source check (source in ('client', 'owner', 'demo')),
  constraint bookings_times check (ends_at > starts_at and occupied_until >= ends_at),
  constraint bookings_price check (price_minor >= 0)
);
create index bookings_tenant_start_idx on public.bookings (tenant_id, starts_at);

-- Единая занятость постов: и бронь, и блокировка владельца.
-- Пересечение активных интервалов одного поста запрещено на уровне БД.
create table public.resource_occupancies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  resource_id uuid not null,
  period tstzrange not null,
  kind text not null,
  booking_id uuid,
  reason text not null default '',
  is_demo boolean not null default false,
  created_by uuid,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, resource_id) references public.resources (tenant_id, id),
  -- отложенная проверка: занятость вставляется раньше строки брони в той же транзакции
  foreign key (tenant_id, booking_id) references public.bookings (tenant_id, id)
    on delete cascade deferrable initially deferred,
  constraint occupancies_kind check (kind in ('booking', 'block')),
  constraint occupancies_kind_booking check ((kind = 'booking') = (booking_id is not null)),
  constraint occupancies_period check (not isempty(period) and lower_inc(period) and not upper_inc(period)
    and not lower_inf(period) and not upper_inf(period)),
  constraint resource_occupancies_no_overlap
    exclude using gist (tenant_id with =, resource_id with =, period with &&) where (released_at is null)
);
create unique index occupancies_active_booking_uidx
  on public.resource_occupancies (booking_id) where released_at is null and booking_id is not null;

-- Доступ клиента к записи: в БД только sha256 токена.
create table public.booking_access_tokens (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  booking_id uuid not null,
  token_hash bytea not null unique,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  foreign key (tenant_id, booking_id) references public.bookings (tenant_id, id) on delete cascade
);

create table public.idempotency_keys (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  action text not null,
  key uuid not null,
  request_hash text not null,
  booking_id uuid,
  result jsonb,
  created_at timestamptz not null default now(),
  primary key (tenant_id, action, key)
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  booking_id uuid not null,
  kind text not null default 'payment',
  amount_minor bigint not null,
  method text not null,
  paid_at timestamptz not null default now(),
  note text not null default '',
  created_by uuid,
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, booking_id) references public.bookings (tenant_id, id) on delete cascade,
  constraint payments_kind check (kind in ('payment', 'refund')),
  constraint payments_method check (method in ('cash', 'card', 'transfer', 'other')),
  constraint payments_amount check (amount_minor > 0)
);
create index payments_tenant_paid_idx on public.payments (tenant_id, paid_at);

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  audience text not null,
  user_id uuid references auth.users (id) on delete cascade,
  booking_id uuid,
  endpoint text not null,
  p256dh text not null,
  auth_secret text not null,
  created_at timestamptz not null default now(),
  last_success_at timestamptz,
  fail_count int not null default 0,
  disabled_at timestamptz,
  foreign key (tenant_id, booking_id) references public.bookings (tenant_id, id) on delete cascade,
  constraint push_audience check (audience in ('owner', 'client')),
  constraint push_owner_or_client check (
    (audience = 'owner' and user_id is not null and booking_id is null)
    or (audience = 'client' and booking_id is not null and user_id is null)),
  constraint push_endpoint_https check (endpoint ~ '^https://'),
  unique nulls not distinct (tenant_id, audience, endpoint, booking_id)
);

-- Outbox уведомлений: задания берутся воркером с арендой (lease), дедупликация по ключу.
create table public.notification_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  booking_id uuid,
  kind text not null,
  audience text not null,
  run_at timestamptz not null default now(),
  status text not null default 'pending',
  attempts int not null default 0,
  max_attempts int not null default 5,
  lease_until timestamptz,
  locked_by text,
  dedupe_key text not null,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, dedupe_key),
  foreign key (tenant_id, booking_id) references public.bookings (tenant_id, id) on delete cascade,
  constraint notification_status check (status in ('pending', 'processing', 'sent', 'failed', 'cancelled', 'skipped')),
  constraint notification_audience check (audience in ('owner', 'client'))
);
create index notification_jobs_due_idx on public.notification_jobs (run_at) where status in ('pending', 'processing');

-- Общие атомарные счётчики для ограничения публичных запросов.
create table public.rate_limits (
  bucket text not null,
  window_start timestamptz not null,
  hits int not null default 0,
  primary key (bucket, window_start)
);

-- Фото студии. source = 'config' приходят из business.json и заменяются при публикации,
-- source = 'owner' загружены владельцем и при переиздании конфига не трогаются.
create table public.tenant_media (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  kind text not null,
  service_key text,
  url text not null,
  alt text not null default '',
  source text not null,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  constraint tenant_media_kind check (kind in ('cover', 'gallery', 'service')),
  constraint tenant_media_source check (source in ('config', 'owner'))
);
create index tenant_media_tenant_idx on public.tenant_media (tenant_id, kind, sort);

create table public.tenant_publications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  version int not null,
  config_hash text not null,
  config jsonb not null,
  published_at timestamptz not null default now(),
  unique (tenant_id, version)
);

-- Секреты сервера. Доступны только функциям-владельцам схемы private.
create table private.app_secrets (
  name text primary key,
  value text not null
);
insert into private.app_secrets (name, value)
values ('booking_token_key', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (name) do nothing;

-- updated_at
create or replace function private.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger tenants_touch before update on public.tenants for each row execute function private.touch_updated_at();
create trigger resources_touch before update on public.resources for each row execute function private.touch_updated_at();
create trigger services_touch before update on public.services for each row execute function private.touch_updated_at();
create trigger bookings_touch before update on public.bookings for each row execute function private.touch_updated_at();
create trigger notification_jobs_touch before update on public.notification_jobs for each row execute function private.touch_updated_at();

-- Часовой пояс проверяется по справочнику PostgreSQL.
create or replace function private.check_tenant_timezone() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception 'invalid_timezone: %', new.timezone using errcode = '22023';
  end if;
  return new;
end $$;
create trigger tenants_timezone before insert or update of timezone on public.tenants
  for each row execute function private.check_tenant_timezone();
`;export{n as default};
