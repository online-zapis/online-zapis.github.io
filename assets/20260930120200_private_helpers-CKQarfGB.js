const e=`-- Внутренние функции. Схема private не публикуется через API.

-- Бизнес-ошибка с машиночитаемым кодом. Публичные функции ловят её и отдают { ok:false, error }.
create or replace function private.fail(p_code text, p_detail text default null) returns void
language plpgsql as $$
begin
  raise exception using errcode = 'P0001', message = p_code, detail = coalesce(p_detail, '');
end $$;

create or replace function private.err(p_code text, p_detail text default null) returns jsonb
language sql immutable as $$
  select jsonb_build_object('ok', false, 'error', p_code, 'detail', nullif(p_detail, ''))
$$;

-- IP клиента из заголовков PostgREST (Cloudflare или прокси Supabase).
create or replace function private.client_ip() returns text
language plpgsql stable as $$
declare
  h jsonb := nullif(current_setting('request.headers', true), '')::jsonb;
begin
  return coalesce(
    nullif(trim(h ->> 'cf-connecting-ip'), ''),
    nullif(trim(split_part(h ->> 'x-forwarded-for', ',', 1)), ''),
    'unknown');
end $$;

-- Атомарный счётчик окна. true, если лимит ещё не превышен.
create or replace function private.hit_rate_limit(p_bucket text, p_max int, p_window_seconds int) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_hits int;
begin
  insert into public.rate_limits as r (bucket, window_start, hits)
  values (p_bucket, v_window, 1)
  on conflict (bucket, window_start) do update set hits = r.hits + 1
  returning hits into v_hits;
  return v_hits <= p_max;
end $$;

-- Токен доступа к записи. Детерминирован от (студия, ключ идемпотентности) и серверного
-- секрета: повтор запроса с тем же ключом выдаёт тот же токен, а хранится только его хеш.
create or replace function private.token_for(p_tenant uuid, p_key uuid) returns text
language sql stable security definer set search_path = '' as $$
  select translate(rtrim(encode(extensions.hmac(
           convert_to(p_tenant::text || ':' || p_key::text, 'UTF8'),
           decode((select value from private.app_secrets where name = 'booking_token_key'), 'hex'),
           'sha256'), 'base64'), '='), '+/', '-_')
$$;

create or replace function private.hash_token(p_token text) returns bytea
language sql immutable as $$
  select extensions.digest(convert_to(coalesce(p_token, ''), 'UTF8'), 'sha256')
$$;

create or replace function private.normalize_phone(p text) returns text
language plpgsql immutable as $$
declare
  d text := regexp_replace(coalesce(p, ''), '\\D', '', 'g');
begin
  if length(d) = 11 and left(d, 1) = '8' then d := '7' || substr(d, 2); end if;
  if length(d) = 10 and left(d, 1) = '9' then d := '7' || d; end if;
  if length(d) < 10 or length(d) > 15 then return null; end if;
  return '+' || d;
end $$;

create or replace function private.new_booking_code() returns text
language plpgsql volatile as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  bytes bytea := extensions.gen_random_bytes(6);
  out text := '';
begin
  for i in 0..5 loop
    out := out || substr(alphabet, (get_byte(bytes, i) % length(alphabet)) + 1, 1);
  end loop;
  return out;
end $$;

create or replace function private.is_member(p_tenant uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.tenant_members m
    where m.tenant_id = p_tenant and m.user_id = auth.uid())
$$;

create or replace function private.assert_member(p_tenant uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then perform private.fail('not_authenticated'); end if;
  if not private.is_member(p_tenant) then perform private.fail('forbidden'); end if;
end $$;

-- Студия для публичных запросов: только preview и live.
create or replace function private.public_tenant(p_slug text) returns public.tenants
language plpgsql stable security definer set search_path = '' as $$
declare
  t public.tenants;
begin
  select * into t from public.tenants where slug = lower(p_slug) and status in ('preview', 'live');
  if not found then perform private.fail('tenant_not_found'); end if;
  return t;
end $$;

-- Локальная полночь дня в часовом поясе студии.
create or replace function private.local_midnight(p_day date, p_tz text) returns timestamptz
language sql stable as $$
  select (p_day::timestamp) at time zone p_tz
$$;
`;export{e as default};
