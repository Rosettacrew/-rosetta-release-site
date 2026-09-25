/**
 * Issue #91: Beatbox large-file uploads ("sessions + chunk objects + manifest").
 *
 * One shared, provider-neutral module. beatbay-manager (owner/admin/staff) and
 * studio-manager (music_uploader) both mount it with their own authorizer.
 *
 * Storage and DB are injected adapters, so tests use in-memory fakes and a
 * Supabase Pro (TUS) or R2 (S3 multipart) adapter can be swapped in later
 * without changing the client protocol (protocol-v1).
 *
 * Invariants:
 * - Parts live only in the private bucket under `uploads/<session_id>/`.
 * - The whole file is never loaded. Only one chunk (<= chunk_bytes, < 50 MiB)
 *   is ever held in memory, plus a bounded ZIP central-directory window.
 * - Per-chunk SHA-256 is computed server-side with crypto.subtle on that chunk.
 * - Limits come from the upload_limits config row. Nothing here is hard-coded
 *   except the absolute safety ceiling that chunk_bytes must be < 50 MiB.
 * - Nothing here ever enables the storefront or changes beat status.
 *
 * No secrets. No Deno-only APIs (runs under Deno Edge and node >= 20).
 */

export const PROTOCOL_VERSION = 1;
export const UPLOAD_ACTIONS = Object.freeze([
  "start_upload",
  "chunk_ticket",
  "chunk_done",
  "upload_status",
  "complete_upload",
  "abort_upload",
]);
export const UPLOAD_KINDS = Object.freeze(["full", "stems", "video", "zip"]);
export const HARD_MAX_CHUNK_BYTES = 50 * 1024 * 1024; // Free global object cap; chunk_bytes must be strictly below.
export const UPLOAD_PREFIX = "uploads/";
export const STALE_COMPLETE_LOCK_MS = 120_000;
export const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64_RE = /^[0-9a-f]{64}$/;
const OPEN_STATES = ["open", "complete"];
const RESUMABLE_STATES = ["open", "complete", "verified"];

/** Machine-readable error codes (protocol-v1). */
export const ERR = Object.freeze({
  BAD_REQUEST: "BAD_REQUEST",
  FORBIDDEN: "FORBIDDEN",
  BEAT_NOT_FOUND: "BEAT_NOT_FOUND",
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  INVALID_STATE: "INVALID_STATE",
  EXT_NOT_ALLOWED: "EXT_NOT_ALLOWED",
  LIMIT_EXCEEDED: "LIMIT_EXCEEDED",
  STORAGE_BUDGET_EXCEEDED: "STORAGE_BUDGET_EXCEEDED",
  CHUNK_OUT_OF_RANGE: "CHUNK_OUT_OF_RANGE",
  CHUNK_MISSING: "CHUNK_MISSING",
  CHUNK_SIZE_MISMATCH: "CHUNK_SIZE_MISMATCH",
  CHUNK_HASH_MISMATCH: "CHUNK_HASH_MISMATCH",
  HASH_CONFLICT: "HASH_CONFLICT",
  INCOMPLETE: "INCOMPLETE",
  MAGIC_MISMATCH: "MAGIC_MISMATCH",
  ZIP_UNSAFE: "ZIP_UNSAFE",
  KIND_MISMATCH: "KIND_MISMATCH",
  CONFIG_UNAVAILABLE: "CONFIG_UNAVAILABLE",
  STORAGE_ERROR: "STORAGE_ERROR",
});

export class UploadError extends Error {
  constructor(code, status, message, details = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
const fail = (code, status, message, details) => { throw new UploadError(code, status, message, details); };

// ---------------------------------------------------------------------------
// Small pure helpers (exported for tests and the client docs)
// ---------------------------------------------------------------------------

export const isUuid = (value) => UUID_RE.test(String(value ?? "").trim());
export const isHex64 = (value) => HEX64_RE.test(String(value ?? ""));
export const partPath = (sessionId, idx) => `${UPLOAD_PREFIX}${sessionId}/${idx}.part`;
export const manifestPath = (sessionId) => `${UPLOAD_PREFIX}${sessionId}/manifest.json`;
export const sessionPrefix = (sessionId) => `${UPLOAD_PREFIX}${sessionId}/`;

/** True only for `uploads/<uuid>/manifest.json`. */
export function isSessionManifestPath(path) {
  const m = /^uploads\/([0-9a-f-]{36})\/manifest\.json$/i.exec(String(path ?? ""));
  return !!m && isUuid(m[1]);
}

/** Guard used before every delete: path must sit under uploads/<uuid>/ with no traversal. */
export function isSafeUploadObject(path, sessionId) {
  const p = String(path ?? "");
  if (!isUuid(sessionId)) return false;
  if (p.includes("..") || p.includes("\\") || p.startsWith("/") || p.includes("//")) return false;
  return p.startsWith(sessionPrefix(sessionId)) && p.length > sessionPrefix(sessionId).length;
}

export function safeExt(name) {
  const n = String(name ?? "");
  return n.includes(".") ? n.split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "") : "";
}

export function chunkMath(totalBytes, chunkBytes) {
  const count = Math.ceil(totalBytes / chunkBytes);
  const sizeOf = (idx) => (idx < count - 1 ? chunkBytes : totalBytes - chunkBytes * (count - 1));
  return { count, sizeOf };
}

function toHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}
function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** SHA-256 of ONE chunk via native crypto.subtle. */
export async function sha256Hex(bytes) {
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}

/** manifest_root_sha256 = SHA-256 over the 32-byte binary chunk digests concatenated in idx order. */
export async function manifestRoot(chunkHexes) {
  const joined = new Uint8Array(chunkHexes.length * 32);
  chunkHexes.forEach((hex, i) => joined.set(fromHex(hex), i * 32));
  return sha256Hex(joined);
}

// ---------------------------------------------------------------------------
// Limits (config row). The DB row is authoritative; missing/invalid => fail closed.
// ---------------------------------------------------------------------------

/** Defaults mirror the migration's column defaults. Used by tests and docs only. */
export const DEFAULT_LIMITS = Object.freeze({
  max_file_bytes: 900 * 1024 * 1024,
  chunk_bytes: 16 * 1024 * 1024,
  min_chunk_bytes: 1024 * 1024,
  single_object_threshold: 45 * 1024 * 1024,
  session_ttl_seconds: 24 * 3600,
  max_attempts: 5,
  ticket_ttl_seconds: 900,
  ticket_batch_max: 16,
  max_open_sessions_per_user: 3,
  max_total_upload_bytes: 960 * 1024 * 1024,
  budget_bucket_ids: null,
  preview_max_bytes: 10 * 1024 * 1024,
  compress_min_saving: 0.1,
  compress_max_bytes: 512 * 1024 * 1024,
  compressible_exts: ["wav"],
  zip_max_entries: 2000,
  zip_max_cd_bytes: 8 * 1024 * 1024,
  zip_blocked_exts: ["exe", "dll", "com", "scr", "msi", "bat", "cmd", "ps1", "vbs", "js", "jar", "sh", "app", "dmg", "pkg"],
  allowed: {
    full: { wav: "audio/wav", mp3: "audio/mpeg" },
    stems: { zip: "application/zip" },
    video: { mp4: "video/mp4" },
    zip: { zip: "application/zip" },
  },
});

