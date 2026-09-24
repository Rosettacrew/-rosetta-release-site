# Beatbox V1

Internal admin intake for BeatBay. Beatbox is not a customer page. It does not replace BeatBay Admin’s single-file upload, and it does not change the public BeatBay storefront except through the existing owner/admin publish action.

**Not for production until Craig’s security pass and Owner sign-off. Do not merge this branch to `main`. Do not deploy `beatbay-manager` and do not apply `supabase/migrations/20260924_beatbox_revoke_anon_writes.sql` on production from this PR.**

## Scope for BoB

Beatbox V1 is the BeatBay beat path only:

- Page: `beatbox.html`
- API: `supabase/functions/beatbay-manager`
- Objects: `beatbay/{id}/…` in `release-private` (quarantine and full master) and `release-public` (preview only after validation passes)
- Actions reused: `save_beat`, `create_upload`, `attach_asset`, `set_storefront`

It does not build a Release Station product ZIP, and it does not call `release-manager`. Customer `beatbay/index.html` is unchanged.

## Package contract

A producer ZIP should look like this:

```text
beat.zip
  audio/preview.mp3    required preview, or a single MP3/WAV at the ZIP root
  audio/full.wav       optional master (full.wav or master.wav)
  cover.jpg            optional jpg, png, or webp
  beat.json            optional sidecar (metadata.json is also accepted)
```

`beat.json` fields that Beatbox reads:

```json
{
  "title": "Night Drive",
  "beat_code": "BEAT 0007",
  "bpm": 140,
  "style": "Trap",
  "key": "F minor",
  "tags": ["trap", "dark"],
  "description": "Late night keys."
}
```

Rules:

- `.zip` only, 100 MB maximum for the archive.
- At least one `.mp3` or `.wav`. A single audio file is the preview, including one MP3 sitting at the ZIP root.
- At most two audio files. If there are two, one must be identifiable as the preview (`preview.mp3` / `preview.wav`) or the other must be identifiable as the master (`full.wav`, `full.mp3`, `master.wav`, `master.mp3`).
- One optional cover: `.jpg`, `.jpeg`, `.png`, or `.webp`, 8 MB maximum. Beatbox shows it on the review screen only. BeatBay listings keep the existing branded player art. V1 does not upload the cover, because `beatbay_beats` has no cover column.
- One optional sidecar, 64 KB maximum: `beat.json` or `metadata.json`.
- Other files are rejected, including executables, scripts, PDFs, and nested `.zip` files.
- `__MACOSX/`, `.DS_Store`, `Thumbs.db`, and `desktop.ini` are ignored.
- Each audio file must be 80 MB or smaller. Total declared uncompressed size must be 250 MB or smaller. Compression ratio above 500:1 is rejected.
- Empty archives are rejected.

## What the review screen does

1. Sidecar title, beat number, BPM, style, key, tags, and description fill the form. The person can edit every field before saving.
2. Filename BPM, style, and key are suggestions. Listening for tempo is also a suggestion. Neither is written into the form until **Apply suggestions**.
3. Default license: non-exclusive on at **$30.00**. Exclusive and ownership stay off unless the person opts in.
4. **Save draft** creates or updates a `beatbay_beats` row with `status: draft`, `metadata_source: beatbox`, and `storefront_enabled: false`, then uploads the preview (and master, if present) through the existing `create_upload` + `attach_asset` actions.
5. **Approve & publish** is separate. An owner or admin must check “I reviewed this listing and want it live on BeatBay”, then the page saves the listing as Available and calls the existing `set_storefront` action with `enabled: true`. Staff can prepare the draft. Staff cannot publish; `set_storefront` still returns owner/admin only.

Preview audio goes to `release-public` at `beatbay/{id}/preview/…`. The master goes to `release-private` at `beatbay/{id}/full/…`.

## Why unzip runs in the browser

