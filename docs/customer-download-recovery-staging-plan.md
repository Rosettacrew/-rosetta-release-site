# Customer download recovery — staging design

Tracking: [issue #74](https://github.com/Rosettacrew/-rosetta-release-site/issues/74). This document is a design, **not deployed functionality**.

## Existing controls to reuse

- `release-admin-data/index.ts` has an `isOwner` guard: bearer JWT validated with Supabase Auth and an active `release_admin_users` record with owner/admin role. Use equivalent authorization for any administrative recovery endpoint; do not trust client-supplied roles.
- `stripe-release-webhook/index.ts` verifies Stripe signatures and only grants paid entitlements; its `failDelivery` path revokes a freshly minted token and returns failure when Resend request fails.
- `release-download/index.ts` validates token hash, expiry, revocation, download limit, and paid entitlement before serving private audio.

## Recovery API design for Craig review

1. Prefer an owner/admin-only support endpoint initially, with no public self-service endpoint. Require bearer JWT, active owner/admin role, and an explicit entitlement/order identifier. Validate the paid Stripe order server-side, product and entitlement ownership, order status, release state, and recipient address. Never accept a user-supplied arbitrary destination email.
2. Rate-limit per administrator and entitlement. Record a nonsecret audit trail of request ID, actor, entitlement, timestamp, outcome. Generic errors prevent order/email enumeration.
3. Use a database transaction or RPC with locking to serialize reissues for an entitlement. Atomically revoke previous usable tokens and insert the hash of a newly generated cryptographically random token. Keep raw token only in the request process memory until delivery submission; never persist, log, return, or place it in issue/Notion text.
4. Send the new link to the verified email via Resend. On API rejection, revoke the new token and report failure without leaving a usable but undelivered token. Distinguish API acceptance from final inbox delivery; record nonsecret provider message ID/status and support a verified escalation path for bounce or inaccessible email.
5. Confirm policy for refunds, disputes, release locks, reissue limits and support identity verification with Craig before coding. Avoid changes to live payment links, existing EP and Even Though prices, or draft publication flags.

## Sandbox acceptance matrix

| Case | Expected |
|---|---|
| Paid order, valid admin, verified recipient | One replacement link sent, previous link revoked |
| Unpaid, refunded, disputed, draft or unknown order | No token issued; no private data exposed |
| Missing/invalid admin JWT or inactive role | 401/403, no mutation |
| Resend missing/rejects/times out | New token revoked; auditable failure |
| Resend accepts but email bounces | Support recovery path, no public token disclosure |
| Duplicate and simultaneous reissue requests | Serialized or idempotent, no two active replacement links |
| Expired/revoked/max-download token | Denied by download endpoint |
| Release date in future | No early download |
| Wrong recipient, brute-force enumeration | Denied/rate-limited; generic response |
| Logs and errors | No raw token, Stripe secret, API key or PII leak |

## Gates

- Implement on draft/staging branch only after Craig reviews design.
- Add isolated automated tests, run GitHub CI, and test Stripe test-mode + Resend test recipient + private signed download in sandbox.
- Owner approval is required before merge, deploy, live Stripe changes, new spending, or production secrets changes.
