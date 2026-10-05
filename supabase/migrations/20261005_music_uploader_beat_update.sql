-- Conditional music_uploader beat asset write.
-- Do not apply to production until a non-prod probe, Craig score, and Owner approval.
--
-- NULL storefront_enabled is off the storefront. coalesce(storefront_enabled, false)
-- = false lets a draft with a NULL flag through and rejects a true flag. This
-- matches the publish guard, which also treats NULL as not enabled.
--
-- One UPDATE is the boundary: id, status draft, storefront off, and an assignee
-- row for the caller. PostgREST cannot filter this UPDATE on beatbay_beat_assignees.
-- Executable only by service_role. search_path is empty so names cannot be redirected.

create or replace function public.commit_music_uploader_beat_update(
  p_beat_id uuid,
  p_user_id uuid,
  p_changes jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated jsonb;
  duration_type text;
begin
  if p_beat_id is null or p_user_id is null or pg_catalog.jsonb_typeof(p_changes) is distinct from 'object' then
    return null;
  end if;

  -- Cast preview_duration_seconds to the live column type. The table DDL is not
  -- in this repo. Only integer, numeric, and float types are allowed. The name
  -- comes from pg_catalog, not from p_changes.
  select c.typname into duration_type
  from pg_catalog.pg_attribute a
  join pg_catalog.pg_class t on t.oid = a.attrelid
  join pg_catalog.pg_namespace n on n.oid = t.relnamespace
  join pg_catalog.pg_type c on c.oid = a.atttypid
  where n.nspname = 'public'
    and t.relname = 'beatbay_beats'
    and a.attname = 'preview_duration_seconds'
    and a.attnum > 0
    and not a.attisdropped;

  if duration_type is null or duration_type not in ('int2', 'int4', 'int8', 'numeric', 'float4', 'float8') then
    raise exception 'preview_duration_seconds column type is not supported';
  end if;

  execute pg_catalog.format(
    $sql$
    update public.beatbay_beats b
    set
      preview_url = case
        when $1 ? 'preview_url' then $1->>'preview_url'
        else b.preview_url
      end,
      preview_duration_seconds = case
        when $1 ? 'preview_duration_seconds' then ($1->>'preview_duration_seconds')::%s
        else b.preview_duration_seconds
      end,
      full_audio_bucket = case
        when $1 ? 'full_audio_bucket' then $1->>'full_audio_bucket'
        else b.full_audio_bucket
      end,
      full_audio_path = case
        when $1 ? 'full_audio_path' then $1->>'full_audio_path'
        else b.full_audio_path
      end,
      updated_at = pg_catalog.now()
    where b.id = $2
      and b.status = 'draft'
      and coalesce(b.storefront_enabled, false) = false
      and exists (
        select 1
        from public.beatbay_beat_assignees a
        where a.beat_id = $2
          and a.user_id = $3
      )
    returning pg_catalog.jsonb_build_object(
      'id', b.id,
      'beat_code', b.beat_code,
      'title', b.title,
      'preview_url', b.preview_url,
      'full_audio_bucket', b.full_audio_bucket,
      'full_audio_path', b.full_audio_path,
      'status', b.status,
      'storefront_enabled', b.storefront_enabled
    )
    $sql$,
    duration_type
  )
  into updated
  using p_changes, p_beat_id, p_user_id;

  return updated;
end;
$$;

revoke all on function public.commit_music_uploader_beat_update(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.commit_music_uploader_beat_update(uuid, uuid, jsonb) to service_role;

comment on function public.commit_music_uploader_beat_update(uuid, uuid, jsonb) is
  'service_role music_uploader beat asset write. NULL storefront_enabled counts as false. Zero matching rows return null.';
