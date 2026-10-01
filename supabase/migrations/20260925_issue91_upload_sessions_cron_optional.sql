-- Issue #91 OPTIONAL: hourly schedule for public.upload_sessions_expire().
-- Apply ONLY if pg_cron is enabled on the target project (Dashboard > Database >
-- Extensions). pg_cron is available on the Free plan but is not enabled by default,
-- and this PR must not change dashboard settings. If pg_cron is not enabled, skip
-- this file: start_upload still runs a bounded cleanup pass and owners can call
-- beatbay-manager { action: "cleanup_uploads" }.
--
-- The scheduled SQL only marks expired sessions and deletes already-purged row
-- metadata. It never deletes storage objects (Supabase blocks that from SQL) and
-- never touches anything outside uploads/ or any attached session.
-- NON-PROD DRY-RUN FIRST. Requires Craig review + Owner approval.

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron is not enabled; skipping issue91 cleanup schedule.';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'issue91-upload-sessions-expire') then
    perform cron.unschedule('issue91-upload-sessions-expire');
  end if;
  perform cron.schedule('issue91-upload-sessions-expire', '17 * * * *', 'select public.upload_sessions_expire();');
end;
$$;
