-- Beatbox V1. Staging first. Do not apply to prod until Craig re-score + Owner sign-off.
--
-- Widen beatbay_beats_metadata_source_check so save_beat can store
-- metadata_source = 'beatbox'. Additive only: no other columns, grants, or rows.

begin;

alter table public.beatbay_beats
  drop constraint if exists beatbay_beats_metadata_source_check;

alter table public.beatbay_beats
  add constraint beatbay_beats_metadata_source_check
  check (metadata_source in ('manual', 'audio_assisted', 'beatbox'));

commit;
