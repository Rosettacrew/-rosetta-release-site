# BeatBay non-exclusive checkout MVP

This slice enables one-time standard non-exclusive licenses only. Exclusive sales, ownership transfers, auctions, subscriptions, and carts remain disabled.

## Launch gates

Do not deploy or enable a BeatBay purchase until all of these are complete:

- Owner-approved license terms are published at a stable HTTPS URL.
- One launch beat has an approved price, a protected public preview, and a private full master stored under `beatbay/<beat-id>/full/`.
- The migration `20260914_beatbay_nonexclusive_checkout.sql` has been applied and verified.
- `beatbay-storefront`, `beatbay-checkout`, `stripe-beatbay-webhook`, and `beatbay-download` are deployed from the reviewed commit.
- `BEATBAY_STRIPE_RESTRICTED_KEY` is configured with only the Checkout permissions required to create Sessions. Start with an `rk_test_` key.
- `BEATBAY_STRIPE_WEBHOOK_SECRET` is configured for a dedicated endpoint subscribed to Checkout Session completion and asynchronous payment events.
- `RESEND_API_KEY` and `BEATBAY_LICENSE_EMAIL_FROM` are configured with a verified sender.
- No key, webhook secret, customer email, raw download token, or private storage path is committed or exposed to the browser.

Checkout is fail-closed. A beat is not purchasable until its status is `available`, storefront publishing and non-exclusive licensing are enabled, its canonical price is positive, its approved terms version and URL exist, and its private master path is valid.

## Controlled test

1. Configure test-mode Stripe and a test webhook endpoint.
2. Publish exactly one test beat with approved test terms and a private master.
3. Confirm the storefront shows **Buy license** only for that beat.
4. Complete one Stripe test purchase from a fresh browser session.
5. Confirm one order, one active license, and one processed webhook event were recorded with the canonical amount and terms snapshot.
6. Confirm the buyer receives the license number, terms link, and tokenized download link.
7. Confirm the private object is never public, the signed URL lasts 60 seconds, and the token stops after five downloads or 30 days.
8. Replay the same webhook and confirm it does not create a second order, license, or email.
9. Test canceled payment, invalid signature, altered metadata, expired token, exceeded download count, and unavailable beat behavior.
10. Reconcile the Stripe payment with the order and analytics/ledger record before considering live mode.

## Live rollout and rollback

Repeat the controlled test with one low-risk live purchase by the owner. Verify Stripe, webhook processing, receipt delivery, download, and reconciliation before advertising checkout.

To stop new purchases immediately, disable non-exclusive licensing or storefront publishing on the launch beat. Preserve orders, licenses, webhook records, and delivery logs for audit. Do not delete or rewrite a paid order. Refunds, disputes, and license revocation require a reviewed follow-up workflow before public launch volume increases.
