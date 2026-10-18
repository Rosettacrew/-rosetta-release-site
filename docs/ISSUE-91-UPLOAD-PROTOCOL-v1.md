# Issue #91 upload-session protocol v1 (for DEV's client)

Backend branch: `issue-91-upload-sessions` (Rosettacrew/-rosetta-release-site). Status: **not deployed**. Needs a non-prod dry-run, Craig's review, and Owner approval first.

Shared module: `supabase/functions/_shared/upload-sessions.mjs`, mounted by both functions:

| Surface | Endpoint | Who | Beat rule |
| --- | --- | --- | --- |
| Owner / staff Beatbox, BeatBay Admin | `POST /functions/v1/beatbay-manager` | owner, admin, staff | owner/admin: any beat. staff: `status = draft` and `storefront_enabled = false` |
| Henry (`/studio/`) | `POST /functions/v1/studio-manager` | music_uploader | beat must be assigned to him **and** draft **and** off the storefront |

Auth is the same as today: `authorization: Bearer <user access token>` plus `apikey`. Every request is JSON `{"action": "...", ...}`. The session actions have the same names on both endpoints. Attach uses the endpoint's existing attach action (see §7).

Small files are unchanged. If `size <= limits.single_object_threshold` (45 MiB by default), keep the existing `create_upload` / `attach_asset` (or `beatbay_signed_upload` / `beatbay_attach_asset`) single-object path. The backend did not change that path. The diff is additions only, and a test enforces it.

---

## 0. Conventions

- Sizes are bytes (integers). Hashes are **lowercase hex SHA-256** (64 chars).
- `idx` is 0-based. `chunk_count = ceil(total_bytes / chunk_bytes)`. Every chunk is `chunk_bytes` long except the last, which is `total_bytes - chunk_bytes * (chunk_count - 1)`.
- Times are ISO-8601 UTC (for example `"expires_at": "2026-09-26T12:00:00.000Z"`). Convert them for display.
- Kinds: `full` (master audio), `stems` (ZIP), `video` (MP4), `zip` (any other package ZIP). The kind is fixed when the session starts, and attach enforces it.
- Default allowlist, which comes from config and may change, so read `limits.allowed`: `full: wav, mp3` · `stems: zip` · `video: mp4` · `zip: zip`.

### Error envelope (every non-2xx from the session actions)

```json
{ "error": "Human message", "code": "MACHINE_CODE", "...": "code-specific fields" }
```

`error` is kept so the existing `af()` helper that reads `.error` still works. Branch on `code`.

