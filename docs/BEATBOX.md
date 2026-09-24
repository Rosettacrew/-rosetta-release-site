# Beatbox V1

Internal admin intake for BeatBay. Beatbox is not a customer page. It does not replace BeatBay Admin’s single-file upload, and it does not change the public BeatBay storefront except through the existing owner/admin publish action.

**Not for production until Craig’s security pass and Owner sign-off. Do not merge this branch to `main`.**

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

V1 uses [JSZip 3.10.1](https://esm.sh/jszip@3.10.1) in the admin’s browser. The Edge function never receives the ZIP. After validation, only the chosen preview and optional master are uploaded through the signed-upload path BeatBay Admin already uses. That avoids a new server unzip sandbox for this version.

JSZip rewrites dangerous names (`../evil.mp3` becomes `evil.mp3`) and keeps the original on `unsafeOriginalName`. Beatbox rejects the original name. It also rejects absolute paths, empty path segments, symbolic links when the ZIP stores a UNIX symlink mode (`0120000`), and entries whose extracted byte length does not match the central-directory size.

Residual risk for Craig and BoB: a lying uncompressed-size header can still make the browser allocate memory during inflate, because that work happens on the admin’s machine. Declared size, ratio, and file-count caps run before inflate. Extracted bytes are checked again before upload. Encrypted ZIPs fail closed when JSZip refuses them. Symlinks are detectable only when the archiver wrote UNIX permissions; Windows ZIPs often omit that mode, so path checks are the backstop.

## Security notes for Craig

- Same gate as BeatBay Admin: Supabase session, then `release_admin_users` active with role `owner`, `admin`, or `staff` (`requireTeam` in `supabase/functions/beatbay-manager/index.ts`). `music_uploader` stays excluded.
- The page sends `shouldCreateUser: false` on the email link so this screen does not create auth users. `beatbay-admin.html` still omits that flag; Beatbox is stricter on purpose.
- `meta robots noindex,nofollow` and `robots.txt` disallow `/beatbox.html` and `/beatbox/`.
- The client uses the same publishable Supabase key as BeatBay Admin. No service role, secret key, or storage secret is in the page.
- `save_beat` with `intake: "beatbox"` cannot set `storefront_enabled`. A request that tries is rejected. New Beatbox rows are inserted with `storefront_enabled: false` and `is_featured: false`.
- Staff Beatbox saves are forced to `status: draft`. Staff still cannot update a beat that is already published or no longer a draft.
- Publish remains `set_storefront`, owner/admin only, and still requires a preview URL plus a non-draft status. The Approve button is disabled for staff and stays disabled for owners until the confirm checkbox is checked.
- Uploaded object names are `preview.mp3` / `full.wav` (extension from the validated file), not the raw ZIP path.
- Cover bytes are not uploaded in V1.
- No new public tables. No Loyalty, Release Station, or customer `beatbay/index.html` changes.

## What BoB should QA

Build these ZIPs and run them in a non-production project while signed in as staff, then again as owner or admin.

| Fixture | Expected |
| --- | --- |
| `audio/preview.mp3`, `audio/full.wav`, `cover.jpg`, `beat.json` | Review opens, sidecar fields are editable, audio plays, cover shows, Save draft stays off the storefront |
| Single root `Night-Drive.mp3` | Treated as the preview. Title suggestion comes from the file name. BPM in the name is a suggestion, not filled in |
| `preview.mp3` whose name contains `140bpm` and `trap` | Tempo and style appear under Suggestions and stay out of the form until Apply |
| ZIP over 100 MB | Clear size error, nothing saved |
| Empty ZIP | “The archive is empty.” |
| Cover only, no audio | Asks for an MP3 or WAV |
| `../secret.mp3` or `audio/../../x.wav` | Path traversal error, nothing uploaded |
| `/tmp/abs.mp3` | Absolute path error |
| `payload.exe`, `run.sh`, or `notes.pdf` beside a valid MP3 | Rejected file type, whole package stopped |
| A `.zip` nested inside the package | Nested ZIP error |
| Two unnamed MP3s | Asks for `preview.mp3` and optional `full.wav` |
| Symlink entry, if the ZIP tool can write UNIX mode `0120000` | Symbolic link error |
| Staff: Save draft, then try Approve | Draft exists, storefront stays off, Approve is unavailable |
| Owner: Approve without the confirm checkbox | Button stays disabled |
| Owner: confirm, Approve & publish, preview present | Status Available, then storefront on. Reloading BeatBay Admin shows the listing |
| Owner: Approve when the preview upload is blocked | Storefront stays off |

Also check keyboard: Tab to the drop zone, visible gold focus ring, Enter/Space opens the file picker, Escape clears a loaded package and returns focus to the drop zone.

## What Craig should score

- Auth gate matches `requireTeam`, including staff draft access and owner/admin-only `set_storefront`.
- No service role or other secret in `beatbox.html` or `beatbox/package-rules.mjs`.
- ZIP name handling (`unsafeOriginalName`, traversal, absolute paths, symlink mode, nested ZIP, executable deny list).
- Size caps before inflate, and extracted length checked against the declared size before upload.
- `intake: "beatbox"` cannot flip `storefront_enabled`; publish is only the existing `set_storefront` path after an explicit confirm.
- Staff status cannot leave `draft` through Beatbox.
- Cover image is not written to storage.
- Customer BeatBay and Release Station routes are unchanged.
- `noindex` plus robots disallow.

Do not sign off for production from this PR alone. Merge only after that pass and Owner sign-off.
