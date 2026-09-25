-- Issue #91 ROLLBACK. Not a migration (lives outside supabase/migrations on purpose).
-- Run manually on the same project only if the Issue #91 migration must be undone.
--
-- BEFORE running:
--   1. Delete part objects under release-private/uploads/ through the Storage API
--      (Dashboard or beatbay-manager cleanup_uploads). SQL cannot delete storage
--      objects on Supabase, and dropping the tables first would orphan them.
--   2. Any beat whose full_audio_path points at uploads/<id>/manifest.json must be
--      re-pointed or cleared first, or its master download will break.
-- Refuses to run while any beat still points at a chunked manifest.

begin;

do $$
begin
  if exists (select 1 from public.beatbay_beats where full_audio_path like 'uploads/%/manifest.json') then
    raise exception 'Beats still reference chunked masters (uploads/*/manifest.json). Re-point them first.';
  end if;
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'issue91-upload-sessions-expire') then
      perform cron.unschedule('issue91-upload-sessions-expire');
    end if;
  end if;
end;
$$;

drop function if exists public.upload_sessions_expire();
drop function if exists public.upload_storage_usage(text[]);
drop table if exists public.beatbay_beat_assets;
drop table if exists public.upload_chunks;
drop table if exists public.upload_sessions;
drop table if exists public.upload_limits;

-- Restore the original music_activity_log.email_status check (map log-only rows first).
do $$
begin
  if to_regclass('public.music_activity_log') is not null then
    update public.music_activity_log set email_status = 'not_configured' where email_status = 'suppressed';
    alter table public.music_activity_log drop constraint if exists music_activity_log_email_status_check;
    alter table public.music_activity_log add constraint music_activity_log_email_status_check
      check (email_status in ('pending', 'sent', 'not_configured', 'failed'));
  end if;
end;
$$;

-- Remove only the two MIME types this migration added.
update storage.buckets
   set allowed_mime_types = array(
     select m from unnest(allowed_mime_types) as m
     where m not in ('video/mp4', 'application/json')
   )
 where id = 'release-private'
   and allowed_mime_types is not null
   and allowed_mime_types && array['video/mp4', 'application/json'];

commit;