| code | HTTP | When | Client action |
| --- | --- | --- | --- |
| `BAD_REQUEST` | 400 | Malformed input. `field` names the problem (for example a missing hash). | Bug: fix the request |
| `FORBIDDEN` | 403 | Another user's session, a beat that is not allowed (published/active for non-owner, unassigned for Henry), or a session bound to a different beat | Fail closed |
| `BEAT_NOT_FOUND` | 404 | beat_id does not exist | Fail closed |
| `SESSION_NOT_FOUND` | 404 | Unknown session_id | Drop local resume state, offer "Start again" |
| `SESSION_EXPIRED` | 410 | Past `expires_at` (24 h default) | Drop local resume state, offer "Start again" |
| `INVALID_STATE` | 409 | Wrong state for the action (for example ticket on a failed or aborted session, attach before verify, abort after attach). Includes `session_status`. | Call `upload_status` and reconcile |
| `EXT_NOT_ALLOWED` | 400 | Extension not allowed for the kind, or gzip used on a non-compressible type. Includes `kind`, `ext`, `allowed`. | Fail closed |
| `LIMIT_EXCEEDED` | 400 / 409 / 413 / 429 | Includes `limit`: one of `max_file_bytes` (413), `chunk_bytes` (400), `ticket_batch_max` (400), `max_attempts` (409), `max_open_sessions_per_user` (429), `compress_max_bytes` (413). Also includes `max`. | Fail closed. For 429, finish or cancel another upload |
| `STORAGE_BUDGET_EXCEEDED` | 507 | `used + reserved + total_bytes > max_total_upload_bytes` (Free: 1 GB per project). Includes `storage`, `total_bytes`. | **Treat as a limit error.** DEV proposed `LIMIT_EXCEEDED` for this case; the server keeps the distinct code, so map `STORAGE_BUDGET_EXCEEDED → LIMIT_EXCEEDED` handling (fail closed, no retry) and show "Project storage is full" |
| `CHUNK_OUT_OF_RANGE` | 400 | idx not in `0..chunk_count-1` | Bug |
| `CHUNK_MISSING` | 409 | `chunk_done` before the object exists. Does not count as an attempt. | Re-PUT (new ticket if expired), then `chunk_done` |
| `CHUNK_SIZE_MISMATCH` | 422 | Stored part length is not the expected length. Part deleted, attempts+1. Includes `expected_bytes`, `received_bytes`, `attempts`, `max_attempts`, `retryable`, `session_status`. | If `retryable`: re-read the slice, new ticket, retry **that idx only**. Else fail closed |
| `CHUNK_HASH_MISMATCH` | 422 | SHA-256 of the stored part is not the declared hash. Part deleted, attempts+1. Same fields plus `expected_sha256`, `received_sha256`. It can also come from `complete_upload` with `reverify: true` if a verified part changed; the session is then failed. | Same as above |
| `HASH_CONFLICT` | 409 | A newly declared hash contradicts an earlier one (up-front list, `head_sha256`, or `file_sha256` from start). This means a different file. | Fail closed, start again with the right file |
| `INCOMPLETE` | 409 | `complete_upload` while some idx are not verified. Includes `missing[]`, `bad[]`. | Upload the listed idx, then retry complete |
| `MAGIC_MISMATCH` | 422 | First-chunk content does not match the extension (WAV RIFF/WAVE plus RIFF-size vs total, MP3 ID3/frame sync, ZIP `PK\3\4`, MP4 `ftyp`), or gzip declared but not gzip. Includes `detail`. Session failed, parts deleted. | Fail closed |
| `ZIP_UNSAFE` | 422 | Central directory check failed. `detail` is one of: `dotdot_path`, `absolute_path`, `drive_path`, `backslash_path`, `nul_in_name`, `symlink`, `blocked_ext`, `too_many_entries`, `empty_zip`, `no_eocd`, `entry_count_mismatch`, `central_directory_too_large`, `central_directory_out_of_range`, `zip64_*`, `bad_cd_signature`, `truncated_cd_entry`, `range_*`. May include `name`. Session failed, parts deleted. | Fail closed |
| `KIND_MISMATCH` | 409 | attach `kind` is not the session kind. Includes `session_kind`. | Bug |
| `CONFIG_UNAVAILABLE` | 503 | The `upload_limits` row is missing or invalid (fails closed) | Retry later or tell the Owner |
| `STORAGE_ERROR` | 500 / 502 | Signing or manifest write failed | Retry with backoff |

Any other 5xx comes from the function's generic handler as `{ "error": "..." }` with no code. Retry it with backoff.

---

## 1. `start_upload`

Two hash modes. Both are supported, so DEV P9 single-pass works.

**A. Deferred (P9, single pass, recommended):** send `head_sha256` (the SHA-256 of chunk 0) now. Send each chunk's hash on `chunk_ticket` (or on `chunk_done`), and `file_sha256` on `complete_upload`.

**B. Up-front:** send `chunk_sha256[]` (every chunk, in idx order) and, optionally, `file_sha256`.

Request:
```json
{
  "action": "start_upload",
  "beat_id": "uuid",
  "kind": "full",
  "filename": "master.wav",
  "total_bytes": 209715244,
  "chunk_bytes": 16777216,
  "head_sha256": "hex64",
  "chunk_sha256": ["hex64", "..."],
  "file_sha256": "hex64",
  "encoding": "identity",
  "original_bytes": 734003244,
  "original_sha256": "hex64"
}
```
- `chunk_bytes` is optional. The default is `limits.chunk_bytes`. If sent, it must be in `[limits.min_chunk_bytes, limits.chunk_bytes]`. It is always `< 50 MiB`.
- Send at least one of `head_sha256` or `chunk_sha256`. If you send both, `chunk_sha256[0]` must equal `head_sha256`.
- `encoding: "gzip"` (P8) is only allowed for `kind: "full"` with an ext in `limits.compressible_exts` (default `wav`). It then requires `original_bytes` (≤ `compress_max_bytes`); `original_sha256` is optional. `total_bytes` and every hash describe the **gzip bytes as uploaded**. The server inflates only the head of chunk 0 to check WAV magic and the RIFF size against `original_bytes`.
- `last_modified` and other extra fields are ignored.