const posInt = (v) => Number.isSafeInteger(Number(v)) && Number(v) > 0;

export function normalizeLimits(row) {
  if (!row || typeof row !== "object") fail(ERR.CONFIG_UNAVAILABLE, 503, "Upload limits are not configured.");
  const L = { ...row };
  for (const key of ["max_file_bytes", "chunk_bytes", "min_chunk_bytes", "single_object_threshold", "session_ttl_seconds",
    "max_attempts", "ticket_ttl_seconds", "ticket_batch_max", "max_open_sessions_per_user", "max_total_upload_bytes",
    "preview_max_bytes", "compress_max_bytes", "zip_max_entries", "zip_max_cd_bytes"]) {
    if (!posInt(L[key])) fail(ERR.CONFIG_UNAVAILABLE, 503, `Upload limit ${key} is missing or invalid.`);
    L[key] = Number(L[key]);
  }
  if (L.chunk_bytes >= HARD_MAX_CHUNK_BYTES) fail(ERR.CONFIG_UNAVAILABLE, 503, "Configured chunk_bytes must be below 50 MiB.");
  if (L.min_chunk_bytes > L.chunk_bytes) fail(ERR.CONFIG_UNAVAILABLE, 503, "Configured min_chunk_bytes exceeds chunk_bytes.");
  if (!L.allowed || typeof L.allowed !== "object") fail(ERR.CONFIG_UNAVAILABLE, 503, "Upload allowlist is not configured.");
  L.compress_min_saving = Number(L.compress_min_saving ?? 0.1);
  L.compressible_exts = Array.isArray(L.compressible_exts) ? L.compressible_exts.map((x) => String(x).toLowerCase()) : [];
  L.zip_blocked_exts = Array.isArray(L.zip_blocked_exts) ? L.zip_blocked_exts.map((x) => String(x).toLowerCase()) : [];
  L.budget_bucket_ids = Array.isArray(L.budget_bucket_ids) && L.budget_bucket_ids.length ? L.budget_bucket_ids.map(String) : null;
  return L;
}

/** Public (client-facing) view of the limits: DEV ask (b). */
export function publicLimits(L) {
  const allowed = {};
  for (const [kind, map] of Object.entries(L.allowed)) allowed[kind] = Object.keys(map ?? {});
  return {
    chunk_bytes: L.chunk_bytes,
    min_chunk_bytes: L.min_chunk_bytes,
    single_object_threshold: L.single_object_threshold,
    max_file_bytes: L.max_file_bytes,
    max_total_upload_bytes: L.max_total_upload_bytes,
    session_ttl_seconds: L.session_ttl_seconds,
    max_attempts: L.max_attempts,
    ticket_ttl_seconds: L.ticket_ttl_seconds,
    ticket_batch_max: L.ticket_batch_max,
    max_open_sessions_per_user: L.max_open_sessions_per_user,
    preview_max_bytes: L.preview_max_bytes,
    compress_min_saving: L.compress_min_saving,
    compress_max_bytes: L.compress_max_bytes,
    compressible_exts: L.compressible_exts,
    zip_max_entries: L.zip_max_entries,
    allowed,
  };
}

// ---------------------------------------------------------------------------
// Content checks (first chunk magic, WAV size, ZIP central directory)
// ---------------------------------------------------------------------------

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b, o) => u32(b, o) + u32(b, o + 4) * 2 ** 32;
const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));

/**
 * Magic-byte check on the head of the file (first chunk, or the inflated head for gzip).
 * `logicalBytes` is the real (decoded) file size, used for the WAV header size check.
 */
