-- Owner audit trail for Release Station, BeatBay, and Music Studio Portal.
-- Role + assignee schema lives in 20260905_music_studio_uploader_role.sql.

create table if not exists public.music_activity_log (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_email text,
  actor_role text not null,
  surface text not null check (surface in ('release_station', 'beatbay', 'studio')),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  summary text not null,
  details jsonb not null default '{}'::jsonb,
  email_status text not null default 'pending'
    check (email_status in ('pending', 'sent', 'not_configured', 'failed')),
  email_sent_at timestamptz,
  email_error text,
  created_at timestamptz not null default now()
);

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'music_activity_log_surface_check'
  ) then
    alter table public.music_activity_log
      drop constraint music_activity_log_surface_check;
    alter table public.music_activity_log
      add constraint music_activity_log_surface_check
      check (surface in ('release_station', 'beatbay', 'studio'));
  end if;
end $$;

create index if not exists music_activity_log_created_at_idx
  on public.music_activity_log (created_at desc);

create index if not exists music_activity_log_actor_idx
  on public.music_activity_log (actor_user_id, created_at desc);

alter table public.music_activity_log enable row level security;
revoke all on table public.music_activity_log from anon, authenticated;
grant select, insert, update on table public.music_activity_log to service_role;

comment on table public.music_activity_log is
  'Owner-only audit trail for Release Station, BeatBay, and Music Studio Portal. Partners cannot read this table; studio-manager writes partner events.';
