/**
 * In-memory fakes for the Issue #91 upload-session adapters (tests only).
 * They mirror the Supabase adapter semantics: CAS updates, upsert=false PUTs,
 * signed-ticket expiry, bucket MIME allowlist, and the Free 50 MB object cap.
 */
import { DEFAULT_LIMITS } from "../../supabase/functions/_shared/upload-sessions.mjs";

const clone = (v) => (v == null ? v : structuredClone(v));

export const RELEASE_PRIVATE_MIMES_AFTER_MIGRATION = [
  "application/json", "application/zip", "audio/mpeg", "audio/wav", "audio/x-wav", "image/jpeg", "image/png", "image/webp", "video/mp4",
];
export const FREE_GLOBAL_OBJECT_CAP = 50 * 1024 * 1024;

export function createClock(start = Date.parse("2026-09-25T12:00:00Z")) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; }, set: (ms) => { t = ms; } };
}

export function createFakeDb({ clock, limits = {}, storage }) {
  const state = {
    limits: { id: 1, ...structuredClone(DEFAULT_LIMITS), ...limits },
    sessions: new Map(),
    chunks: new Map(),
    beats: new Map(),
    assets: new Map(),
    failNextBeatUpdate: false,
  };
  const ckey = (id, idx) => `${id}:${idx}`;
  const chunksOf = (id) => [...state.chunks.values()].filter((c) => c.session_id === id).sort((a, b) => a.idx - b.idx);
  const nowIso = () => new Date(clock.now()).toISOString();
  return {
    state,
    addBeat(beat) { state.beats.set(beat.id, { status: "draft", storefront_enabled: false, full_audio_bucket: null, full_audio_path: null, ...beat }); },
    async getLimits() { return clone(state.limits); },
    async storageUsage(bucketIds) {
      const used = storage.usedBytes(bucketIds);
      let reserved = 0;
      for (const s of state.sessions.values()) {
        if (!["open", "complete"].includes(s.status) || Date.parse(s.expires_at) <= clock.now()) continue;
        const verified = chunksOf(s.id).filter((c) => c.status === "verified").reduce((a, c) => a + c.bytes, 0);
        reserved += Math.max(0, s.total_bytes - verified);
      }
      return { used_bytes: used, reserved_bytes: reserved };
    },
    async findResumable(key) {
      const rows = [...state.sessions.values()].filter((s) => ["open", "complete", "verified"].includes(s.status)
        && s.created_by === key.created_by && s.beat_id === key.beat_id && s.kind === key.kind && s.total_bytes === key.total_bytes
        && s.head_sha256 === key.head_sha256 && s.encoding === key.encoding && s.chunk_bytes === key.chunk_bytes);
      return clone(rows.sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null);
    },
    async insertSession(row, chunks) {
      const dup = await this.findResumable({ ...row });
      if (dup) return null; // unique partial index
      state.sessions.set(row.id, clone(row));
      for (const c of chunks) state.chunks.set(ckey(row.id, c.idx), clone(c));
      return row;
    },
    async getSession(id) { return clone(state.sessions.get(id) ?? null); },
    async casSession(id, from, patch) {
      const s = state.sessions.get(id);
      if (!s || !from.includes(s.status)) return null;
      Object.assign(s, clone(patch));
      return clone(s);
    },
    async updateSession(id, patch) { const s = state.sessions.get(id); if (s) Object.assign(s, clone(patch)); },
    async listChunks(id) { return clone(chunksOf(id)); },
    async getChunk(id, idx) { return clone(state.chunks.get(ckey(id, idx))); },
    async updateChunk(id, idx, patch, { notStatus } = {}) {
      const c = state.chunks.get(ckey(id, idx));
      if (!c || (notStatus && c.status === notStatus)) return false;
      Object.assign(c, clone(patch), { updated_at: nowIso() });
      return true;
    },
    async countOpenSessions(userId, iso) {
      return [...state.sessions.values()].filter((s) => s.created_by === userId && ["open", "complete"].includes(s.status) && s.expires_at > iso).length;
    },
    async listCleanupCandidates(iso, limit) {
      return clone([...state.sessions.values()].filter((s) => s.status !== "attached" && (
        (["open", "complete", "verified"].includes(s.status) && s.expires_at < iso)
        || (["failed", "aborted", "expired"].includes(s.status) && !s.parts_purged_at))).slice(0, limit));
    },
    async existingSessionIds(ids) { return ids.filter((id) => state.sessions.has(id)); },
    async getBeat(id) { return clone(state.beats.get(id) ?? null); },
    async updateBeat(id, patch) {
      if (state.failNextBeatUpdate) { state.failNextBeatUpdate = false; throw new Error("simulated beat update failure"); }
      const b = state.beats.get(id);
      Object.assign(b, clone(patch));
      return clone(b);
    },
    async listAttachedSessions(limit) {
      return clone([...state.sessions.values()].filter((s) => s.status === "attached" && !s.parts_purged_at).slice(0, limit));
    },
    async getBeatAsset(beatId, kind) { return clone(state.assets.get(`${beatId}:${kind}`) ?? null); },
    async upsertBeatAsset(row) { state.assets.set(`${row.beat_id}:${row.kind}`, clone(row)); },
  };
}

