-- Partner BeatBay / auction assignment (mirrors release_product_assignees).
-- music_uploader may upload preview/full audio only for assigned beats.
-- Storefront publish, featured, auction go-live, and finance stay owner-only.

create table if not exists public.beatbay_beat_assignees (
  beat_id uuid not null references public.beatbay_beats(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  assigned_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (beat_id, user_id)
);

create index if not exists beatbay_beat_assignees_user_idx
  on public.beatbay_beat_assignees (user_id);

alter table public.beatbay_beat_assignees enable row level security;
revoke all on table public.beatbay_beat_assignees from public, anon, authenticated;
grant select, insert, update, delete on table public.beatbay_beat_assignees to service_role;

comment on table public.beatbay_beat_assignees is
  'Maps music_uploader accounts to BeatBay beats (including auction beats) they may upload audio for. Enforced by studio-manager.';
