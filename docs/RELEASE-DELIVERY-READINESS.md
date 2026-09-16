# Release delivery verification — September 16, 2026

Status: NOT ready for end-to-end fulfillment.

## Verified and repaired

- Rosetta Crew LLC live Stripe webhook is enabled for Checkout completed, async success and async failure.
- One EP order is recorded paid with a locked entitlement. No download token exists for that entitlement; no delivery log or sent email was found.
- Ten real MP3 tracks are attached to Love, Pain, Loyalty (EP). These are not a downloadable ZIP.
- Product release time is September 30, 2026 at 08:00 UTC / 04:00 America/New_York. Its existing entitlement previously used 04:00 UTC; aligned it to the product date.
- Existing five-minute cron unlocks entitlements. Updated it to check the current product release date, a paid matching order and an existing package before unlock.
- Deployed release-download v21 preserves deployed rate limiting and checks the current product release date and paid matching order before generating a storage URL.
- Handler tests cover early entitlement, unpaid/refunded/missing orders, locked access, expiry, missing package and valid paid redemption.
- Database transaction rehearsal covers future release, unpaid and missing-package denial plus paid/due/package unlock. All fixtures rolled back. No customer email or charge was generated.

## Required before launch

1. Confirm the intended release date/time. Current date was not changed.
2. Upload the final real ZIP using Release Station → Uploads → Love, Pain, Loyalty (EP) → Final ZIP package. The configured object does not exist. The only stored ZIPs found were two 275-byte sandbox fixtures; neither is suitable for customers. Check all ten tracks, their order, and artwork in the final ZIP.
3. Finish Resend domain verification for rosettacrew.com. Verification started during this check and remains pending. Required records are in the Resend domain dashboard.
4. Configure and verify the delivery worker runtime settings: RESEND_API_KEY, RELEASE_FROM_EMAIL, RELEASE_DOWNLOAD_BASE_URL and RELEASE_WORKER_SECRET. Their values were not accessed or confirmed. The webhook currently uses RELEASE_DOWNLOAD_EMAIL_FROM or ACTIVITY_EMAIL_FROM for its purchase email; confirm an approved verified sender there too.
5. Schedule the authenticated release-email-worker after unlock. Only the unlock cron exists; it does not invoke the worker. No scheduler credential is stored in Supabase Vault. Do not place credentials into repository files or browser code.
6. Harden the worker's retry/idempotency before scheduling: it currently mints a new token each attempt, does not atomically claim deliveries, and can resend when provider success is followed by a database failure. Verify package existence and paid order before sending. The webhook currently soft-fails email and skips retry if a token exists; do not mistake webhook success for email delivery.
7. Rehearse both preorder and post-release purchase paths in a separate test environment with an authorized test recipient: paid checkout → entitlement → locked before release → due unlock → delivered email → valid ZIP download. Check failed payments and duplicate webhook/worker runs. Do not charge a real card or advance the real EP date for testing.

## Current behavior

The webhook creates a locked entitlement for paid preorders and an available entitlement for paid purchases after the release time. Its optional purchase email contains a locked-until-release link. The worker supplies the release-ready email but is not scheduled. Secure download depends on the release's storage package; individual track uploads are not assembled into a ZIP automatically.

This audit does not establish successful live checkout-to-email-to-file delivery. Complete the blockers and rehearsal before declaring launch ready.
