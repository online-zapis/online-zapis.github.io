const e=`-- Минимальное окружение Supabase для локальных тестов на PGlite.
-- На настоящем Supabase всё это уже есть, миграции его не создают.

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  encrypted_password text,
  created_at timestamptz not null default now()
);

-- Совпадает с определениями Supabase: субъект берётся из JWT-claims запроса.
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create function auth.role() returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

-- Как на Supabase: новые объекты public по умолчанию доступны всем ролям API.
-- Миграция прав обязана это отозвать, тесты проверяют, что отозвала.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

-- Эмуляция Supabase Storage для локального стенда и демо-режима в браузере.
create schema local_storage;
create table local_storage.objects (
  bucket text not null,
  name text not null,
  content_type text not null,
  data bytea not null,
  updated_at timestamptz not null default now(),
  primary key (bucket, name)
);
`;export{e as default};