export function createFakeStorage({ clock, bucket = "release-private", allowedMimes = RELEASE_PRIVATE_MIMES_AFTER_MIGRATION }) {
  const objects = new Map(); // path -> { bytes, contentType, created_at }
  const tickets = new Map(); // token -> { path, expiresAt }
  const other = new Map(); // bucket -> bytes (objects outside this bucket, for the budget)
  const stats = { downloads: 0, downloadedBytes: 0, maxDownloadBytes: 0, puts: 0, removes: 0, signs: 0 };
  let n = 0;
  return {
    objects,
    stats,
    setOtherBucketBytes(id, bytes) { other.set(id, bytes); },
    usedBytes(bucketIds) {
      let total = 0;
      if (!bucketIds || bucketIds.includes(bucket)) for (const o of objects.values()) total += o.bytes.byteLength;
      for (const [id, bytes] of other) if (!bucketIds || bucketIds.includes(id)) total += bytes;
      return total;
    },
    seed(path, bytes, contentType = "application/octet-stream", createdAt = clock.now()) {
      objects.set(path, { bytes: new Uint8Array(bytes), contentType, created_at: new Date(createdAt).toISOString() });
    },
    async signUpload(path, expiresIn) {
      stats.signs += 1;
      const token = `t${++n}`;
      tickets.set(token, { path, expiresAt: clock.now() + expiresIn * 1000 });
      return { signedUrl: `https://fake.storage/v1/object/upload/sign/${bucket}/${path}?token=${token}`, token, expiresIn };
    },
    /** Simulates the browser PUT to a signed upload URL. Returns an HTTP-like status. */
    put(signedUrl, bytes, headers = {}) {
      stats.puts += 1;
      const url = new URL(signedUrl);
      const t = tickets.get(url.searchParams.get("token"));
      const path = decodeURIComponent(url.pathname.replace(`/v1/object/upload/sign/${bucket}/`, ""));
      if (!t || t.path !== path) return 403;
      if (clock.now() > t.expiresAt) return 400; // expired signature
      if (headers["x-upsert"] !== "false") return 400;
      if (!allowedMimes.includes(headers["content-type"])) return 415; // bucket allowlist
      if (bytes.byteLength > FREE_GLOBAL_OBJECT_CAP) return 413;
      if (objects.has(path)) return 409; // upsert=false
      objects.set(path, { bytes: new Uint8Array(bytes), contentType: headers["content-type"], created_at: new Date(clock.now()).toISOString() });
      return 200;
    },
    async download(path) {
      const o = objects.get(path);
      if (!o) return null;
      stats.downloads += 1;
      stats.downloadedBytes += o.bytes.byteLength;
      stats.maxDownloadBytes = Math.max(stats.maxDownloadBytes, o.bytes.byteLength);
      return new Uint8Array(o.bytes);
    },
    async upload(path, bytes, contentType, upsert = false) {
      if (!allowedMimes.includes(contentType)) return false;
      if (objects.has(path) && !upsert) return false;
      objects.set(path, { bytes: new Uint8Array(bytes), contentType, created_at: new Date(clock.now()).toISOString() });
      return true;
    },
    async list(prefix) {
      const base = `${prefix.replace(/\/$/, "")}/`;
      const names = new Map();
      for (const [path, o] of objects) {
        if (!path.startsWith(base)) continue;
        const rest = path.slice(base.length);
        const name = rest.split("/")[0];
        if (!names.has(name)) names.set(name, rest.includes("/") ? { name, created_at: null, size: null } : { name, created_at: o.created_at, size: o.bytes.byteLength });
      }
      return [...names.values()];
    },
    async remove(paths) {
      for (const p of paths) { if (objects.delete(p)) stats.removes += 1; }
    },
    async signDownloads(paths, ttl) {
      return paths.map((p) => (objects.has(p) ? `https://fake.storage/v1/object/sign/${bucket}/${p}?ttl=${ttl}` : null));
    },
  };
}
