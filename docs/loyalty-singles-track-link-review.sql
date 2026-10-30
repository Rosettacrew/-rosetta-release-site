-- REVIEW ONLY: run with authorized database change control; no schema or RLS changes.
-- Reuse the EP's approved audio objects; never duplicate media.
BEGIN;
INSERT INTO public.release_tracks
  (product_id, track_number, title, version, explicit, audio_bucket,
   audio_object_path, preview_bucket, preview_object_path,
   duration_seconds, is_downloadable, metadata)
SELECT p.id, 1, t.title, t.version, t.explicit, t.audio_bucket,
       t.audio_object_path, t.preview_bucket, t.preview_object_path,
       t.duration_seconds, true,
       jsonb_build_object('source_ep_track_id', t.id)
FROM public.release_products AS p
JOIN public.release_tracks AS t
  ON t.id::text = p.metadata ->> 'source_ep_track_id'
WHERE p.artist_name = 'DJ Loyalty Da Goat'
  AND p.status = 'draft'
  AND p.slug IN (
    'dj-loyalty-da-goat-loyal-to-a-fault',
    'dj-loyalty-da-goat-not-enough',
    'dj-loyalty-da-goat-i-m-him',
    'dj-loyalty-da-goat-you-broke-me',
    'dj-loyalty-da-goat-bad-for-you',
    'dj-loyalty-da-goat-nasty-remix',
    'dj-loyalty-da-goat-slow'
  )
  AND t.product_id = 'b05c0b7b-22af-441e-89b9-b722e93feceb'
  AND t.is_downloadable = true
  AND NOT EXISTS (
    SELECT 1 FROM public.release_tracks AS existing
    WHERE existing.product_id = p.id
  );
-- Verification should return exactly 7 rows, each with one downloadable track.
SELECT p.slug, COUNT(t.id) AS downloadable_tracks
FROM public.release_products AS p
LEFT JOIN public.release_tracks AS t
  ON t.product_id = p.id AND t.is_downloadable = true
WHERE p.status = 'draft' AND p.artist_name = 'DJ Loyalty Da Goat'
GROUP BY p.slug
ORDER BY p.slug;
COMMIT;
