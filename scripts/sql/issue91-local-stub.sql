-- LOCAL-ONLY stub of the Supabase objects the Issue #91 migration depends on.
-- For a throwaway vanilla Postgres (scripts/check-upload-sessions-sql.sh). Never run on Supabase.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;
create schema auth;
create table auth.users (id uuid primary key);
create schema storage;
create table storage.buckets (id text primary key, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, metadata jsonb);
create function storage.protect_delete() returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('storage.allow_delete_query', true), 'false') <> 'true' then
    raise exception 'Direct deletion from storage tables is not allowed. Use the Storage API instead.' using errcode = '42501';
  end if;
  return null;
end $$;
create trigger protect_objects_delete before delete on storage.objects for each statement execute function storage.protect_delete();
create table public.beatbay_beats (id uuid primary key default gen_random_uuid(), status text, storefront_enabled boolean default false, full_audio_bucket text, full_audio_path text);
insert into storage.buckets values
  ('release-private', array['application/zip','audio/mpeg','audio/wav','audio/x-wav','image/jpeg','image/png','image/webp']),
  ('release-public', null);
