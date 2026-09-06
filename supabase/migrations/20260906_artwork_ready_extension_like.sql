-- Hotfix for release_artwork_ready_for_storefront after
-- 20260905_artwork_validation_publish_guard.sql. The live helper used
--   btrim(p_path) ~* '\.(jpe?g|png|webp)$'
-- which (Postgres string / ARE escaping) requires a literal backslash
-- before the extension. Valid Sandbox cover
--   42e87b92-353b-479f-8b95-0d56799bd6e5/cover/cover-85e71111-eaa5-43a9-99d9-78acb0106cd9.png
-- on bucket release-public therefore returned false and a rolled-back
-- UPDATE storefront_enabled=true raised P0001.
-- Come Here / EP already storefront-enabled, so they bypass via the
-- old/new both-enabled short-circuit. Do not UPDATE product rows.

create or replace function public.release_artwork_ready_for_storefront(
  p_path text,
  p_bucket text
) returns boolean
language sql
immutable
as $$
  select
    nullif(btrim(coalesce(p_path, '')), '') is not null
    and coalesce(nullif(btrim(coalesce(p_bucket, '')), ''), 'release-public') = 'release-public'
    and (
      lower(btrim(p_path)) like '%.jpg'
      or lower(btrim(p_path)) like '%.jpeg'
      or lower(btrim(p_path)) like '%.png'
      or lower(btrim(p_path)) like '%.webp'
    )
$$;

comment on function public.release_artwork_ready_for_storefront(text, text) is
  'Storefront artwork gate: release-public JPG/PNG/WebP path (LIKE suffix, not regex). Used by the publish trigger that raises P0001 Publish blocked: artwork must pass validation before release.';

revoke all on function public.release_artwork_ready_for_storefront(text, text) from public, anon, authenticated;
grant execute on function public.release_artwork_ready_for_storefront(text, text) to service_role;