export function checkMagic(ext, head, logicalBytes) {
  const b = head;
  if (ext === "wav") {
    if (b.length < 12 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WAVE") return { ok: false, detail: "not_riff_wave" };
    const riff = u32(b, 4);
    if (riff !== 0 && riff !== 0xffffffff) {
      const declared = riff + 8;
      // Allow one pad byte either way; reject truncated or padded-with-junk files.
      if (Math.abs(declared - logicalBytes) > 1) return { ok: false, detail: "wav_riff_size_mismatch", declared, actual: logicalBytes };
    }
    // Walk chunks inside the head to find `data`, then compare its size with the file size.
    let off = 12;
    while (off + 8 <= b.length) {
      const id = ascii(b, off, 4);
      const size = u32(b, off + 4);
      if (id === "data") {
        if (size !== 0xffffffff && off + 8 + size > logicalBytes) return { ok: false, detail: "wav_data_size_exceeds_file", data_bytes: size };
        return { ok: true, mime: "audio/wav" };
      }
      off += 8 + size + (size & 1);
    }
    return { ok: true, mime: "audio/wav", note: "data chunk beyond first chunk" };
  }
  if (ext === "mp3") {
    const id3 = b.length >= 3 && ascii(b, 0, 3) === "ID3";
    const frame = b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0;
    return id3 || frame ? { ok: true, mime: "audio/mpeg" } : { ok: false, detail: "not_mp3" };
  }
  if (ext === "zip") {
    if (b.length >= 4 && u32(b, 0) === 0x04034b50) return { ok: true, mime: "application/zip" };
    return { ok: false, detail: "not_zip_local_header" };
  }
  if (ext === "mp4") {
    if (b.length < 12 || ascii(b, 4, 4) !== "ftyp") return { ok: false, detail: "no_ftyp" };
    const boxSize = be32(b, 0); // ISO BMFF is big-endian
    if (boxSize < 8 || boxSize > Math.min(4096, logicalBytes)) return { ok: false, detail: "bad_ftyp_size" };
    if (!/^[\x20-\x7e]{4}$/.test(ascii(b, 8, 4))) return { ok: false, detail: "bad_major_brand" };
    return { ok: true, mime: "video/mp4" };
  }
  return { ok: false, detail: "no_magic_rule" };
}

/** Inflate only the first `maxOut` bytes of a gzip stream held in `bytes` (P8). */
export async function inflateGzipHead(bytes, maxOut = 65536) {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return null;
  const input = bytes.subarray(0, Math.min(bytes.length, 256 * 1024));
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  (async () => { try { await writer.write(input); await writer.close(); } catch { /* truncated stream is expected */ } })();
  const parts = [];
  let n = 0;
  try {
    while (n < maxOut) {
      const { value, done } = await reader.read();
      if (done) break;
      parts.push(value);
      n += value.length;
    }
  } catch { /* truncated input: keep what was inflated */ }
  try { await reader.cancel(); } catch { /* ignore */ }
  const out = new Uint8Array(Math.min(n, maxOut));
  let off = 0;
  for (const p of parts) {
    if (off >= out.length) break;
    const take = Math.min(p.length, out.length - off);
    out.set(p.subarray(0, take), off);
    off += take;
  }
  return out;
}

/** Locate the End Of Central Directory record inside `tail` (the last bytes of the file). */
export function findEocd(tail) {
  const min = Math.max(0, tail.length - (22 + 65535));
  for (let i = tail.length - 22; i >= min; i -= 1) {
    if (u32(tail, i) === 0x06054b50) return i;
  }
  return -1;
}

export function zipEntryProblem(name, externalAttrs, blockedExts) {
  if (!name) return "empty_name";
  if (name.includes("\0")) return "nul_in_name";
  if (name.includes("\\")) return "backslash_path";
  if (name.startsWith("/")) return "absolute_path";
  if (/^[a-zA-Z]:/.test(name)) return "drive_path";
  if (name.split("/").includes("..")) return "dotdot_path";
  const mode = (externalAttrs >>> 16) & 0xffff;
  if ((mode & 0xf000) === 0xa000) return "symlink";
  const base = name.endsWith("/") ? "" : name.split("/").pop();
  const ext = base.includes(".") ? base.split(".").pop().toLowerCase() : "";
  if (ext && blockedExts.includes(ext)) return "blocked_ext";
  return "";
}

/**
 * ZIP central-directory safety from the tail of the file.
 * `readRange(start, end)` returns bytes [start, end) of the logical file, reading only the chunks needed.
 */
export async function checkZipCentralDirectory({ totalBytes, readRange, maxEntries, maxCdBytes, blockedExts }) {
  const tailLen = Math.min(totalBytes, 22 + 65535);
  const tail = await readRange(totalBytes - tailLen, totalBytes);
  const e = findEocd(tail);
  if (e < 0) return { ok: false, detail: "no_eocd" };
  const eocdAbs = totalBytes - tailLen + e;
  let entries = u16(tail, e + 10);
  let cdSize = u32(tail, e + 12);
  let cdOffset = u32(tail, e + 16);
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    // ZIP64: locator sits 20 bytes before the EOCD.
    const loc = e - 20;
    if (loc < 0 || u32(tail, loc) !== 0x07064b50) return { ok: false, detail: "zip64_locator_missing" };
    const recAbs = u64(tail, loc + 8);
    if (recAbs + 56 > eocdAbs) return { ok: false, detail: "zip64_record_out_of_range" };
    const rec = await readRange(recAbs, recAbs + 56);
    if (u32(rec, 0) !== 0x06064b50) return { ok: false, detail: "zip64_record_bad_signature" };
    entries = u64(rec, 32);
    cdSize = u64(rec, 40);
    cdOffset = u64(rec, 48);
  }
  if (entries === 0) return { ok: false, detail: "empty_zip" };
  if (entries > maxEntries) return { ok: false, detail: "too_many_entries", entries, max_entries: maxEntries };
  if (cdSize > maxCdBytes) return { ok: false, detail: "central_directory_too_large", cd_bytes: cdSize };
  if (cdOffset + cdSize > eocdAbs) return { ok: false, detail: "central_directory_out_of_range" };
  const cd = await readRange(cdOffset, cdOffset + cdSize);
  let off = 0;
  let seen = 0;
  while (off + 46 <= cd.length) {
    if (u32(cd, off) !== 0x02014b50) return { ok: false, detail: "bad_cd_signature", entry: seen };
    const flags = u16(cd, off + 8);
    const nameLen = u16(cd, off + 28);
    const extraLen = u16(cd, off + 30);
    const commentLen = u16(cd, off + 32);
    const external = u32(cd, off + 38);
    if (off + 46 + nameLen > cd.length) return { ok: false, detail: "truncated_cd_entry", entry: seen };
    const raw = cd.subarray(off + 46, off + 46 + nameLen);
    const name = (flags & 0x800) ? new TextDecoder("utf-8").decode(raw) : String.fromCharCode(...raw);
    const problem = zipEntryProblem(name, external, blockedExts);
    if (problem) return { ok: false, detail: problem, entry: seen, name: name.slice(0, 200) };
    seen += 1;
    if (seen > maxEntries) return { ok: false, detail: "too_many_entries", entries: seen, max_entries: maxEntries };
    off += 46 + nameLen + extraLen + commentLen;
  }
  if (seen !== entries) return { ok: false, detail: "entry_count_mismatch", declared: entries, parsed: seen };
  return { ok: true, entries: seen };
}

// ---------------------------------------------------------------------------
// Authorizers. Each Edge Function passes one in; roles are NOT decided here.
// ---------------------------------------------------------------------------

/**
 * beatbay-manager: owner/admin may target any beat; everyone else (staff) is
 * draft-only, the same rule as the existing create_upload/attach_asset paths.
 */
export function beatbayAuthorizer({ ownerTier, getBeat }) {
  return async (beatId) => {
    const beat = await getBeat(beatId);
    if (!beat) return { ok: false, status: 404, code: ERR.BEAT_NOT_FOUND };
    if (!ownerTier && (beat.status !== "draft" || beat.storefront_enabled)) return { ok: false, status: 403, code: ERR.FORBIDDEN, reason: "Published or active beats require owner approval" };
    return { ok: true, beat };
  };
}

