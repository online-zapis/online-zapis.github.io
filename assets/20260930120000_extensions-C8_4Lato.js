const e=`-- Расширения и служебные схемы.
-- На Supabase pgcrypto уже установлен в схему extensions, повторное создание безопасно.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists btree_gist with schema extensions;

-- private: внутренние функции и секреты, не публикуются через PostgREST.
create schema if not exists private;
revoke all on schema private from public;
`;export{e as default};