**Resume / idempotency:** the same `(user, beat_id, kind, total_bytes, head_sha256, encoding, chunk_bytes)` returns the **existing** live session (open, complete, or verified) with `"resumed": true` and HTTP 200. That covers reload and resume. If the same head and size arrive but the up-front hashes or `file_sha256` differ, the old open session is aborted, a new one is created, and `replaced_session_id` is set.

Response `201` (new) or `200` (resumed). This is also the `upload_status` shape:
```json
{
  "protocol": 1,
  "session_id": "uuid",
  "status": "open",
  "beat_id": "uuid",
  "kind": "full",
  "filename": "master.wav",
  "ext": "wav",
  "mime": "audio/wav",
  "encoding": "identity",
  "original_bytes": null,
  "total_bytes": 209715244,
  "chunk_bytes": 16777216,
  "chunk_count": 13,
  "hash_mode": "deferred",
  "verified_count": 0,
  "missing": [0,1,2,3,4,5,6,7,8,9,10,11,12],
  "bad": [],
  "attempts": {},
  "expires_at": "2026-09-26T12:00:00.000Z",
  "manifest_path": null,
  "manifest_root_sha256": null,
  "failure_code": null,
  "limits": {
    "chunk_bytes": 16777216, "min_chunk_bytes": 1048576,
    "single_object_threshold": 47185920, "max_file_bytes": 943718400,
    "max_total_upload_bytes": 1006632960, "session_ttl_seconds": 86400,
    "max_attempts": 5, "ticket_ttl_seconds": 900, "ticket_batch_max": 16,
    "max_open_sessions_per_user": 3, "preview_max_bytes": 10485760,
    "compress_min_saving": 0.1, "compress_max_bytes": 536870912,
    "compressible_exts": ["wav"], "zip_max_entries": 2000,
    "allowed": { "full": ["wav","mp3"], "stems": ["zip"], "video": ["mp4"], "zip": ["zip"] }
  },
  "storage": {
    "used_bytes": 123456789, "reserved_bytes": 209715244,
    "max_total_upload_bytes": 1006632960, "remaining_bytes": 673460756,
    "scope": "project"
  },
  "storage_used_bytes": 123456789,
  "storage_quota_bytes": 1006632960,
  "resumed": false,
  "replaced_session_id": null
}
```
- `status` is one of: `open` | `complete` (server-side completion lock, transient) | `verified` | `failed` | `expired` | `aborted` | `attached` | `replaced` (a superseded master whose parts the owner deleted).
- `missing` lists idx that are not verified and not bad (pending or ticketed). `bad` lists idx whose last attempt failed. `attempts` maps idx to failed attempts (non-zero only).

**Limits without a session (DEV ask b, P11):**
```json
{ "action": "start_upload", "dry_run": true }
```
Response: `{ "protocol": 1, "dry_run": true, "limits": { ... }, "storage": { ... }, "storage_used_bytes": 123456789, "storage_quota_bytes": 1006632960 }`. No beat or session is needed. Nothing is created.

**Storage fields (DEV ask), on `start_upload`, `upload_status` and `dry_run`:**
- `storage_used_bytes`: bytes currently stored in Storage. Same value as `storage.used_bytes`. All buckets by default, because the Free cap is per project.
- `storage_quota_bytes`: config `upload_limits.max_total_upload_bytes`, default **960 MiB** (1006632960), a safety margin under the 1 GiB hard cap. Same value as `storage.max_total_upload_bytes`.
- `storage.reserved_bytes` (bytes still owed by live sessions) also counts toward the budget. Show `storage.remaining_bytes` for the bytes you can still start.

`storage` (P11 / Free 1 GB budget): `used_bytes` is the sum of `storage.objects` sizes across **all buckets** (the Free cap is project-wide; config `budget_bucket_ids` can scope it). `reserved_bytes` is the bytes still expected by live sessions. start_upload refuses with `STORAGE_BUDGET_EXCEEDED` when `used + reserved + total_bytes > max_total_upload_bytes`.

