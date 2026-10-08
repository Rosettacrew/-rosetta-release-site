# Function deploy note

Do not deploy from this branch until a non-prod probe, a Craig score, and Owner approval.

Deploy named functions only after the migration `20261005_music_uploader_beat_update.sql` is applied on that same non-prod project. `studio-manager` calls `commit_music_uploader_beat_update`. Without the function, partner attach fails closed.

`supabase/config.toml` pins `verify_jwt = false` for:

| Function | Why |
| --- | --- |
| studio-manager | Handler checks the music_uploader bearer session. |
| release-manager | Handler checks bearer owner/admin/staff or `x-admin-key`. Live dashboard flag was not readable from this repo. Confirm it before deploy. |
| beatbay-manager | Handler checks owner/admin/staff and rejects publishable keys. |
| stripe-release-webhook | Production deploy used `--no-verify-jwt`. Stripe does not send a user JWT. |
| release-download | Production deploy used `--no-verify-jwt`. Buyers use a download token. |
| release-storefront | Production deploy used `--no-verify-jwt`. Public catalog read. |
| release-support-checkout | Production deploy used `--no-verify-jwt`. |

`release-email-worker` is not in this repo and is not pinned. See `docs/RELEASE-DELIVERY-READINESS.md`. Deploy it from the tree that contains its source.

Omitted functions stay at gateway `verify_jwt = true`.

No deploy. Requires non-prod probe + Craig score + Owner approval.
