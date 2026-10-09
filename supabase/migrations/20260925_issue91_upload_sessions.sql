-- Issue #91: Beatbox large-file uploads (Option A: Supabase Free, $0).
-- NON-PROD DRY-RUN FIRST. Do not apply to prod (sktgkrcahsxvidzjjxxt) until
-- the non-prod dry-run, Craig's security review, and Owner approval.
--
-- Also: status 'replaced' (superseded chunked masters; parts deleted only on
-- explicit owner confirm) and music_activity_log.email_status 'suppressed'.
-- Adds: upload_limits (single config row), upload_sessions, upload_chunks,
-- beatbay_beat_assets (stems/video/zip attach target), upload_storage_usage()
-- (Free 1 GB budget check), upload_sessions_expire() (hourly cleanup; schedule
-- is in the separate OPTIONAL pg_cron migration), and video/mp4 +
-- application/json on release-private.
--
-- All new tables: RLS on, no policies, nothing granted to anon/authenticated.
-- Only service_role (beatbay-manager / studio-manager) reads or writes them.
-- Additive only. Rollback: supabase/rollback/20260925_issue91_upload_sessions_rollback.sql

begin;

-- ---------------------------------------------------------------------------
-- Config row. No hard-coded limits in the Edge code: it reads this row.
-- ---------------------------------------------------------------------------
create table if not exists public.upload_limits (
  id smallint primary key default 1,
  max_file_bytes bigint not null default 943718400,              -- 900 MiB (Free: 1 GB total storage)
  chunk_bytes integer not null default 16777216,                 -- 16 MiB
  min_chunk_bytes integer not null default 1048576,              -- 1 MiB
  single_object_threshold bigint not null default 47185920,      -- 45 MiB: below this, the existing single-object path
  session_ttl_seconds integer not null default 86400,            -- 24 h
  max_attempts integer not null default 5,                       -- per chunk
  ticket_ttl_seconds integer not null default 900,
  ticket_batch_max integer not null default 16,
  max_open_sessions_per_user integer not null default 3,
  max_total_upload_bytes bigint not null default 1006632960,     -- 960 MiB storage budget (Free cap is 1 GB per project)
  budget_bucket_ids text[] default null,                          -- null = count every bucket (the Free cap is project-wide)
  preview_max_bytes bigint not null default 10485760,            -- release-public bucket limit (10 MB)
  compress_min_saving numeric(4,3) not null default 0.100,
  compress_max_bytes bigint not null default 536870912,          -- 512 MiB
  compressible_exts text[] not null default array['wav'],
  zip_max_entries integer not null default 2000,
  zip_max_cd_bytes integer not null default 8388608,             -- 8 MiB central directory read cap
  zip_blocked_exts text[] not null default array['exe','dll','com','scr','msi','bat','cmd','ps1','vbs','js','jar','sh','app','dmg','pkg'],
  allowed jsonb not null default '{
    "full":  {"wav": "audio/wav", "mp3": "audio/mpeg"},
    "stems": {"zip": "application/zip"},
    "video": {"mp4": "video/mp4"},
    "zip":   {"zip": "application/zip"}
  }'::jsonb,
  updated_at timestamptz not null default now(),
  constraint upload_limits_single_row check (id = 1),
  constraint upload_limits_chunk_bytes_lt_50mib check (chunk_bytes > 0 and chunk_bytes < 52428800),
  constraint upload_limits_min_chunk check (min_chunk_bytes > 0 and min_chunk_bytes <= chunk_bytes),
  constraint upload_limits_threshold_lt_50mib check (single_object_threshold > 0 and single_object_threshold < 52428800),
  constraint upload_limits_positive check (
    max_file_bytes > 0 and session_ttl_seconds > 0 and max_attempts between 1 and 20
    and ticket_ttl_seconds between 30 and 7200 and ticket_batch_max between 1 and 64
    and max_open_sessions_per_user > 0 and max_total_upload_bytes > 0 and preview_max_bytes > 0
    and compress_max_bytes > 0 and zip_max_entries > 0 and zip_max_cd_bytes > 0
    and compress_min_saving >= 0 and compress_min_saving < 1
  ),
  constraint upload_limits_allowed_kinds check (
    jsonb_typeof(allowed) = 'object'
    and (allowed - array['full', 'stems', 'video', 'zip']) = '{}'::jsonb
  )
);

