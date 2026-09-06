-- Live Storefront On raises P0001:
--   Publish blocked: artwork must pass validation before release.
-- That exact string is not in prior repo migrations; it lives in a
-- Postgres trigger/function on the hosted DB. This migration finds that
-- guard by the message, replaces it with a digital_product-safe rule, and
-- does not UPDATE Come Here / EP (or any other product rows).
--
-- Ready rule (same for single / ep / album / beat / digital_product):
--   cover_art_path is a non-empty JPG/PNG/WebP object
--   cover_art_bucket is release-public (null/blank treated as that default)
-- Extra moderation flags, checksums, and stored pixel columns are NOT
-- required. Client UI still enforces 3000 × 3000 before upload.
--
-- Extension checks use LIKE, not ~*. A POSIX pattern like
--   btrim(p_path) ~* '\.(jpe?g|png|webp)$'
-- is stored/compiled (Postgres string + ARE escaping) as requiring a
-- literal backslash before the suffix, so a valid Sandbox cover such as
--   42e87b92-353b-479f-8b95-0d56799bd6e5/cover/cover-85e71111-eaa5-43a9-99d9-78acb0106cd9.png
-- on release-public returned false and Storefront On raised P0001.

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
  'Storefront artwork gate: release-public JPG/PNG/WebP path. Used by the publish trigger that raises P0001 Publish blocked: artwork must pass validation before release.';

revoke all on function public.release_artwork_ready_for_storefront(text, text) from public, anon, authenticated;
grant execute on function public.release_artwork_ready_for_storefront(text, text) to service_role;

create or replace function public.release_products_artwork_publish_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if coalesce(new.storefront_enabled, false)
      and not public.release_artwork_ready_for_storefront(new.cover_art_path, new.cover_art_bucket)
    then
      raise exception 'Publish blocked: artwork must pass validation before release.';
    end if;
    return new;
  end if;

  -- Already-live rows (Come Here / EP) keep passing on unrelated updates.
  if coalesce(new.storefront_enabled, false)
    and coalesce(old.storefront_enabled, false)
    and new.cover_art_path is not distinct from old.cover_art_path
    and new.cover_art_bucket is not distinct from old.cover_art_bucket
  then
    return new;
  end if;

  if coalesce(new.storefront_enabled, false)
    and not public.release_artwork_ready_for_storefront(new.cover_art_path, new.cover_art_bucket)
  then
    raise exception 'Publish blocked: artwork must pass validation before release.';
  end if;

  return new;
end;
$$;

comment on function public.release_products_artwork_publish_guard() is
  'BEFORE INSERT/UPDATE guard. Raises P0001 Publish blocked: artwork must pass validation before release. when Storefront On is set without a release-public cover path. Does not rewrite existing rows.';

revoke all on function public.release_products_artwork_publish_guard() from public, anon, authenticated;

do $$
declare
  rec record;
  src text;
begin
  for rec in
    select c.relname as table_name, t.tgname, p.proname, n.nspname
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid
    where not t.tgisinternal
      and p.prosrc ilike '%Publish blocked: artwork must pass validation before release%'
      and p.oid <> 'public.release_products_artwork_publish_guard()'::regprocedure
  loop
    execute format('drop trigger if exists %I on %I.%I', rec.tgname, rec.nspname, rec.table_name);
    raise notice 'Dropped leftover artwork publish trigger %.% on %.%',
      rec.nspname, rec.tgname, rec.nspname, rec.table_name;
  end loop;

  for rec in
    select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosrc
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.prosrc ilike '%Publish blocked: artwork must pass validation before release%'
      and p.oid <> 'public.release_products_artwork_publish_guard()'::regprocedure
      and p.prokind = 'f'
  loop
    src := left(rec.prosrc, 800);
    raise notice 'Left in place unused artwork function %.%(%) — source starts: %',
      rec.nspname, rec.proname, rec.args, src;
  end loop;

  if not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'release_products'
      and t.tgname = 'release_products_artwork_publish_guard'
      and not t.tgisinternal
  ) then
    execute $t$
      create trigger release_products_artwork_publish_guard
        before insert or update on public.release_products
        for each row
        execute procedure public.release_products_artwork_publish_guard()
    $t$;
  end if;
end
$$;
