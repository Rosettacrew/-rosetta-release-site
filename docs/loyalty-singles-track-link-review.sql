-- REVIEW ONLY. Execute through an authorized, audited database session.
-- Atomic, idempotent association of seven draft singles to their original EP masters.
-- No media copies, public access grants, schema changes, or publishing.
BEGIN;

DO $$
DECLARE
  expected_slugs text[] := ARRAY[
    'dj-loyalty-da-goat-loyal-to-a-fault',
    'dj-loyalty-da-goat-not-enough',
    'dj-loyalty-da-goat-i-m-him',
    'dj-loyalty-da-goat-you-broke-me',
    'dj-loyalty-da-goat-bad-for-you',
    'dj-loyalty-da-goat-nasty-remix',
    'dj-loyalty-da-goat-slow'
  ];
  matching_products integer;
  valid_sources integer;
  invalid_existing integer;
  final_valid integer;
BEGIN
  SELECT count(*) INTO matching_products
  FROM public.release_products p
  WHERE p.slug = ANY(expected_slugs)
    AND p.artist_name = 'DJ Loyalty Da Goat'
    AND p.status = 'draft'
    AND p.storefront_enabled = false;
  IF matching_products <> 7 THEN
    RAISE EXCEPTION 'Expected seven unpublished draft singles; found %', matching_products;
  END IF;

  SELECT count(*) INTO valid_sources
  FROM public.release_products p
  JOIN public.release_tracks t
    ON t.id::text = p.metadata->>'source_ep_track_id'
   AND t.product_id = 'b05c0b7b-22af-441e-89b9-b722e93feceb'::uuid
  WHERE p.slug = ANY(expected_slugs)
    AND p.status = 'draft'
    AND t.is_downloadable = true
    AND t.audio_bucket = 'release-private'
    AND t.audio_object_path IS NOT NULL
    AND t.audio_object_path <> ''
    AND trim(t.title) <> '';
  IF valid_sources <> 7 THEN
    RAISE EXCEPTION 'Expected seven valid source EP tracks; found %', valid_sources;
  END IF;

  SELECT count(*) INTO invalid_existing
  FROM public.release_products p
  JOIN public.release_tracks existing ON existing.product_id = p.id
  LEFT JOIN public.release_tracks source
    ON source.id::text = p.metadata->>'source_ep_track_id'
   AND source.product_id = 'b05c0b7b-22af-441e-89b9-b722e93feceb'::uuid
  WHERE p.slug = ANY(expected_slugs)
    AND (existing.track_number <> 1
         OR existing.audio_object_path IS DISTINCT FROM source.audio_object_path
         OR existing.audio_bucket IS DISTINCT FROM source.audio_bucket
         OR existing.is_downloadable IS DISTINCT FROM true);
  IF invalid_existing <> 0 THEN
    RAISE EXCEPTION 'Existing single track association conflicts with source EP';
  END IF;

  INSERT INTO public.release_tracks
    (product_id, track_number, title, version, explicit, audio_bucket,
     audio_object_path, preview_bucket, preview_object_path,
     duration_seconds, is_downloadable, metadata)
  SELECT p.id, 1, t.title, t.version, t.explicit, t.audio_bucket,
         t.audio_object_path, t.preview_bucket, t.preview_object_path,
         t.duration_seconds, true,
         jsonb_build_object('source_ep_track_id', t.id)
  FROM public.release_products p
  JOIN public.release_tracks t ON t.id::text = p.metadata->>'source_ep_track_id'
  WHERE p.slug = ANY(expected_slugs)
    AND p.status = 'draft'
    AND t.product_id = 'b05c0b7b-22af-441e-89b9-b722e93feceb'::uuid
    AND t.is_downloadable = true
    AND NOT EXISTS (SELECT 1 FROM public.release_tracks e WHERE e.product_id = p.id);

  SELECT count(*) INTO final_valid
  FROM public.release_products p
  JOIN public.release_tracks t ON t.product_id = p.id
  JOIN public.release_tracks source
    ON source.id::text = p.metadata->>'source_ep_track_id'
   AND source.product_id = 'b05c0b7b-22af-441e-89b9-b722e93feceb'::uuid
  WHERE p.slug = ANY(expected_slugs)
    AND t.track_number = 1
    AND t.is_downloadable = true
    AND t.audio_bucket = source.audio_bucket
    AND t.audio_object_path = source.audio_object_path
    AND (SELECT count(*) FROM public.release_tracks other WHERE other.product_id = p.id) = 1;
  IF final_valid <> 7 THEN
    RAISE EXCEPTION 'Atomic verification failed: only % of seven singles correctly linked', final_valid;
  END IF;
END $$;

COMMIT;

-- Post-commit read-only audit. Physical object existence and signed download
-- must also be verified before Stripe links are activated or products published.
SELECT p.slug, count(t.id) AS downloadable_tracks
FROM public.release_products p
LEFT JOIN public.release_tracks t ON t.product_id = p.id AND t.is_downloadable = true
WHERE p.slug IN (
  'dj-loyalty-da-goat-loyal-to-a-fault','dj-loyalty-da-goat-not-enough',
  'dj-loyalty-da-goat-i-m-him','dj-loyalty-da-goat-you-broke-me',
  'dj-loyalty-da-goat-bad-for-you','dj-loyalty-da-goat-nasty-remix',
  'dj-loyalty-da-goat-slow'
)
GROUP BY p.slug ORDER BY p.slug;