## 2. `chunk_ticket` (batch, ask a)

```json
{ "action": "chunk_ticket", "session_id": "uuid", "idx": [0, 1, 2], "sha256": ["hex64", "hex64", "hex64"] }
```
- `idx` is an int or an int array, with at most `limits.ticket_batch_max` (16) entries and no duplicates.
- `sha256` is optional and lines up with `idx` (P9 deferred mode). For idx 0 it must equal `head_sha256`. In deferred mode a re-declared hash replaces the old one until that chunk is verified. In up-front mode it must match the start list, or you get `HASH_CONFLICT`.
- Only the uploader who started the session can get tickets. Owner-tier cannot, which prevents cross-user writes.

Response 200:
```json
{
  "session_id": "uuid",
  "tickets": [
    {
      "idx": 0,
      "method": "PUT",
      "bucket": "release-private",
      "path": "uploads/<session_id>/0.part",
      "signed_url": "https://<ref>.supabase.co/storage/v1/object/upload/sign/release-private/uploads/<session_id>/0.part?token=...",
      "token": "...",
      "headers": { "content-type": "audio/wav", "x-upsert": "false" },
      "bytes": 16777216,
      "sha256": "hex64 or null",
      "expires_in": 900
    }
  ],
  "skipped": [ { "idx": 1, "reason": "verified" } ]
}
```
- **P7 (decided: option ii):** PUT with exactly `ticket.headers`. `content-type` is the file's real MIME from the allowlist (audio/wav, audio/mpeg, application/zip, video/mp4), so parts pass the `release-private` MIME allowlist. **Do not send `application/octet-stream`.** No separate staging bucket was added, because parts live only in `release-private`.
- `expires_in` is in seconds. Refresh when it is under 30 s. If Storage ignores a custom TTL, the real TTL is longer (2 h), never shorter.
- Verified idx come back in `skipped` (no URL), which is "retry only failed chunks". `sha256: null` means no hash is declared yet (deferred mode); send it on `chunk_done`.
- PUT answered 400/409 "already exists": call `chunk_done`, because the earlier attempt probably landed.

## 3. PUT (browser → Storage directly; no bytes go through the Edge Function)

`fetch(ticket.signed_url, { method: "PUT", headers: ticket.headers, body: sliceBytes })`. The body must be exactly `ticket.bytes` long.

## 4. `chunk_done`

```json
{ "action": "chunk_done", "session_id": "uuid", "idx": 3, "sha256": "hex64" }
```
`sha256` is optional if it was already declared (start list or ticket). The server downloads **only that part** (≤ chunk_bytes), checks its length, and computes SHA-256 with `crypto.subtle`.

200 verified:
```json
{ "session_id": "uuid", "idx": 3, "status": "verified", "duplicate": false, "verified_count": 4, "chunk_count": 13, "all_verified": false }
```
200 duplicate (already verified, a no-op; the part is not re-read):
```json
{ "session_id": "uuid", "idx": 3, "status": "verified", "duplicate": true }
```
422 mismatch. The part is deleted, and you retry that idx only:
```json
{ "error": "Chunk SHA-256 does not match.", "code": "CHUNK_HASH_MISMATCH", "idx": 3, "attempts": 1, "max_attempts": 5,
  "retryable": true, "session_status": "open", "expected_sha256": "hex64", "received_sha256": "hex64" }
```
When `attempts` reaches `max_attempts`: `retryable: false`, `session_status: "failed"`, and every part is deleted.

## 5. `upload_status`

```json
{ "action": "upload_status", "session_id": "uuid" }
```
Returns the same shape as start_upload (without `resumed`). Use it on reload, on the `online` event, on `visibilitychange`, and after `INCOMPLETE`. It returns 410 `SESSION_EXPIRED` once past `expires_at`. The session creator or owner-tier may call it.

## 6. `complete_upload`