insert into public.upload_limits (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Sessions + chunks
-- ---------------------------------------------------------------------------
create table if not exists public.upload_sessions (
  id uuid primary key default gen_random_uuid(),
  origin text not null check (origin in ('beatbay_manager', 'studio_manager')),   -- which Edge Function created it
  beat_id uuid not null references public.beatbay_beats(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('full', 'stems', 'video', 'zip')),
  filename text not null check (char_length(filename) between 1 and 255),
  ext text not null,
  declared_mime text not null,
  encoding text not null default 'identity' check (encoding in ('identity', 'gzip')),
  original_bytes bigint check (original_bytes is null or original_bytes > 0),
  original_sha256 text check (original_sha256 is null or original_sha256 ~ '^[0-9a-f]{64}$'),
  total_bytes bigint not null check (total_bytes > 0),
  chunk_bytes integer not null check (chunk_bytes > 0 and chunk_bytes < 52428800),
  chunk_count integer not null check (chunk_count > 0),
  hash_mode text not null check (hash_mode in ('upfront', 'deferred')),
  head_sha256 text not null check (head_sha256 ~ '^[0-9a-f]{64}$'),
  file_sha256 text check (file_sha256 is null or file_sha256 ~ '^[0-9a-f]{64}$'),   -- client-declared, not server-verified
  manifest_root_sha256 text check (manifest_root_sha256 is null or manifest_root_sha256 ~ '^[0-9a-f]{64}$'),
  manifest_path text,
  status text not null default 'open'
    check (status in ('open', 'complete', 'verified', 'failed', 'expired', 'aborted', 'attached', 'replaced')),
  failure_code text,
  bucket text not null default 'release-private' check (bucket = 'release-private'),
  storage_prefix text not null,
  expires_at timestamptz not null,
  verified_at timestamptz,
  attached_at timestamptz,
  parts_purged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint upload_sessions_prefix_guard check (storage_prefix = 'uploads/' || id::text || '/'),
  constraint upload_sessions_manifest_guard check (manifest_path is null or manifest_path = 'uploads/' || id::text || '/manifest.json'),
  constraint upload_sessions_chunk_math check (chunk_count = ((total_bytes + chunk_bytes - 1) / chunk_bytes))
);

-- Resume/idempotency: one live session per (user, beat, kind, size, head hash, encoding, chunk size).
create unique index if not exists upload_sessions_resume_key
  on public.upload_sessions (created_by, beat_id, kind, total_bytes, head_sha256, encoding, chunk_bytes)
  where status in ('open', 'complete', 'verified');
create index if not exists upload_sessions_cleanup_idx on public.upload_sessions (status, expires_at);
create index if not exists upload_sessions_owner_idx on public.upload_sessions (created_by, status);
create index if not exists upload_sessions_beat_idx on public.upload_sessions (beat_id);

create table if not exists public.upload_chunks (
  session_id uuid not null references public.upload_sessions(id) on delete cascade,
  idx integer not null check (idx >= 0),
  bytes integer not null check (bytes > 0 and bytes < 52428800),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'ticketed', 'received', 'verified', 'bad')),
  attempts integer not null default 0 check (attempts >= 0),
  ticketed_at timestamptz,
  verified_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (session_id, idx),
  constraint upload_chunks_verified_has_hash check (status <> 'verified' or sha256 is not null)
);

-- Stems / video / zip attach target (beatbay_beats only has a full-master column).
create table if not exists public.beatbay_beat_assets (
  beat_id uuid not null references public.beatbay_beats(id) on delete cascade,
  kind text not null check (kind in ('stems', 'video', 'zip')),
  session_id uuid not null references public.upload_sessions(id) on delete restrict,
  bucket text not null default 'release-private' check (bucket = 'release-private'),
  manifest_path text not null check (manifest_path ~ '^uploads/[0-9a-f-]{36}/manifest\.json$'),
  filename text,
  total_bytes bigint,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (beat_id, kind)
);

-- ---------------------------------------------------------------------------
-- Lock down: service_role only.
-- ---------------------------------------------------------------------------
alter table public.upload_limits enable row level security;
alter table public.upload_sessions enable row level security;
alter table public.upload_chunks enable row level security;
alter table public.beatbay_beat_assets enable row level security;

revoke all on table public.upload_limits from public, anon, authenticated;
revoke all on table public.upload_sessions from public, anon, authenticated;
revoke all on table public.upload_chunks from public, anon, authenticated;
revoke all on table public.beatbay_beat_assets from public, anon, authenticated;