/** studio-manager (Henry, music_uploader): explicit assignment AND draft/non-storefront. Never owner tier. */
export function studioAuthorizer({ isAssigned, getBeat }) {
  return async (beatId) => {
    if (!(await isAssigned(beatId))) return { ok: false, status: 403, code: ERR.FORBIDDEN, reason: "Beat is not assigned to you" };
    const beat = await getBeat(beatId);
    if (!beat) return { ok: false, status: 404, code: ERR.BEAT_NOT_FOUND };
    if (beat.status !== "draft" || beat.storefront_enabled) return { ok: false, status: 403, code: ERR.FORBIDDEN, reason: "Published or active beats require owner approval" };
    return { ok: true, beat };
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {object} deps.db       DB adapter (see createSupabaseAdapters / tests/fakes)
 * @param {object} deps.storage  Storage adapter bound to the private bucket
 * @param {string} deps.bucket   private bucket id (release-private)
 * @param {string} deps.origin   "beatbay_manager" | "studio_manager" (which Edge Function created the session)
 * @param {() => number} [deps.now]
 * @param {() => string} [deps.randomUUID]
 * @param {(event: object) => Promise<void>} [deps.audit]  start/complete/fail/abort/attach audit hook
 * @param {(msg: string) => void} [deps.log]
 */
export function createUploadService(deps) {
  const { db, storage, bucket, origin } = deps;
  const now = deps.now ?? (() => Date.now());
  const randomUUID = deps.randomUUID ?? (() => crypto.randomUUID());
  const audit = deps.audit ?? (async () => {});
  const log = deps.log ?? (() => {});
  const iso = (ms = now()) => new Date(ms).toISOString();

  async function limits() {
    return normalizeLimits(await db.getLimits());
  }

  async function usage(L) {
    const u = await db.storageUsage(L.budget_bucket_ids);
    const used = Number(u?.used_bytes ?? 0);
    const reserved = Number(u?.reserved_bytes ?? 0);
    return {
      used_bytes: used,
      reserved_bytes: reserved,
      max_total_upload_bytes: L.max_total_upload_bytes,
      remaining_bytes: Math.max(0, L.max_total_upload_bytes - used - reserved),
      scope: L.budget_bucket_ids ? L.budget_bucket_ids : "project",
    };
  }

  const isExpired = (s) => new Date(s.expires_at).getTime() <= now();

  async function loadSession(sessionId, ctx, { allowOwnerTier = true } = {}) {
    if (!isUuid(sessionId)) fail(ERR.BAD_REQUEST, 400, "session_id must be a UUID.");
    const s = await db.getSession(sessionId);
    if (!s) fail(ERR.SESSION_NOT_FOUND, 404, "Upload session not found.");
    const mine = s.created_by === ctx.user.id;
    if (!mine && !(allowOwnerTier && ctx.ownerTier)) fail(ERR.FORBIDDEN, 403, "This upload session belongs to another user.");
    return s;
  }

  async function expireIfNeeded(s) {
    if (RESUMABLE_STATES.includes(s.status) && isExpired(s)) {
      await db.casSession(s.id, RESUMABLE_STATES, { status: "expired", updated_at: iso() });
      fail(ERR.SESSION_EXPIRED, 410, "Upload session expired. Start again.", { session_id: s.id, expires_at: s.expires_at });
    }
    if (s.status === "expired") fail(ERR.SESSION_EXPIRED, 410, "Upload session expired. Start again.", { session_id: s.id });
  }

  async function removeSessionParts(sessionId) {
    const prefix = sessionPrefix(sessionId);
    const objects = await storage.list(prefix.slice(0, -1));
    const paths = objects.map((o) => `${prefix}${o.name}`).filter((p) => isSafeUploadObject(p, sessionId));
    if (paths.length) await storage.remove(paths);
    return paths.length;
  }

  async function failSession(s, code, detail) {
    await db.casSession(s.id, ["open", "complete"], { status: "failed", failure_code: code, updated_at: iso() });
    let removed = 0;
    try {
      removed = await removeSessionParts(s.id);
      await db.updateSession(s.id, { parts_purged_at: iso() });
    } catch (error) {
      log(`upload parts cleanup deferred for ${s.id}: ${error?.message ?? error}`);
    }
    await audit({ action: "upload_failed", session: s, details: { code, ...(detail ?? {}), removed } });
    return removed;
  }

  function statusPayload(s, chunks, L, storageUsage) {
    const missing = [];
    const bad = [];
    const attempts = {};
    let verified = 0;
    for (const c of chunks) {
      if (c.status === "verified") verified += 1;
      else if (c.status === "bad") bad.push(c.idx);
      else missing.push(c.idx);
      if (c.attempts > 0) attempts[c.idx] = c.attempts;
    }
    return {
      protocol: PROTOCOL_VERSION,
      session_id: s.id,
      status: s.status,
      beat_id: s.beat_id,
      kind: s.kind,
      filename: s.filename,
      ext: s.ext,
      mime: s.declared_mime,
      encoding: s.encoding,
      original_bytes: s.original_bytes ?? null,
      total_bytes: Number(s.total_bytes),
      chunk_bytes: Number(s.chunk_bytes),
      chunk_count: Number(s.chunk_count),
      hash_mode: s.hash_mode,
      verified_count: verified,
      missing,
      bad,
      attempts,
      expires_at: s.expires_at,
      manifest_path: s.manifest_path ?? null,
      manifest_root_sha256: s.manifest_root_sha256 ?? null,
      failure_code: s.failure_code ?? null,
      limits: publicLimits(L),
      storage: storageUsage,
    };
  }

  function validHash(value, field) {
    const v = String(value ?? "").toLowerCase();
    if (!isHex64(v)) fail(ERR.BAD_REQUEST, 400, `${field} must be a lowercase hex SHA-256.`, { field });
    return v;
  }

  // ---- start_upload -------------------------------------------------------
  async function startUpload(body, ctx) {
    const L = await limits();
    if (body.dry_run === true) {
      return { status: 200, body: { protocol: PROTOCOL_VERSION, dry_run: true, limits: publicLimits(L), storage: await usage(L) } };
    }
    const kind = String(body.kind ?? "");
    if (!UPLOAD_KINDS.includes(kind) || !L.allowed[kind]) fail(ERR.BAD_REQUEST, 400, "kind must be full, stems, video, or zip.", { field: "kind" });
    const beatId = String(body.beat_id ?? "");
    if (!isUuid(beatId)) fail(ERR.BAD_REQUEST, 400, "beat_id must be a UUID.", { field: "beat_id" });
    const auth = await ctx.authorizeBeat(beatId);
    if (!auth.ok) fail(auth.code ?? ERR.FORBIDDEN, auth.status ?? 403, auth.reason ?? "Not allowed for this beat.");

    const filename = String(body.filename ?? "").trim();
    if (!filename || filename.length > 255 || /[\u0000-\u001f\u007f/\\]/.test(filename)) fail(ERR.BAD_REQUEST, 400, "filename must be a plain file name (max 255).", { field: "filename" });
    const ext = safeExt(filename);
    const mime = L.allowed[kind]?.[ext];
    if (!ext || !mime) fail(ERR.EXT_NOT_ALLOWED, 400, `.${ext || "?"} is not allowed for ${kind}.`, { kind, ext, allowed: Object.keys(L.allowed[kind] ?? {}) });

    const encoding = String(body.encoding ?? "identity");
    if (!["identity", "gzip"].includes(encoding)) fail(ERR.BAD_REQUEST, 400, "encoding must be identity or gzip.", { field: "encoding" });
    let originalBytes = null;
    let originalSha = null;
    if (encoding === "gzip") {
      if (kind !== "full" || !L.compressible_exts.includes(ext)) fail(ERR.EXT_NOT_ALLOWED, 400, `gzip encoding is not allowed for .${ext}.`, { kind, ext, compressible_exts: L.compressible_exts });
      if (!posInt(body.original_bytes)) fail(ERR.BAD_REQUEST, 400, "original_bytes is required for gzip.", { field: "original_bytes" });
      originalBytes = Number(body.original_bytes);
      if (originalBytes > L.compress_max_bytes) fail(ERR.LIMIT_EXCEEDED, 413, "File is too large to compress.", { limit: "compress_max_bytes", max: L.compress_max_bytes });
      if (body.original_sha256 != null) originalSha = validHash(body.original_sha256, "original_sha256");
    }

    if (!posInt(body.total_bytes)) fail(ERR.BAD_REQUEST, 400, "total_bytes must be a positive integer.", { field: "total_bytes" });
    const totalBytes = Number(body.total_bytes);
    if (totalBytes > L.max_file_bytes) fail(ERR.LIMIT_EXCEEDED, 413, "File is larger than the configured maximum.", { limit: "max_file_bytes", max: L.max_file_bytes, total_bytes: totalBytes });

    let chunkBytes = L.chunk_bytes;
    if (body.chunk_bytes != null) {
      if (!posInt(body.chunk_bytes) || Number(body.chunk_bytes) > L.chunk_bytes || Number(body.chunk_bytes) < L.min_chunk_bytes) {
        fail(ERR.LIMIT_EXCEEDED, 400, "chunk_bytes is outside the allowed range.", { limit: "chunk_bytes", min: L.min_chunk_bytes, max: L.chunk_bytes });
      }
      chunkBytes = Number(body.chunk_bytes);
    }
    const { count, sizeOf } = chunkMath(totalBytes, chunkBytes);

    // Hashes: up-front list (design) or deferred (DEV P9). Either way idx 0 is known at start.
    let chunkHashes = null;
    if (body.chunk_sha256 != null) {
      if (!Array.isArray(body.chunk_sha256) || body.chunk_sha256.length !== count) fail(ERR.BAD_REQUEST, 400, `chunk_sha256 must list exactly ${count} hashes.`, { field: "chunk_sha256", chunk_count: count });
      chunkHashes = body.chunk_sha256.map((h, i) => validHash(h, `chunk_sha256[${i}]`));
    }
    let head = body.head_sha256 != null ? validHash(body.head_sha256, "head_sha256") : null;
    if (chunkHashes && head && head !== chunkHashes[0]) fail(ERR.HASH_CONFLICT, 409, "head_sha256 does not match chunk_sha256[0].");
    head = head ?? chunkHashes?.[0] ?? null;
    if (!head) fail(ERR.BAD_REQUEST, 400, "Send chunk_sha256[] or head_sha256.", { field: "head_sha256" });
    const fileSha = body.file_sha256 != null ? validHash(body.file_sha256, "file_sha256") : null;

    // Resume: same user + beat + kind + size + head hash + encoding + chunk size.
    const key = { created_by: ctx.user.id, beat_id: beatId, kind, total_bytes: totalBytes, head_sha256: head, encoding, chunk_bytes: chunkBytes };
    let existing = await db.findResumable(key);
    let replaced = null;
    if (existing) {
      if (isExpired(existing)) {
        await db.casSession(existing.id, RESUMABLE_STATES, { status: "expired", updated_at: iso() });
        existing = null;
      } else {
        const chunks = await db.listChunks(existing.id);
        const conflict = (fileSha && existing.file_sha256 && fileSha !== existing.file_sha256)
          || (chunkHashes && existing.hash_mode === "upfront" && chunks.some((c) => c.sha256 && c.sha256 !== chunkHashes[c.idx]));
        if (!conflict) {
          return { status: 200, body: { ...statusPayload(existing, chunks, L, await usage(L)), resumed: true } };
        }
        // Same head chunk + size but a different file: retire the old session (same owner) and start fresh.
        if (existing.status === "verified") fail(ERR.HASH_CONFLICT, 409, "A verified upload with the same head exists. Attach or abort it first.", { session_id: existing.id });
        await abortInternal(existing, "replaced");
        replaced = existing.id;
      }
    }

    const open = await db.countOpenSessions(ctx.user.id, iso());
    if (open >= L.max_open_sessions_per_user) fail(ERR.LIMIT_EXCEEDED, 429, "Too many uploads in progress. Finish or cancel one first.", { limit: "max_open_sessions_per_user", max: L.max_open_sessions_per_user });

    // Free space first (bounded), then check the Free-plan storage budget.
    try { await cleanup({ limit: 5, orphanSweep: false }); } catch (error) { log(`opportunistic cleanup skipped: ${error?.message ?? error}`); }
    const u = await usage(L);
    if (u.used_bytes + u.reserved_bytes + totalBytes > L.max_total_upload_bytes) {
      fail(ERR.STORAGE_BUDGET_EXCEEDED, 507, "Not enough project storage left for this upload.", { storage: u, total_bytes: totalBytes });
    }

    const id = randomUUID();
    const t = now();
    const row = {
      id,
      origin,
      beat_id: beatId,
      created_by: ctx.user.id,
      kind,
      filename,
      ext,
      declared_mime: mime,
      encoding,
      original_bytes: originalBytes,
      original_sha256: originalSha,
      total_bytes: totalBytes,
      chunk_bytes: chunkBytes,
      chunk_count: count,
      hash_mode: chunkHashes ? "upfront" : "deferred",
      head_sha256: head,
      file_sha256: fileSha,
      manifest_root_sha256: null,
      manifest_path: null,
      status: "open",
      bucket,
      storage_prefix: sessionPrefix(id),
      failure_code: null,
      expires_at: iso(t + L.session_ttl_seconds * 1000),
      created_at: iso(t),
      updated_at: iso(t),
    };
    const chunks = Array.from({ length: count }, (_, idx) => ({
      session_id: id,
      idx,
      bytes: sizeOf(idx),
      sha256: chunkHashes ? chunkHashes[idx] : (idx === 0 ? head : null),
      status: "pending",
      attempts: 0,
    }));
    const inserted = await db.insertSession(row, chunks);
    if (!inserted) {
      // Lost an idempotency race; return the winner.
      const winner = await db.findResumable(key);
      if (winner) return { status: 200, body: { ...statusPayload(winner, await db.listChunks(winner.id), L, u), resumed: true } };
      fail(ERR.STORAGE_ERROR, 500, "Could not create the upload session.");
    }
    await audit({ action: "upload_started", session: row, details: { kind, total_bytes: totalBytes, chunk_count: count, encoding } });
    return { status: 201, body: { ...statusPayload(row, chunks, L, { ...u, reserved_bytes: u.reserved_bytes + totalBytes, remaining_bytes: Math.max(0, u.remaining_bytes - totalBytes) }), resumed: false, replaced_session_id: replaced } };
  }

  function requireOpen(s) {
    if (s.status !== "open") fail(ERR.INVALID_STATE, 409, `Session is ${s.status}.`, { session_status: s.status });
  }

  function parseIdx(value, count) {
    const idx = Number(value);
    if (!Number.isInteger(idx) || idx < 0 || idx >= count) fail(ERR.CHUNK_OUT_OF_RANGE, 400, `idx must be 0..${count - 1}.`, { idx: value, chunk_count: count });
    return idx;
  }

  /** Declare/confirm the expected hash for a not-yet-verified chunk. Returns the effective hash (or null). */
  async function declareHash(s, chunk, claimed) {
    if (claimed == null) return chunk.sha256 ?? null;
    const h = validHash(claimed, `sha256[${chunk.idx}]`);
    if (chunk.sha256 === h) return h;
    if (chunk.idx === 0 && h !== s.head_sha256) fail(ERR.HASH_CONFLICT, 409, "Chunk 0 hash must equal head_sha256 (different file?).", { idx: 0 });
    if (s.hash_mode === "upfront" && chunk.sha256) fail(ERR.HASH_CONFLICT, 409, "Chunk hash differs from the one declared at start (file changed?).", { idx: chunk.idx });
    if (chunk.status === "verified") return chunk.sha256;
    await db.updateChunk(s.id, chunk.idx, { sha256: h }, { notStatus: "verified" });
    chunk.sha256 = h;
    return h;
  }

  // ---- chunk_ticket -------------------------------------------------------
  async function chunkTicket(body, ctx) {
    const L = await limits();
    const s = await loadSession(body.session_id, ctx, { allowOwnerTier: false });
    await expireIfNeeded(s);
    requireOpen(s);
    const list = Array.isArray(body.idx) ? body.idx : [body.idx];
    if (!list.length || list[0] === undefined) fail(ERR.BAD_REQUEST, 400, "idx is required.", { field: "idx" });
    if (list.length > L.ticket_batch_max) fail(ERR.LIMIT_EXCEEDED, 400, `At most ${L.ticket_batch_max} tickets per call.`, { limit: "ticket_batch_max", max: L.ticket_batch_max });
    const hashes = body.sha256 == null ? null : (Array.isArray(body.sha256) ? body.sha256 : [body.sha256]);
    if (hashes && hashes.length !== list.length) fail(ERR.BAD_REQUEST, 400, "sha256[] must line up with idx[].", { field: "sha256" });
    const count = Number(s.chunk_count);
    const idxs = list.map((v) => parseIdx(v, count));
    if (new Set(idxs).size !== idxs.length) fail(ERR.BAD_REQUEST, 400, "idx[] has duplicates.", { field: "idx" });
    const chunks = new Map((await db.listChunks(s.id)).map((c) => [c.idx, c]));
    const tickets = [];
    const skipped = [];
    for (let i = 0; i < idxs.length; i += 1) {
      const c = chunks.get(idxs[i]);
      if (c.status === "verified") { skipped.push({ idx: c.idx, reason: "verified" }); continue; }
      if (c.attempts >= L.max_attempts) fail(ERR.LIMIT_EXCEEDED, 409, `Chunk ${c.idx} used all ${L.max_attempts} attempts.`, { limit: "max_attempts", idx: c.idx });
      const expected = await declareHash(s, c, hashes ? hashes[i] : null);
      const path = partPath(s.id, c.idx);
      const signed = await storage.signUpload(path, L.ticket_ttl_seconds);
      if (!signed) fail(ERR.STORAGE_ERROR, 502, "Could not sign the chunk upload.");
      await db.updateChunk(s.id, c.idx, { status: "ticketed", ticketed_at: iso() }, { notStatus: "verified" });
      tickets.push({
        idx: c.idx,
        method: "PUT",
        bucket,
        path,
        signed_url: signed.signedUrl,
        token: signed.token,
        headers: { "content-type": s.declared_mime, "x-upsert": "false" },
        bytes: Number(c.bytes),
        sha256: expected,
        expires_in: signed.expiresIn,
      });
    }
    return { status: 200, body: { session_id: s.id, tickets, skipped } };
  }

  // ---- chunk_done ---------------------------------------------------------
  async function chunkDone(body, ctx) {
    const L = await limits();
    const s = await loadSession(body.session_id, ctx, { allowOwnerTier: false });
    const count = Number(s.chunk_count);
    const idx = parseIdx(body.idx, count);
    const chunk = await db.getChunk(s.id, idx);
    if (chunk.status === "verified") {
      // Duplicate chunk_done: no-op. The object cannot be overwritten (upsert=false + verified lock).
      return { status: 200, body: { session_id: s.id, idx, status: "verified", duplicate: true } };
    }
    await expireIfNeeded(s);
    requireOpen(s);
    if (chunk.attempts >= L.max_attempts) fail(ERR.LIMIT_EXCEEDED, 409, `Chunk ${idx} used all attempts.`, { limit: "max_attempts", idx });
    const expected = await declareHash(s, chunk, body.sha256);
    if (!expected) fail(ERR.BAD_REQUEST, 400, "No SHA-256 declared for this chunk. Send sha256.", { field: "sha256", idx });
    const path = partPath(s.id, idx);
    const bytes = await storage.download(path);
    if (!bytes) fail(ERR.CHUNK_MISSING, 409, "Chunk object not found. PUT it first.", { idx });
    const wantBytes = Number(chunk.bytes);
    let code = null;
    let extra = {};
    if (bytes.byteLength !== wantBytes) {
      code = ERR.CHUNK_SIZE_MISMATCH;
      extra = { expected_bytes: wantBytes, received_bytes: bytes.byteLength };
    } else {
      const got = await sha256Hex(bytes);
      if (got !== expected) { code = ERR.CHUNK_HASH_MISMATCH; extra = { expected_sha256: expected, received_sha256: got }; }
    }
    if (code) {
      await storage.remove([path]);
      const attempts = Number(chunk.attempts) + 1;
      await db.updateChunk(s.id, idx, { status: "bad", attempts }, { notStatus: "verified" });
      const exhausted = attempts >= L.max_attempts;
      if (exhausted) await failSession(s, code, { idx, attempts });
      fail(code, 422, code === ERR.CHUNK_SIZE_MISMATCH ? "Chunk size does not match." : "Chunk SHA-256 does not match.", {
        idx, attempts, max_attempts: L.max_attempts, retryable: !exhausted, session_status: exhausted ? "failed" : "open", ...extra,
      });
    }
    const won = await db.updateChunk(s.id, idx, { status: "verified", verified_at: iso() }, { notStatus: "verified" });
    const all = await db.listChunks(s.id);
    const verified = all.filter((c) => c.status === "verified").length;
    return { status: 200, body: { session_id: s.id, idx, status: "verified", duplicate: !won, verified_count: verified, chunk_count: count, all_verified: verified === count } };
  }

  // ---- upload_status ------------------------------------------------------
  async function uploadStatus(body, ctx) {
    const L = await limits();
    const s = await loadSession(body.session_id, ctx);
    await expireIfNeeded(s);
    return { status: 200, body: statusPayload(s, await db.listChunks(s.id), L, await usage(L)) };
  }

  // ---- complete_upload ----------------------------------------------------
  async function completeUpload(body, ctx) {
    const L = await limits();
    const s = await loadSession(body.session_id, ctx, { allowOwnerTier: false });
    const fileSha = body.file_sha256 != null ? validHash(body.file_sha256, "file_sha256") : null;
    if (s.status === "verified" || s.status === "attached") {
      return { status: 200, body: completeBody(s, true) };
    }
    await expireIfNeeded(s);
    const staleLock = s.status === "complete" && now() - new Date(s.updated_at).getTime() > STALE_COMPLETE_LOCK_MS;
    if (s.status !== "open" && !staleLock) fail(ERR.INVALID_STATE, 409, `Session is ${s.status}.`, { session_status: s.status });
    if (fileSha && s.file_sha256 && fileSha !== s.file_sha256) fail(ERR.HASH_CONFLICT, 409, "file_sha256 differs from the one sent at start.");
    const chunks = await db.listChunks(s.id);
    const notReady = chunks.filter((c) => c.status !== "verified");
    if (notReady.length) {
      fail(ERR.INCOMPLETE, 409, "Some chunks are not verified yet.", {
        missing: notReady.filter((c) => c.status !== "bad").map((c) => c.idx),
        bad: notReady.filter((c) => c.status === "bad").map((c) => c.idx),
      });
    }
    const locked = await db.casSession(s.id, staleLock ? ["complete"] : ["open"], { status: "complete", updated_at: iso() });
    if (!locked) fail(ERR.INVALID_STATE, 409, "Another completion is in progress.");

    const total = Number(s.total_bytes);
    const cb = Number(s.chunk_bytes);
    const byIdx = new Map(chunks.map((c) => [c.idx, c]));
    const cache = new Map();
    // Read one verified chunk and re-check its hash (tamper guard). Only chunk-sized buffers.
    async function readChunk(idx) {
      if (cache.has(idx)) return cache.get(idx);
      const bytes = await storage.download(partPath(s.id, idx));
      const c = byIdx.get(idx);
      if (!bytes || bytes.byteLength !== Number(c.bytes) || (await sha256Hex(bytes)) !== c.sha256) {
        throw new UploadError(ERR.CHUNK_HASH_MISMATCH, 422, "A verified chunk changed or disappeared.", { idx, reverify: true });
      }
      if (cache.size >= 2) cache.delete(cache.keys().next().value);
      cache.set(idx, bytes);
      return bytes;
    }
    async function readRange(start, end) {
      if (start < 0 || end > total || end < start) throw new UploadError(ERR.ZIP_UNSAFE, 422, "Range outside the file.", { detail: "range_out_of_file" });
      if (end - start > L.zip_max_cd_bytes + 65557) throw new UploadError(ERR.ZIP_UNSAFE, 422, "Central directory read too large.", { detail: "range_too_large" });
      const out = new Uint8Array(end - start);
      let pos = start;
      while (pos < end) {
        const idx = Math.floor(pos / cb);
        const chunk = await readChunk(idx);
        const from = pos - idx * cb;
        const take = Math.min(chunk.byteLength - from, end - pos);
        out.set(chunk.subarray(from, from + take), pos - start);
        pos += take;
      }
      return out;
    }

    try {
      const first = await readChunk(0);
      let head = first;
      let logical = total;
      if (s.encoding === "gzip") {
        head = await inflateGzipHead(first, 65536);
        if (!head) throw new UploadError(ERR.MAGIC_MISMATCH, 422, "Declared gzip but the data is not gzip.", { detail: "not_gzip" });
        logical = Number(s.original_bytes);
      }
      const magic = checkMagic(s.ext, head.subarray(0, Math.min(head.length, 65536)), logical);
      if (!magic.ok) throw new UploadError(ERR.MAGIC_MISMATCH, 422, `File content does not match .${s.ext}.`, { detail: magic.detail });
      let zip = null;
      if (s.ext === "zip") {
        zip = await checkZipCentralDirectory({ totalBytes: total, readRange, maxEntries: L.zip_max_entries, maxCdBytes: L.zip_max_cd_bytes, blockedExts: L.zip_blocked_exts });
        if (!zip.ok) throw new UploadError(ERR.ZIP_UNSAFE, 422, "ZIP failed the safety check.", { detail: zip.detail, ...(zip.name ? { name: zip.name } : {}), ...(zip.entries ? { entries: zip.entries } : {}) });
      }
      const ordered = [...chunks].sort((a, b) => a.idx - b.idx);
      const root = await manifestRoot(ordered.map((c) => c.sha256));
      const mPath = manifestPath(s.id);
      const verifiedAt = iso();
      const manifest = {
        version: 1,
        session_id: s.id,
        beat_id: s.beat_id,
        kind: s.kind,
        filename: s.filename,
        ext: s.ext,
        mime: s.declared_mime,
        encoding: s.encoding,
        original_bytes: s.original_bytes ?? null,
        original_sha256: s.original_sha256 ?? null,
        total_bytes: total,
        chunk_bytes: cb,
        chunk_count: ordered.length,
        file_sha256: fileSha ?? s.file_sha256 ?? null,
        file_sha256_verified: false,
        manifest_root_sha256: root,
        manifest_root_algo: "sha256(concat(binary chunk sha256 in idx order))",
        bucket,
        parts: ordered.map((c) => ({ idx: c.idx, path: partPath(s.id, c.idx), bytes: Number(c.bytes), sha256: c.sha256 })),
        zip_entries: zip?.entries ?? null,
        verified_at: verifiedAt,
      };
      const ok = await storage.upload(mPath, new TextEncoder().encode(JSON.stringify(manifest, null, 2)), "application/json", true);
      if (!ok) throw new UploadError(ERR.STORAGE_ERROR, 502, "Could not store the manifest.", {});
      const done = await db.casSession(s.id, ["complete"], {
        status: "verified", manifest_root_sha256: root, manifest_path: mPath, file_sha256: manifest.file_sha256, verified_at: verifiedAt, updated_at: verifiedAt,
      });
      if (!done) fail(ERR.INVALID_STATE, 409, "Session changed during completion.");
      await audit({ action: "upload_verified", session: s, details: { kind: s.kind, total_bytes: total, chunk_count: ordered.length, manifest_root_sha256: root } });
      return { status: 200, body: completeBody(done, false) };
    } catch (error) {
      if (error instanceof UploadError && [ERR.MAGIC_MISMATCH, ERR.ZIP_UNSAFE, ERR.CHUNK_HASH_MISMATCH].includes(error.code)) {
        await failSession({ ...s, status: "complete" }, error.code, error.details);
        error.details = { ...error.details, session_status: "failed", retryable: false };
        throw error;
      }
      // Transient (storage) failure: release the lock so the client can retry complete_upload.
      await db.casSession(s.id, ["complete"], { status: "open", updated_at: iso() });
      throw error;
    }
  }

  function completeBody(s, already) {
    return {
      session_id: s.id,
      status: s.status,
      already_verified: already,
      kind: s.kind,
      beat_id: s.beat_id,
      manifest_path: s.manifest_path,
      manifest_root_sha256: s.manifest_root_sha256,
      total_bytes: Number(s.total_bytes),
      chunk_count: Number(s.chunk_count),
      file_sha256: s.file_sha256 ?? null,
      file_sha256_verified: false,
    };
  }

  // ---- abort_upload -------------------------------------------------------
  async function abortInternal(s, reason) {
    const done = await db.casSession(s.id, ["open", "complete", "verified", "failed", "expired"], { status: "aborted", failure_code: reason === "replaced" ? "REPLACED" : null, updated_at: iso() });
    if (!done) return 0;
    const removed = await removeSessionParts(s.id);
    await db.updateSession(s.id, { parts_purged_at: iso() });
    await audit({ action: "upload_aborted", session: s, details: { reason, removed } });
    return removed;
  }

  async function abortUpload(body, ctx) {
    const s = await loadSession(body.session_id, ctx); // creator, or owner tier (DEV ask e)
    if (s.status === "aborted") return { status: 200, body: { session_id: s.id, status: "aborted", removed: 0, already_aborted: true } };
    if (s.status === "attached") fail(ERR.INVALID_STATE, 409, "Attached uploads are the stored master and cannot be aborted.", { session_status: s.status });
    const removed = await abortInternal(s, "user");
    return { status: 200, body: { session_id: s.id, status: "aborted", removed } };
  }

  // ---- attach (extension of attach_asset) ---------------------------------
  /**
   * Validates a verified session for attaching to a beat. Returns the beat changes the caller
   * should apply; the Edge Function applies them with its own client and audit.
   * Never touches status or storefront.
   */
  async function attachSession(body, ctx) {
    const beatId = String(body.id ?? body.beat_id ?? "");
    const kind = String(body.kind ?? "");
    if (!isUuid(beatId)) fail(ERR.BAD_REQUEST, 400, "Beat id must be a UUID.", { field: "id" });
    const s = await loadSession(body.session_id, ctx);
    if (s.beat_id !== beatId) fail(ERR.FORBIDDEN, 403, "This upload belongs to a different beat.");
    if (s.kind !== kind) fail(ERR.KIND_MISMATCH, 409, `Session kind is ${s.kind}, not ${kind}.`, { session_kind: s.kind });
    const auth = await ctx.authorizeBeat(beatId);
    if (!auth.ok) fail(auth.code ?? ERR.FORBIDDEN, auth.status ?? 403, auth.reason ?? "Not allowed for this beat.");
    if (s.status === "attached") {
      return { status: 200, body: { session_id: s.id, status: "attached", already_attached: true }, beatChanges: null, assetRow: null, session: s };
    }
    if (s.status === "verified" && isExpired(s)) fail(ERR.SESSION_EXPIRED, 410, "Verified upload expired before attach. Start again.");
    if (s.status !== "verified") fail(ERR.INVALID_STATE, 409, `Session is ${s.status}; complete_upload first.`, { session_status: s.status });
    const locked = await db.casSession(s.id, ["verified"], { status: "attached", attached_at: iso(), updated_at: iso() });
    if (!locked) fail(ERR.INVALID_STATE, 409, "Session changed; retry.");
    const beatChanges = kind === "full" ? { full_audio_bucket: bucket, full_audio_path: s.manifest_path } : null;
    const assetRow = kind === "full" ? null : {
      beat_id: beatId, kind, session_id: s.id, bucket, manifest_path: s.manifest_path, filename: s.filename,
      total_bytes: Number(s.total_bytes), created_by: ctx.user.id,
    };
    return {
      status: 200,
      body: { session_id: s.id, status: "attached", kind, manifest_path: s.manifest_path },
      beatChanges,
      assetRow,
      session: s,
      rollback: () => db.casSession(s.id, ["attached"], { status: "verified", attached_at: null, updated_at: iso() }),
    };
  }

  /** Apply an attach with the injected db adapter (used by both Edge Functions and tests). */
  async function attachAndApply(body, ctx) {
    const beatId = String(body.id ?? body.beat_id ?? "");
    const r = await attachSession(body, ctx);
    if (r.body.already_attached) return { status: 200, body: { ...r.body, beat: await db.getBeat(beatId) } };
    try {
      const beat = r.beatChanges ? await db.updateBeat(beatId, r.beatChanges) : await db.getBeat(beatId);
      if (r.assetRow) await db.upsertBeatAsset(r.assetRow);
      await audit({ action: "upload_attached", session: r.session, details: { kind: r.session.kind, manifest_path: r.session.manifest_path } });
      return { status: 200, body: { ...r.body, beat } };
    } catch (error) {
      await r.rollback();
      throw error;
    }
  }

  // ---- manifest download (owner full-master download; additive) -----------
  async function manifestDownload(path, ttlSeconds) {
    if (!isSessionManifestPath(path)) return null;
    const sessionId = path.split("/")[1];
    const s = await db.getSession(sessionId);
    if (!s || s.status !== "attached") return null;
    const chunks = (await db.listChunks(sessionId)).sort((a, b) => a.idx - b.idx);
    const paths = [path, ...chunks.map((c) => partPath(sessionId, c.idx))];
    const urls = await storage.signDownloads(paths, ttlSeconds);
    return {
      chunked: true,
      manifest_url: urls[0] ?? null,
      manifest: {
        session_id: s.id, filename: s.filename, ext: s.ext, mime: s.declared_mime, encoding: s.encoding,
        original_bytes: s.original_bytes ?? null, total_bytes: Number(s.total_bytes), chunk_bytes: Number(s.chunk_bytes),
        chunk_count: Number(s.chunk_count), file_sha256: s.file_sha256 ?? null, manifest_root_sha256: s.manifest_root_sha256,
      },
      parts: chunks.map((c, i) => ({ idx: c.idx, bytes: Number(c.bytes), sha256: c.sha256, url: urls[i + 1] ?? null })),
      expires_in: ttlSeconds,
    };
  }

  // ---- cleanup (hourly via owner action / opportunistic in start_upload) ---
  /**
   * Deletes parts via the Storage API (SQL cannot delete storage objects on Supabase).
   * Only ever touches `uploads/<uuid>/...`; never beatbay/<id>/full or release files; never attached sessions.
   */
  async function cleanup({ limit = 20, orphanSweep = true } = {}) {
    const report = { expired: 0, purged_sessions: 0, removed_objects: 0, orphan_folders: 0, skipped: [] };
    const candidates = await db.listCleanupCandidates(iso(), limit);
    for (const s of candidates) {
      if (s.status === "attached") continue; // defensive: never
      if (!isUuid(s.id) || s.storage_prefix !== sessionPrefix(s.id)) { report.skipped.push(s.id); continue; }
      if (RESUMABLE_STATES.includes(s.status)) {
        const moved = await db.casSession(s.id, RESUMABLE_STATES, { status: "expired", updated_at: iso() });
        if (!moved) continue;
        report.expired += 1;
      }
      report.removed_objects += await removeSessionParts(s.id);
      await db.updateSession(s.id, { parts_purged_at: iso() });
      report.purged_sessions += 1;
    }
    if (orphanSweep) {
      const folders = await storage.list(UPLOAD_PREFIX.slice(0, -1));
      const ids = folders.map((f) => f.name).filter(isUuid);
      const known = new Set(await db.existingSessionIds(ids));
      for (const id of ids) {
        if (known.has(id)) continue;
        const objects = await storage.list(sessionPrefix(id).slice(0, -1));
        const young = objects.some((o) => o.created_at && now() - new Date(o.created_at).getTime() < ORPHAN_MIN_AGE_MS);
        if (young) continue;
        const paths = objects.map((o) => `${sessionPrefix(id)}${o.name}`).filter((p) => isSafeUploadObject(p, id));
        if (paths.length) await storage.remove(paths);
        report.removed_objects += paths.length;
        report.orphan_folders += 1;
      }
    }
    return report;
  }

  const handlers = {
    start_upload: startUpload,
    chunk_ticket: chunkTicket,
    chunk_done: chunkDone,
    upload_status: uploadStatus,
    complete_upload: completeUpload,
    abort_upload: abortUpload,
  };

  /** Uniform entry point: returns {status, body}; never throws UploadError. */
  async function handle(action, body, ctx) {
    try {
      const fn = handlers[action];
      if (!fn) return errorResult(new UploadError(ERR.BAD_REQUEST, 400, "Unknown upload action."));
      return await fn(body ?? {}, ctx);
    } catch (error) {
      if (error instanceof UploadError) return errorResult(error);
      throw error;
    }
  }

  async function handleAttach(body, ctx) {
    try {
      return await attachAndApply(body ?? {}, ctx);
    } catch (error) {
      if (error instanceof UploadError) return errorResult(error);
      throw error;
    }
  }

  return { handle, handleAttach, attachSession, cleanup, manifestDownload, limits };
}

export function errorResult(error) {
  return { status: error.status, body: { error: error.message, code: error.code, ...error.details } };
}

/** True when an attach_asset / beatbay_attach_asset body is a session attach (small-file path otherwise). */
export function isSessionAttach(body) {
  return body != null && typeof body === "object" && body.session_id !== undefined && body.session_id !== null && body.session_id !== "";
}