```json
{ "action": "complete_upload", "session_id": "uuid", "file_sha256": "hex64" }
```
- `file_sha256` is optional (P9: send it here in deferred mode). If you already sent it at start, it must match (`HASH_CONFLICT`). It is recorded as **client-declared** (`file_sha256_verified: false`), because Free has no server-side whole-file hash. Integrity is enforced per part, and `manifest_root_sha256` ties them together.
- Server checks, without reassembling the file: all idx verified (`INCOMPLETE`); re-hash of every part it reads; first-chunk magic; WAV RIFF/data size against the real size; ZIP central directory from the tail part(s), including ZIP64; entry cap `zip_max_entries`; no absolute, `..`, drive, or backslash paths; no symlinks; no blocked executable extensions.
- Pass: `manifest.json` is written to `uploads/<session_id>/manifest.json` and the status becomes `verified`.
- Content failure: status `failed`, every part deleted, 422 with `MAGIC_MISMATCH` / `ZIP_UNSAFE` / `CHUNK_HASH_MISMATCH`, plus `session_status: "failed"` and `retryable: false`.
- Idempotent: calling it again on a verified or attached session returns 200 with `already_verified: true`.

200:
```json
{
  "session_id": "uuid", "status": "verified", "already_verified": false, "kind": "full", "beat_id": "uuid",
  "manifest_path": "uploads/<session_id>/manifest.json",
  "manifest_root_sha256": "hex64",
  "total_bytes": 209715244, "chunk_count": 13,
  "file_sha256": "hex64", "file_sha256_verified": false
}
```
`manifest_root_sha256 = SHA-256( chunk0_digest_32_bytes || chunk1_digest_32_bytes || ... )`: the **binary** 32-byte digests concatenated in idx order.

manifest.json:
```json
{ "version": 1, "session_id": "uuid", "beat_id": "uuid", "kind": "full", "filename": "master.wav", "ext": "wav", "mime": "audio/wav",
  "encoding": "identity", "original_bytes": null, "original_sha256": null, "total_bytes": 209715244, "chunk_bytes": 16777216,
  "chunk_count": 13, "file_sha256": "hex64", "file_sha256_verified": false, "manifest_root_sha256": "hex64",
  "manifest_root_algo": "sha256(concat(binary chunk sha256 in idx order))", "bucket": "release-private",
  "parts": [ { "idx": 0, "path": "uploads/<id>/0.part", "bytes": 16777216, "sha256": "hex64" } ],
  "zip_entries": null, "verified_at": "ISO" }
```

## 7. Attach (extended existing actions; ask d)

beatbay-manager (owner/admin/staff):
```json
{ "action": "attach_asset", "intake": "beatbox", "id": "<beat uuid>", "kind": "full", "session_id": "uuid" }
```
studio-manager (Henry):
```json
{ "action": "beatbay_attach_asset", "beat_id": "<beat uuid>", "kind": "full", "session_id": "uuid" }
```
- A non-empty `session_id` selects the session path. Without it, the old small-file behaviour is unchanged.
- Rules: the session is `verified` and not expired; the caller is the session creator (or owner-tier on beatbay-manager); the session `beat_id` equals the beat (else `FORBIDDEN`); `kind` equals the session kind (`KIND_MISMATCH`); the beat passes the endpoint's rule (staff and Henry: draft only, so a published beat returns `FORBIDDEN` and the session stays `verified`).
- `kind: "full"` sets `beatbay_beats.full_audio_bucket = "release-private"` and `full_audio_path = "uploads/<id>/manifest.json"`.
- `stems` / `video` / `zip` upsert a row in the new `beatbay_beat_assets (beat_id, kind)`. The master is not touched.
- It **never** changes `status` or `storefront_enabled`. Review, then Approve & publish (`set_storefront` + `confirm_publish`, owner only) is unchanged.

200 (beatbay-manager returns the full beat row; studio-manager returns its `publicBeatItem` shape):
```json
{ "session_id": "uuid", "status": "attached", "kind": "full", "manifest_path": "uploads/<id>/manifest.json", "beat": { "...": "..." } }
```
A repeat call returns `already_attached: true`.

## 8. `abort_upload` (ask e)

```json
{ "action": "abort_upload", "session_id": "uuid" }
```
Only the session creator or owner-tier (owner/admin on beatbay-manager) may call it. It deletes every part and marks the session `aborted`.
Returns 200 `{ "session_id": "uuid", "status": "aborted", "removed": 2 }`, or `already_aborted: true` if it was already aborted. An attached session returns 409 `INVALID_STATE`, because its parts are the stored master.

