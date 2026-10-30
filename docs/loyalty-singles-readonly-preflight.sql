-- READ ONLY preflight for DJ Loyalty's seven draft singles.
-- Run in an authorized Supabase SQL Editor session BEFORE the separate
-- track-link transaction. This query never modifies data or permissions.
WITH expected(slug) AS (
  VALUES
  ('dj-loyalty-da-goat-loyal-to-a-fault'),
  ('dj-loyalty-da-goat-not-enough'),
  ('dj-loyalty-da-goat-i-m-him'),
  ('dj-loyalty-da-goat-you-broke-me'),
  ('dj-loyalty-da-goat-bad-for-you'),
  ('dj-loyalty-da-goat-nasty-remix'),
  ('dj-loyalty-da-goat-slow')
), checks AS (
  SELECT e.slug,
    p.id AS product_id,
    p.status,
    p.storefront_enabled,
    p.artist_name,
    source.id AS source_track_id,
    source.title AS source_title,
    source.audio_bucket,
    source.audio_object_path,
    source.is_downloadable AS source_downloadable,
    (SELECT count(*) FROM public.release_tracks t WHERE t.product_id=p.id) AS linked_track_count,
    EXISTS (
      SELECT 1 FROM storage.objects obj
      WHERE obj.bucket_id=source.audio_bucket
        AND obj.name=source.audio_object_path
    ) AS audio_object_exists
  FROM expected e
  LEFT JOIN public.release_products p ON p.slug=e.slug
  LEFT JOIN public.release_tracks source
    ON source.id::text=p.metadata->>'source_ep_track_id'
   AND source.product_id='b05c0b7b-22af-441e-89b9-b722e93feceb'::uuid
)
SELECT slug, product_id, status, storefront_enabled, artist_name,
  source_track_id, source_title, audio_bucket, audio_object_path,
  source_downloadable, linked_track_count, audio_object_exists,
  CASE
    WHEN product_id IS NULL THEN 'HOLD: product missing'
    WHEN status <> 'draft' OR storefront_enabled IS DISTINCT FROM false
      THEN 'HOLD: not unpublished draft'
    WHEN artist_name IS DISTINCT FROM 'DJ Loyalty Da Goat'
      THEN 'HOLD: artist mismatch; inspect exact spelling'
    WHEN source_track_id IS NULL THEN 'HOLD: source EP track missing'
    WHEN audio_bucket IS DISTINCT FROM 'release-private'
      OR audio_object_path IS NULL OR audio_object_path=''
      OR source_downloadable IS DISTINCT FROM true
      THEN 'HOLD: invalid source audio'
    WHEN NOT audio_object_exists THEN 'HOLD: source audio object missing'
    WHEN linked_track_count > 0 THEN 'REVIEW: existing tracks; verify linkage before rerun'
    ELSE 'READY: draft and source object validated'
  END AS preflight_result
FROM checks ORDER BY slug;

-- Gate: do not proceed to payment links or publication until all seven
-- rows are READY or verified already-linked, and authenticated signed
-- downloads have been tested for each product.
