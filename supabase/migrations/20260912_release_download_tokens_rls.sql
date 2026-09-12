-- RLS for release_download_tokens (service-role only).
-- Date: 2026-09-12
-- Table already exists live (used by release-download GET + stripe-release-webhook mint).
-- Pattern matches order_geo / release_product_assignees / release_artist_contacts:
-- enable RLS, revoke ALL from anon/authenticated (and public), grant to service_role.
-- No policies for anon/authenticated (deny-by-default). Webhook + release-download use service role.

alter table public.release_download_tokens enable row level security;

revoke all on table public.release_download_tokens from public, anon, authenticated;
grant select, insert, update, delete on table public.release_download_tokens to service_role;

-- No policies for anon/authenticated (intentional deny-by-default with RLS on + revoke).

comment on table public.release_download_tokens is
  'Opaque download tokens (SHA-256 hash only). Minted by stripe-release-webhook; redeemed by release-download GET. Service-role only.';