V1 uses [JSZip 3.10.1](https://esm.sh/jszip@3.10.1) in the admin’s browser. The Edge function never receives the ZIP. Central-directory checks run before any entry is inflated. Only entries that stay inside the logical prefix `beatbox-sandbox/{canonical path}` are inflated, and only after magic bytes match the extension.

JSZip rewrites dangerous names (`../evil.mp3` becomes `evil.mp3`) and keeps the original on `unsafeOriginalName`. Beatbox rejects the original name. A stored name that does not canonicalize to that same relative path is rejected as a sandbox escape. Absolute paths, empty segments, and `..` are rejected. Symbolic links are rejected when the ZIP stores UNIX mode `0120000`. Extracted length must match the central-directory size.

The bytes then go to a **private quarantine** object, not the public preview path. `attach_asset` with `intake: "beatbox"` downloads that object, checks size and magic bytes again, copies a passing preview to `release-public` at `beatbay/{id}/preview/…` or a passing master to `release-private` at `beatbay/{id}/full/…`, and deletes the quarantine object. The client-supplied `Content-Type` and `public_url` are not trusted. The promote step sets the content type from the magic-byte result.

## Craig HOLD map

| Hold | Where it stands |
| --- | --- |
| 1. Admin-only auth | `beatbay-manager` has no public write route. Missing, publishable, anon, or secret keys fail closed with **401** before `getUser`. A signed-in user who is not active `owner`, `admin`, or `staff` gets **403**. `music_uploader` stays excluded. |
| 2. No auto-publish | `save_beat` cannot set `storefront_enabled`. Beatbox Approve sends `set_storefront` only with `intake: "beatbox"` and `confirm_publish: true`. The server rejects that call without the flag. Staff cannot publish. |
| 3. ZIP defenses before extract | 100 MB ZIP, 40 entries, 250 MB declared uncompressed total, 500:1 compression-ratio cap, `..` and absolute paths rejected, inflate only under `beatbox-sandbox/…`, symlink mode rejected. |
| 4. Allowlist plus magic bytes | MP3, WAV, one JPG/PNG/WebP, one JSON sidecar. Extension must match magic bytes (`ID3` or MP3 frame sync, `RIFF`/`WAVE`, JPEG, PNG, WebP, JSON object). `MZ`, ELF, shebang, Mach-O, and `<script` / `<?php` in the first 1 KB are rejected. Content-Type is not the check. |
| 5. Secrets | Service role, Stripe, and Resend stay in Edge environment variables. They are not in `beatbox.html`, `beatbox/package-rules.mjs`, or `beatbox-guard.mjs`. The page only has the same publishable key BeatBay Admin already ships. |
| 6. RLS / API | Anon cannot call the manager. Migration `20260924_beatbox_revoke_anon_writes.sql` revokes `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE` on `beatbay_beats` and `beatbay_auctions` from `public`, `anon`, and `authenticated`, and grants those writes to `service_role`. |
| 7. Payment perimeter | No Stripe webhook, checkout, or order code is changed. |
| 8. Storage | Beatbox audio is uploaded to private `release-private/beatbay/{id}/quarantine/…` and promoted only after magic PASS. Full masters stay private. Download URLs for full masters remain 300 seconds. Quarantine upload signing requests `expiresIn: 120`. |
| 9. Staging first | This PR does not merge and does not deploy. Apply the migration and the function on a test project only. |
| 10. Logging | Edge `console.error` and stored Resend `email_error` go through `redactLog` (bearer tokens, JWTs, key prefixes, emails). |

### Residuals Craig should still score

- A ZIP central directory that **lies low** about uncompressed size can still make the admin’s browser allocate memory during inflate. The public bucket does not receive those bytes unless the later server size and magic checks pass. Encrypted ZIPs fail closed when JSZip refuses them.
- Symlink detection needs the UNIX mode bit. Windows ZIPs often omit it. Path canonicalization is the backstop.
- `@supabase/storage-js` 2.12.1 cannot set an upload TTL. Beatbox calls the Storage sign endpoint with `expiresIn: 120`. If that deployed Storage API rejects the field, the function retries without it and returns `expires_in: null`. In that case the platform default (about two hours) remains, on a **private** object that is not linked to the beat until `attach_asset` passes.
- The manual BeatBay Admin single-file upload is unchanged and is not quarantined. Only `intake: "beatbox"` uses quarantine.
- The activity table still stores the actor email for the owner audit report. That is the audit row, not stdout.
- This repo does not contain the original `beatbay_beats` `CREATE` or its policies. The new migration revokes write grants. It does not enable RLS and does not revoke `SELECT`, so a catalog read that already works is left alone. Run the dry-run probes on staging before calling that hold closed.
- An owner can still publish from the existing BeatBay Admin storefront switch. That switch is a separate human click on `set_storefront` and does not send `intake: "beatbox"`. Beatbox itself cannot publish without `confirm_publish: true`.

## SECURITY-DRYRUN

Run these on a **staging** project. Do not point them at production. Record status codes and bodies with tokens redacted.

### Auth negatives

1. `POST /functions/v1/beatbay-manager` with no `Authorization` and body `{"action":"save_beat"}`. Expect **401**.
2. Same call with `Authorization: Bearer <publishable key>` and `apikey` set to that same key. Expect **401**.
3. Same call with the anon JWT, if the project still has one. Expect **401**.
4. Signed-in user who is not an active row in `release_admin_users`. Expect **403**.
5. Active `staff` calls `set_storefront` with `enabled: true`. Expect **403** `Owner approval required`.
6. Active `music_uploader` calls `save_beat`. Expect **403**.
7. `OPTIONS` may return 200. It must not insert a beat or return a signed upload URL.

### Upload negatives

8. ZIP with `../secret.mp3` or `audio/../../x.wav`. Expect a path error and no storage object.
9. ZIP whose central directory shows uncompressed/compressed above 500:1 (a `preview.mp3` made of zeros, a few megabytes, zipped). Expect the ratio error before review.
10. ZIP larger than 100 MB. Expect the size error before unzip.
11. More than 40 real files. Expect the entry-count error.
12. `payload.exe`, or `preview.mp3` whose first bytes are `MZ` or `#!/bin/sh`. Expect rejection and no promote.
13. `.wav` whose first bytes are ELF, or `.mp3` whose bytes are a JPEG. Expect a magic-byte error.
14. `beat.json` containing `<script`. Expect the polyglot error.
15. After a real draft id exists, `create_upload` with `intake: "beatbox"` must return `bucket: "release-private"`, `quarantine: true`, and `public_url: null`.
16. `attach_asset` with `intake: "beatbox"` and a path outside `beatbay/{id}/quarantine/{uuid}.mp3` (for example `../preview/x.mp3` or a public preview path). Expect **400**.
17. `save_beat` with `intake: "beatbox"` and `storefront_enabled: true`. Expect **400**.
18. `set_storefront` with `intake: "beatbox"`, `enabled: true`, and no `confirm_publish: true`. Expect **400**.

### RLS probes

Use the staging publishable key against PostgREST, not the service role.

19. `POST /rest/v1/beatbay_beats` as `anon`. Expect **401** or **403**, and no new row.
20. `PATCH /rest/v1/beatbay_beats?id=eq.{id}` setting `storefront_enabled=true` as `anon`. Expect **401** or **403**, and the row unchanged.
21. Repeat 19 and 20 with an `authenticated` user who is not `service_role`. Expect the same denial.
22. Confirm the public BeatBay page still loads if staging already served it through `beatbay-storefront`. This migration does not revoke `SELECT`.

### Secrets scan

23. In this repo, search `beatbox.html`, `beatbox/package-rules.mjs`, and `supabase/functions/beatbay-manager/beatbox-guard.mjs` for `service_role`, `SUPABASE_SERVICE_ROLE_KEY=`, `sk_live_`, `sk_test_`, `whsec_`, and `RESEND_API_KEY=`. Expect no live secrets. The publishable key in the HTML is the existing client key, not the service role.
24. Confirm `stripe-release-webhook`, `release-support-checkout`, and order mutation functions are not in this diff.

## What BoB should QA

Build these ZIPs and run them in a **non-production** project while signed in as staff, then again as owner or admin.

| Fixture | Expected |
| --- | --- |
| Happy: `audio/preview.mp3`, `audio/full.wav`, `cover.jpg`, `beat.json` | Review opens, sidecar fields are editable, audio plays, cover shows. Save draft stays off the storefront. Preview object appears under `beatbay/{id}/preview/` only after attach. Master stays under `beatbay/{id}/full/` in `release-private`. |
| Missing audio: cover and `beat.json` only | Asks for an MP3 or WAV. Nothing stored. |
| Single root `Night-Drive.mp3` with ID3 or frame-sync bytes | Treated as the preview. |
| Filename `140bpm` / `trap` | Suggestions only, until Apply. |
| Oversized: ZIP over 100 MB, or one audio file over 80 MB | Clear size error, nothing saved. |
| Traversal: `../secret.mp3`, `audio/../../x.wav`, `/tmp/abs.mp3` | Path error, nothing uploaded. |
| Zip bomb: small ZIP whose declared uncompressed size is more than 500 times the compressed size, or a zero-filled multi-megabyte `preview.mp3` | Ratio error before review. |
| Unexpected exec: `payload.exe`, `run.sh`, or `preview.mp3` starting with `MZ` | Rejected. No public object. |
| Nested `.zip`, two unnamed MP3s, symlink mode `0120000` | Rejected as documented above. |
| Staff: Save draft, then try Approve | Draft exists, storefront stays off, Approve is unavailable. |
| Owner: Approve without the confirm checkbox | Button stays disabled. Calling publish without `confirm_publish` returns 400. |
| Owner: confirm, Approve & publish, preview magic passes | Status Available, then storefront on. |
| Owner: Approve when quarantine magic fails | Storefront stays off and the quarantine object is removed. |

Also check keyboard: Tab to the drop zone, visible focus ring, Enter/Space opens the file picker, Escape clears a loaded package and returns focus to the drop zone.

## What Craig should score

Use the HOLD map and the SECURITY-DRYRUN probes above. Do not sign off for production from this PR alone. Merge only after that pass and Owner sign-off.
