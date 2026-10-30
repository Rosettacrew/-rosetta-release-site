# DJ Loyalty — seven singles: delivery QA and launch gate

Status: **HOLD — not authorized to publish based on database linkage alone.**

## Confirmed evidence (October 30, 2026)

- Owner-run read-only Supabase preflight: seven `READY: draft and source object validated` rows; source audio objects exist in `release-private`; products are drafts with `storefront_enabled=false`.
- Owner-run guarded track-link transaction: post-transaction audit returned seven rows, each with `downloadable_tracks=1`.
- Storefront feature branch: four regression tests passed. Draft PR #73 is not merged or deployed.
- Deployed `release-download` v28 checks hashed token, expiry, revocation, usage limit, entitlement availability, release time, and paid order before issuing a 60-second signed URL for one track. **Code review is not an end-to-end delivery test.**
- Deployed `stripe-release-webhook` v22 validates Stripe signature and mints tokens. Email sending is soft-fail: token minting does not prove email receipt.

## Required QA (all seven titles)

1. Keep all seven draft/unpublished. Do not create live Payment Links, merge, deploy, or change RLS as a shortcut.
2. Review each product's single `release_tracks` row for `track_number=1`, correct title, `is_downloadable=true`, `audio_bucket=release-private`, and exact equality to the original EP source path. Record only status and IDs, never secret keys or download tokens.
3. Confirm price 199 USD cents, artwork, artist, and release time for each product; keep the existing 'Even Though' single and EP unchanged.
4. In a **separate approved sandbox/test setup**, verify a signed Stripe `checkout.session.completed` event produces one paid order, one available entitlement, and a token for the correct product. Verify duplicate event handling and failed/unpaid payment rejection. Never fabricate paid orders in production.
5. Verify a test customer actually receives the Resend email. If email delivery fails, HOLD and repair the customer delivery/retry workflow before public launch; do not expose raw tokens in logs.
6. With a valid test entitlement and token, redeem a download and verify HTTP redirect to a short-lived private Storage signed URL and correct song/audio. Verify no-token, invalid-token, expired/revoked token, unpaid order, locked release, and download-limit failures. Use a separate test setup so production downloads and counts are unaffected.
7. Have Craig review the code, token/email flow, storage policies, payment mapping, rollback, and owner-only public approval. Record review result.
8. Only after all seven pass and owner explicitly approves publication: create/verify seven correctly mapped $1.99 live checkout links, validate the storefront's published data, merge/deploy through approved process, and monitor first order/delivery. Disclose any billable charges in advance and obtain owner approval.

## Per-song matrix

| Single | Database association | Sandbox payment | Email received | Authorized download | Craig review |
| --- | --- | --- | --- | --- | --- |
| Loyal To A Fault | 1 downloadable track | PENDING | PENDING | PENDING | PENDING |
| Not Enough | 1 downloadable track | PENDING | PENDING | PENDING | PENDING |
| I'm Him | 1 downloadable track | PENDING | PENDING | PENDING | PENDING |
| You Broke Me | 1 downloadable track | PENDING | PENDING | PENDING | PENDING |
| Bad For You | 1 downloadable track | PENDING | PENDING | PENDING | PENDING |
| Nasty (Remix) | 1 downloadable track | PENDING | PENDING | PENDING | PENDING |
| Slow | 1 downloadable track | PENDING | PENDING | PENDING | PENDING |

Do not mark a test PASS unless there is observed evidence. No public activation from this checklist alone.