grant select, insert, update, delete on table public.upload_limits to service_role;
grant select, insert, update, delete on table public.upload_sessions to service_role;
grant select, insert, update, delete on table public.upload_chunks to service_role;
grant select, insert, update, delete on table public.beatbay_beat_assets to service_role;

-- ---------------------------------------------------------------------------
-- Free-plan storage budget (1 GB per project). Read-only; service_role only.
-- used_bytes: current objects (all buckets, or the given ones).
-- reserved_bytes: bytes still expected by live sessions (not yet verified).
-- ---------------------------------------------------------------------------
create or replace function public.upload_storage_usage(p_bucket_ids text[] default null)
returns table (used_bytes bigint, reserved_bytes bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce((
      select sum(coalesce((o.metadata ->> 'size')::bigint, 0))
      from storage.objects o
      where p_bucket_ids is null or o.bucket_id = any (p_bucket_ids)
    ), 0)::bigint as used_bytes,
    coalesce((
      select sum(greatest(s.total_bytes - coalesce(v.bytes, 0), 0))
      from public.upload_sessions s
      left join lateral (
        select sum(c.bytes)::bigint as bytes
        from public.upload_chunks c
        where c.session_id = s.id and c.status = 'verified'
      ) v on true
      where s.status in ('open', 'complete') and s.expires_at > now()
    ), 0)::bigint as reserved_bytes;
$$;

revoke all on function public.upload_storage_usage(text[]) from public, anon, authenticated;
grant execute on function public.upload_storage_usage(text[]) to service_role;

-- ---------------------------------------------------------------------------
-- Cleanup (hourly). Supabase blocks direct SQL deletes on storage.objects
-- (storage.protect_delete, "Use the Storage API instead"), and a SQL delete
-- would orphan the file anyway. So this function only:
--   1. marks live sessions past expires_at as 'expired' (tickets stop working);
--   2. deletes row metadata for sessions whose parts were already purged by
--      the Edge cleanup (Storage API) more than 7 days ago.
-- It never touches storage, never touches 'attached' sessions, and only rows
-- whose storage_prefix is under uploads/ (guard, also enforced by a CHECK).
-- Part deletion: beatbay-manager action cleanup_uploads (owner/admin) and a
-- bounded opportunistic pass inside every start_upload.
-- ---------------------------------------------------------------------------
create or replace function public.upload_sessions_expire()
returns table (expired_count integer, deleted_count integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expired integer := 0;
  v_deleted integer := 0;
begin
  update public.upload_sessions
     set status = 'expired', updated_at = now()
   where status in ('open', 'complete', 'verified')
     and expires_at < now()
     and storage_prefix like 'uploads/%';
  get diagnostics v_expired = row_count;

  delete from public.upload_sessions s
   where s.status in ('expired', 'failed', 'aborted', 'replaced')
     and s.parts_purged_at is not null
     and s.parts_purged_at < now() - interval '7 days'
     and s.storage_prefix like 'uploads/%'
     and not exists (select 1 from public.beatbay_beat_assets a where a.session_id = s.id);
  get diagnostics v_deleted = row_count;

  return query select v_expired, v_deleted;
end;
$$;

revoke all on function public.upload_sessions_expire() from public, anon, authenticated;
grant execute on function public.upload_sessions_expire() to service_role;

-- ---------------------------------------------------------------------------
-- music_activity_log: allow email_status = 'suppressed' for log-only upload
-- events (studio uploads email the Owner once per upload, on attach only).
-- Widening only; existing values unchanged.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.music_activity_log') is not null then
    alter table public.music_activity_log drop constraint if exists music_activity_log_email_status_check;
    alter table public.music_activity_log add constraint music_activity_log_email_status_check
      check (email_status in ('pending', 'sent', 'not_configured', 'failed', 'suppressed'));
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- release-private MIME allowlist: add video/mp4 (DEV ask f) and
-- application/json (manifest.json next to the parts). Idempotent. If the
-- bucket has no allowlist (null = everything allowed) it is left alone.
-- ---------------------------------------------------------------------------
update storage.buckets
   set allowed_mime_types = (
     select array_agg(distinct m order by m)
     from unnest(allowed_mime_types || array['video/mp4', 'application/json']) as m
   )
 where id = 'release-private'
   and allowed_mime_types is not null
   and not (allowed_mime_types @> array['video/mp4', 'application/json']);

commit;