## 9. Owner master download of a chunked master (additive)

`download_full_beat` is byte-identical for single-object masters: `{ "download_url": "<signed>", "expires_in": 300 }`. When `full_audio_path` is `uploads/<id>/manifest.json`:
```json
{
  "download_url": null,
  "chunked": true,
  "message": "Chunked master: download every part in parts[] in idx order, check each sha256, and join them.",
  "manifest": { "session_id": "uuid", "filename": "master.wav", "ext": "wav", "mime": "audio/wav", "encoding": "identity",
                "original_bytes": null, "total_bytes": 209715244, "chunk_bytes": 16777216, "chunk_count": 13,
                "file_sha256": "hex64", "manifest_root_sha256": "hex64" },
  "parts": [ { "idx": 0, "bytes": 16777216, "sha256": "hex64", "url": "<signed part url>" } ],
  "expires_in": 300
}
```
`download_url` is **null on purpose**. An old client that only reads `download_url` fails clearly instead of saving manifest.json as audio. There is no manifest URL; everything needed is inline. The new client joins the parts in idx order and checks each part's SHA-256. If `encoding` is `gzip`, it gunzips the joined stream and then checks `original_sha256` if present. Branch on `chunked === true`.

## 10. Owner maintenance

`POST beatbay-manager {"action":"cleanup_uploads"}` (owner/admin only; others get 403 `FORBIDDEN`).

- **Routine part (always runs, same as the automatic pass):** purges expired, failed or aborted sessions' parts and orphan folders older than 1 h. It only ever deletes under `release-private/uploads/<uuid>/`. It never touches attached sessions, `beatbay/<id>/…`, or release files. `start_upload` also runs a bounded routine pass (5 sessions) before the budget check.
- **Replaced chunked masters are never auto-deleted.** A replaced master is an attached session whose manifest is no longer the beat's `full_audio_path` (or no longer the `beatbay_beat_assets` row for stems/video/zip). By default the call only **lists** them (dry run):

```json
{ "cleanup": {
  "expired": 0, "purged_sessions": 0, "removed_objects": 0, "orphan_folders": 0, "skipped": [],
  "replaced": {
    "dry_run": true,
    "replaced_parts": [
      { "session_id": "uuid", "beat_id": "uuid", "kind": "full", "filename": "old-master.wav", "attached_at": "ISO",
        "manifest_path": "uploads/<id>/manifest.json", "object_count": 4, "bytes": 614933,
        "paths": ["uploads/<id>/0.part", "uploads/<id>/1.part", "uploads/<id>/2.part", "uploads/<id>/manifest.json"] }
    ],
    "bytes_reclaimable": 614933
  } } }
```

- Delete them only with `{"action":"cleanup_uploads","confirm":true}`, optionally with `"session_ids":["uuid", ...]` to limit it. Each session is re-checked as unreferenced right before deletion. If the owner re-pointed a beat to it meanwhile, it is kept. Deleted sessions get status `replaced`. The response has `"dry_run": false`, `deleted_session_ids`, `removed_objects`, `bytes_reclaimed`, and the remaining `bytes_reclaimable`.

## 10a. Activity log and email (Henry / studio-manager)

At most **one** Owner email per upload, sent on attach (`upload_attached`). `upload_started`, `upload_verified`, `upload_failed` and `upload_aborted` are written to `music_activity_log` with `email_status = "suppressed"` and send no email. beatbay-manager is unchanged: owner, admin and staff never trigger emails.

## 11. Suggested client flow

1. `start_upload {dry_run:true}` → limits. If `size <= single_object_threshold`, use the old path.
2. Hash chunk 0 → `start_upload` (deferred) → keep `session_id` in localStorage under your key.
3. For missing idx, in batches of ≤ 16: hash the slice → `chunk_ticket {idx[], sha256[]}` → PUT (3 parallel) → `chunk_done`.
4. `complete_upload {file_sha256}`. On `INCOMPLETE`, go back to step 3 with `missing`/`bad`.
5. Attach (§7) → existing review screen → owner Approve & publish.
6. Cancel → `abort_upload`. Reload → re-select the file → re-hash chunk 0 → `start_upload` resumes → `upload_status` gives the missing idx.
