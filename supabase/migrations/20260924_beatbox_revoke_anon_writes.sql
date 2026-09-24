-- Beatbox V1 staging lock. Do not apply this to production until Craig's
-- security pass and Owner sign-off. It does not rewrite existing rows.
--
-- Anon and authenticated PostgREST clients must not insert, update, or
-- delete BeatBay drafts or flip storefront/auction state. beatbay-manager
-- and studio-manager write with the service role after their own auth gates.
-- SELECT grants are left as they are so this migration does not blank a
-- catalog read that already exists outside this repo.

revoke insert, update, delete, truncate on table public.beatbay_beats from public, anon, authenticated;
revoke insert, update, delete, truncate on table public.beatbay_auctions from public, anon, authenticated;

grant select, insert, update, delete on table public.beatbay_beats to service_role;
grant select, insert, update, delete on table public.beatbay_auctions to service_role;
