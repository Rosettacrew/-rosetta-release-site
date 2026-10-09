/**
 * Issue #91 upload-session tests (node >= 20, also runs under `deno test -A`).
 *   node scripts/check-upload-sessions.mjs            # default suite
 *   ISSUE91_BIG=1 node scripts/check-upload-sessions.mjs   # + 1 GiB stored ZIP (slow, ~2 GB disk/RAM)
 * Uses in-memory adapter fakes. Real fixtures are generated in a temp dir:
 * WAV header+data, ZIPs built with the `zip` tool, MP3, and a tiny MP4 ftyp box.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  DEFAULT_LIMITS,
  ERR,
  UPLOAD_ACTIONS,
  beatbayAuthorizer,
  chunkMath,
  createUploadService,
  isSafeUploadObject,
  isSessionAttach,
  isSessionManifestPath,
  manifestRoot,
  studioAuthorizer,
  uploadAuditRouter,
} from "../supabase/functions/_shared/upload-sessions.mjs";
import { createClock, createFakeDb, createFakeStorage } from "./lib/upload-fakes.mjs";

const MiB = 1024 * 1024;
const KiB = 1024;
const TMP = mkdtempSync(join(tmpdir(), "issue91-"));
process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));

const OWNER = "00000000-0000-4000-8000-00000000000a";
const STAFF = "00000000-0000-4000-8000-00000000000b";
const HENRY = "00000000-0000-4000-8000-00000000000c";
const OTHER = "00000000-0000-4000-8000-00000000000d";
const BEAT = "10000000-0000-4000-8000-000000000001";
const BEAT_PUBLISHED = "10000000-0000-4000-8000-000000000002";
const BEAT_UNASSIGNED = "10000000-0000-4000-8000-000000000003";
const BEAT2 = "10000000-0000-4000-8000-000000000004";

// Small chunks keep most fixtures tiny; the 200 MiB test uses the real defaults.
const SMALL = { chunk_bytes: 256 * KiB, min_chunk_bytes: 64 * KiB };

// ---------------------------------------------------------------------------
// Fixtures (real files on disk)
// ---------------------------------------------------------------------------
function writeRandom(fd, bytes) {
  let left = bytes;
  while (left > 0) {
    const n = Math.min(left, 8 * MiB);
    writeSync(fd, randomBytes(n));
    left -= n;
  }
}
function wavHeader(dataBytes, { riffDelta = 0 } = {}) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + dataBytes + riffDelta, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(2, 22); // stereo
  h.writeUInt32LE(48000, 24);
  h.writeUInt32LE(48000 * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(dataBytes, 40);
  return h;
}
function makeWav(name, dataBytes, opts) {
  const path = join(TMP, name);
  const fd = openSync(path, "w");
  writeSync(fd, wavHeader(dataBytes, opts));
  writeRandom(fd, dataBytes);
  closeSync(fd);
  return path;
}
function makeMp3(name, bytes) {
  const path = join(TMP, name);
  writeFileSync(path, Buffer.concat([Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00", "latin1"), randomBytes(bytes)]));
  return path;
}
function makeMp4(name, mdatBytes) {
  const ftyp = Buffer.alloc(24);
  ftyp.writeUInt32BE(24, 0);
  ftyp.write("ftypisom", 4, "ascii");
  ftyp.writeUInt32BE(0x200, 12);
  ftyp.write("isommp41", 16, "ascii");
  const mdat = Buffer.alloc(8);
  mdat.writeUInt32BE(8 + mdatBytes, 0);
  mdat.write("mdat", 4, "ascii");
  const path = join(TMP, name);
  writeFileSync(path, Buffer.concat([ftyp, mdat, randomBytes(mdatBytes)]));
  return path;
}
let zipN = 0;
function makeZip(name, files, { store = true, symlinks = [] } = {}) {
  const dir = mkdtempSync(join(TMP, `z${++zipN}-`));
  for (const f of files) {
    const p = join(dir, f.name);
    execFileSync("mkdir", ["-p", join(p, "..")]);
    writeFileSync(p, f.bytes);
  }
  for (const s of symlinks) symlinkSync(s.target, join(dir, s.name));
  const out = join(TMP, name);
  const names = [...files.map((f) => f.name), ...symlinks.map((s) => s.name)];
  execFileSync("zip", ["-q", "-X", ...(store ? ["-0"] : []), ...(symlinks.length ? ["-y"] : []), out, ...names], { cwd: dir });
  return out;
}
/** Same-length binary patch of an entry name (local header + central directory). */
function patchZipName(path, from, to) {
  assert.equal(from.length, to.length);
  const buf = readFileSync(path);
  const a = Buffer.from(from, "latin1");
  let hits = 0;
  for (let i = buf.indexOf(a); i !== -1; i = buf.indexOf(a, i + 1)) { Buffer.from(to, "latin1").copy(buf, i); hits += 1; }
  assert.ok(hits >= 2, `patched ${hits} occurrences`);
  writeFileSync(path, buf);
  return path;
}

// ---------------------------------------------------------------------------
// Environment + client simulator
// ---------------------------------------------------------------------------
function makeEnv({ limits = {}, assigned = [BEAT], studioAudit = null } = {}) {
  const clock = createClock();
  const storage = createFakeStorage({ clock });
  const db = createFakeDb({ clock, limits, storage });
  db.addBeat({ id: BEAT });
  db.addBeat({ id: BEAT2 });
  db.addBeat({ id: BEAT_PUBLISHED, status: "available", storefront_enabled: true });
  db.addBeat({ id: BEAT_UNASSIGNED });
  const audits = [];
  const deps = { db, storage, bucket: "release-private", now: clock.now, audit: async (e) => { audits.push(e); } };
  const beatbay = createUploadService({ ...deps, origin: "beatbay_manager" });
  const studio = createUploadService({ ...deps, origin: "studio_manager", ...(studioAudit ? { audit: studioAudit } : {}) });
  const getBeat = (id) => db.getBeat(id);
  const assignedSet = new Set(assigned);
  const ctx = {
    owner: { user: { id: OWNER }, ownerTier: true, authorizeBeat: beatbayAuthorizer({ ownerTier: true, getBeat }) },
    staff: { user: { id: STAFF }, ownerTier: false, authorizeBeat: beatbayAuthorizer({ ownerTier: false, getBeat }) },
    other: { user: { id: OTHER }, ownerTier: false, authorizeBeat: beatbayAuthorizer({ ownerTier: false, getBeat }) },
    henry: { user: { id: HENRY }, ownerTier: false, authorizeBeat: studioAuthorizer({ isAssigned: async (id) => assignedSet.has(id), getBeat }) },
  };
  return { clock, storage, db, beatbay, studio, ctx, audits };
}

function openFile(path) {
  const fd = openSync(path, "r");
  const size = fstatSync(fd).size;
  return {
    size,
    read(start, end) {
      const buf = Buffer.alloc(end - start);
      readSync(fd, buf, 0, buf.length, start);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
    },
    close() { closeSync(fd); },
  };
}
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fileHashes(path, chunkBytes) {
  const f = openFile(path);
  const { count, sizeOf } = chunkMath(f.size, chunkBytes);
  const whole = createHash("sha256");
  const list = [];
  for (let i = 0; i < count; i += 1) {
    const b = f.read(i * chunkBytes, i * chunkBytes + sizeOf(i));
    list.push(sha(b));
    whole.update(b);
  }
  f.close();
  return { size: f.size, list, file: whole.digest("hex") };
}

async function start(env, svc, ctx, { path, beat_id = BEAT, kind = "full", filename, chunk_bytes, mode = "upfront", total_bytes, extra = {} }) {
  const L = await env.db.getLimits();
  const cb = chunk_bytes ?? L.chunk_bytes;
  const h = fileHashes(path, cb);
  const body = { beat_id, kind, filename: filename ?? path.split("/").pop(), total_bytes: total_bytes ?? h.size, chunk_bytes: cb, ...extra };
  if (mode === "upfront") Object.assign(body, { chunk_sha256: h.list, file_sha256: h.file });
  else body.head_sha256 = h.list[0];
  const r = await svc.handle("start_upload", body, ctx);
  return { r, h, cb };
}

/**
 * Upload chunks like DEV's client: batch tickets, PUT with ticket headers, chunk_done.
 * `corrupt(idx, bytes)` may return altered bytes for the PUT (simulates transport damage).
 */
async function sendChunks(env, svc, ctx, { path, session_id, cb, only, mode = "upfront", hashes, corrupt, doneSha = false, stopAfter = Infinity }) {
  const f = openFile(path);
  const status = await svc.handle("upload_status", { session_id }, ctx);
  assert.equal(status.status, 200, JSON.stringify(status.body));
  const todo = (only ?? [...status.body.missing, ...status.body.bad]).slice(0, stopAfter);
  const L = await env.db.getLimits();
  const results = [];
  for (let i = 0; i < todo.length; i += L.ticket_batch_max) {
    const batch = todo.slice(i, i + L.ticket_batch_max);
    const body = { session_id, idx: batch };
    if (mode === "deferred") body.sha256 = batch.map((idx) => hashes[idx]);
    const t = await svc.handle("chunk_ticket", body, ctx);
    assert.equal(t.status, 200, JSON.stringify(t.body));
    for (const ticket of t.body.tickets) {
      let bytes = f.read(ticket.idx * cb, ticket.idx * cb + ticket.bytes);
      if (corrupt) bytes = corrupt(ticket.idx, bytes) ?? bytes;
      const put = env.storage.put(ticket.signed_url, bytes, ticket.headers);
      const done = await svc.handle("chunk_done", { session_id, idx: ticket.idx, ...(doneSha ? { sha256: hashes[ticket.idx] } : {}) }, ctx);
      results.push({ idx: ticket.idx, put, done });
    }
  }
  f.close();
  return results;
}

async function fullUpload(env, svc, ctx, opts) {
  const s = await start(env, svc, ctx, opts);
  assert.ok([200, 201].includes(s.r.status), JSON.stringify(s.r.body));
  const sent = await sendChunks(env, svc, ctx, { path: opts.path, session_id: s.r.body.session_id, cb: s.cb, mode: opts.mode, hashes: s.h.list, corrupt: opts.corrupt, doneSha: opts.doneSha });
  const complete = await svc.handle("complete_upload", { session_id: s.r.body.session_id, ...(opts.mode === "deferred" ? { file_sha256: s.h.file } : {}) }, ctx);
  return { ...s, sessionId: s.r.body.session_id, sent, complete };
}

const objectsUnder = (env, id) => [...env.storage.objects.keys()].filter((p) => p.startsWith(`uploads/${id}/`));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("200 MiB WAV (default 16 MiB chunks): verified, manifest, never loads more than one chunk", async () => {
  const env = makeEnv();
  const path = makeWav("master-200.wav", 200 * MiB);
  const up = await fullUpload(env, env.beatbay, env.ctx.owner, { path });
  assert.equal(up.r.status, 201);
  assert.equal(up.r.body.chunk_count, 13);
  assert.equal(up.r.body.limits.chunk_bytes, 16 * MiB);
  assert.equal(up.r.body.limits.single_object_threshold, 45 * MiB);
  assert.equal(up.r.body.limits.max_file_bytes, 900 * MiB);
  assert.ok(up.sent.every((s) => s.put === 200 && s.done.status === 200));
  assert.equal(up.complete.status, 200, JSON.stringify(up.complete.body));
  assert.equal(up.complete.body.status, "verified");
  assert.equal(up.complete.body.manifest_root_sha256, await manifestRoot(up.h.list));
  assert.ok(env.storage.stats.maxDownloadBytes <= 16 * MiB, "only chunk-sized reads");
  const manifest = JSON.parse(new TextDecoder().decode(env.storage.objects.get(up.complete.body.manifest_path).bytes));
  assert.equal(manifest.total_bytes, 200 * MiB + 44);
  assert.equal(manifest.parts.length, 13);
  assert.equal(manifest.file_sha256, up.h.file);
  assert.deepEqual(manifest.parts.map((p) => p.sha256), up.h.list);
  assert.ok(objectsUnder(env, up.sessionId).every((p) => p.startsWith(`uploads/${up.sessionId}/`)));
  assert.ok(env.audits.some((a) => a.action === "upload_started") && env.audits.some((a) => a.action === "upload_verified"));
  rmSync(path);
});

test("MP4 (tiny ftyp box) as kind=video, single chunk and multi-chunk", async () => {
  const env = makeEnv({ limits: SMALL });
  const tiny = makeMp4("tiny.mp4", 64);
  const a = await fullUpload(env, env.beatbay, env.ctx.owner, { path: tiny, kind: "video" });
  assert.equal(a.r.body.chunk_count, 1);
  assert.equal(a.complete.status, 200, JSON.stringify(a.complete.body));
  const big = makeMp4("clip.mp4", 900 * KiB);
  const b = await fullUpload(env, env.beatbay, env.ctx.owner, { path: big, kind: "video", beat_id: BEAT2 });
  assert.equal(b.r.body.chunk_count, 4);
  assert.equal(b.sent[0].put, 200, "video/mp4 is accepted by the release-private allowlist after the migration");
  assert.equal(b.complete.body.status, "verified");
});

test("stems ZIP built with zip(1): central directory read from the tail, spanning a chunk boundary", async () => {
  const env = makeEnv({ limits: { ...SMALL, min_chunk_bytes: 1 * KiB } });
  const files = Array.from({ length: 30 }, (_, i) => ({ name: `stems/track-${String(i).padStart(2, "0")}-${"x".repeat(40)}.wav`, bytes: Buffer.concat([wavHeader(20 * KiB), randomBytes(20 * KiB)]) }));
  const zip = makeZip("stems.zip", files);
  const size = readFileSync(zip).length;
  // chunk so the last chunk is 10 bytes: EOCD (22 bytes) straddles the boundary.
  const cb = Math.ceil((size - 10) / 3);
  const tailCb = size - 10 - 2 * cb < 0 ? null : cb;
  assert.ok(tailCb);
  const up = await fullUpload(env, env.beatbay, env.ctx.owner, { path: zip, kind: "stems", chunk_bytes: cb });
  assert.equal(up.complete.status, 200, JSON.stringify(up.complete.body));
  const manifest = JSON.parse(new TextDecoder().decode(env.storage.objects.get(up.complete.body.manifest_path).bytes));
  assert.equal(manifest.zip_entries, 30); // zip(1) given explicit paths stores no dir entries
});

test("ZIP64 central directory (zip -fz) is parsed via the ZIP64 locator", async () => {
  const env = makeEnv({ limits: { chunk_bytes: 32 * KiB, min_chunk_bytes: 4 * KiB } });
  const dir = mkdtempSync(join(TMP, "z64-"));
  writeFileSync(join(dir, "a.wav"), Buffer.concat([wavHeader(40 * KiB), randomBytes(40 * KiB)]));
  writeFileSync(join(dir, "b.wav"), Buffer.concat([wavHeader(40 * KiB), randomBytes(40 * KiB)]));
  const out = join(TMP, "z64.zip");
  execFileSync("zip", ["-q", "-0", "-X", "-fz", out, "a.wav", "b.wav"], { cwd: dir });
  const up = await fullUpload(env, env.beatbay, env.ctx.owner, { path: out, kind: "zip" });
  assert.equal(up.complete.status, 200, JSON.stringify(up.complete.body));
  // An unsafe name is still caught when the archive is ZIP64.
  const bad = join(TMP, "z64-bad.zip");
  writeFileSync(join(dir, "xx"), "x");
  execFileSync("zip", ["-q", "-0", "-X", "-fz", bad, "a.wav", "xx"], { cwd: dir });
  patchZipName(bad, "xx", "..");
  const up2 = await fullUpload(env, env.beatbay, env.ctx.owner, { path: bad, kind: "zip", beat_id: BEAT2 });
  assert.equal(up2.complete.body.code, ERR.ZIP_UNSAFE);
  assert.equal(up2.complete.body.detail, "dotdot_path");
});

test("resume: kill mid-upload, start_upload again returns the same session and only missing idx", async () => {
  const env = makeEnv({ limits: SMALL });
  const path = makeWav("resume.wav", 2 * MiB);
  const s1 = await start(env, env.beatbay, env.ctx.staff, { path });
  const id = s1.r.body.session_id;
  const first = await sendChunks(env, env.beatbay, env.ctx.staff, { path, session_id: id, cb: s1.cb, stopAfter: 3 });
  assert.equal(first.length, 3);
  // "tab killed" -> reload -> same file -> same start_upload
  const s2 = await start(env, env.beatbay, env.ctx.staff, { path });
  assert.equal(s2.r.status, 200);
  assert.equal(s2.r.body.resumed, true);
  assert.equal(s2.r.body.session_id, id);
  assert.equal(s2.r.body.verified_count, 3);
  assert.deepEqual(s2.r.body.missing, [3, 4, 5, 6, 7, 8]);
  const putsBefore = env.storage.stats.puts;
  await sendChunks(env, env.beatbay, env.ctx.staff, { path, session_id: id, cb: s1.cb });
  assert.equal(env.storage.stats.puts - putsBefore, 6, "only the 6 missing chunks were sent");
  const c = await env.beatbay.handle("complete_upload", { session_id: id }, env.ctx.staff);
  assert.equal(c.status, 200);
  // Even after verify, a reload resumes the verified session (so the client can attach).
  const s3 = await start(env, env.beatbay, env.ctx.staff, { path });
  assert.equal(s3.r.body.status, "verified");
  assert.equal(s3.r.body.session_id, id);
});

test("P9 deferred hashes: head_sha256 at start, sha256[] on chunk_ticket, file_sha256 at complete", async () => {
  const env = makeEnv({ limits: SMALL });
  const path = makeWav("deferred.wav", 1 * MiB);
  const up = await fullUpload(env, env.beatbay, env.ctx.owner, { path, mode: "deferred" });
  assert.equal(up.r.body.hash_mode, "deferred");
  assert.equal(up.complete.status, 200, JSON.stringify(up.complete.body));
  assert.equal(up.complete.body.file_sha256, up.h.file);
  assert.equal(up.complete.body.file_sha256_verified, false);
  // Chunk 0 must match head_sha256 (a different file with the same name/size cannot slip in).
  const env2 = makeEnv({ limits: SMALL });
  const s = await start(env2, env2.beatbay, env2.ctx.owner, { path, mode: "deferred" });
  const bad = await env2.beatbay.handle("chunk_ticket", { session_id: s.r.body.session_id, idx: [0], sha256: ["f".repeat(64)] }, env2.ctx.owner);
  assert.equal(bad.body.code, ERR.HASH_CONFLICT);
  // Hash may also arrive at chunk_done instead of chunk_ticket.
  const env3 = makeEnv({ limits: SMALL });
  const s3 = await start(env3, env3.beatbay, env3.ctx.owner, { path, mode: "deferred" });
  const f = openFile(path);
  const t = await env3.beatbay.handle("chunk_ticket", { session_id: s3.r.body.session_id, idx: [1] }, env3.ctx.owner);
  assert.equal(t.body.tickets[0].sha256, null);
  env3.storage.put(t.body.tickets[0].signed_url, f.read(s3.cb, 2 * s3.cb), t.body.tickets[0].headers);
  const noHash = await env3.beatbay.handle("chunk_done", { session_id: s3.r.body.session_id, idx: 1 }, env3.ctx.owner);
  assert.equal(noHash.body.code, ERR.BAD_REQUEST);
  const withHash = await env3.beatbay.handle("chunk_done", { session_id: s3.r.body.session_id, idx: 1, sha256: s3.h.list[1] }, env3.ctx.owner);
  assert.equal(withHash.status, 200);
  assert.equal(withHash.body.status, "verified");
  f.close();
});

test("byte-flipped chunk: CHUNK_HASH_MISMATCH, object deleted, only that chunk is retried", async () => {
  const env = makeEnv({ limits: SMALL });
  const path = makeWav("flip.wav", 2 * MiB);
  const s = await start(env, env.beatbay, env.ctx.owner, { path });
  const id = s.r.body.session_id;
  let flipped = false;
  const sent = await sendChunks(env, env.beatbay, env.ctx.owner, {
    path, session_id: id, cb: s.cb,
    corrupt: (idx, bytes) => { if (idx !== 3 || flipped) return bytes; flipped = true; const c = new Uint8Array(bytes); c[1234] ^= 0xff; return c; },
  });
  const bad = sent.find((x) => x.idx === 3).done;
  assert.equal(bad.status, 422);
  assert.equal(bad.body.code, ERR.CHUNK_HASH_MISMATCH);
  assert.equal(bad.body.attempts, 1);
  assert.equal(bad.body.retryable, true);
  assert.ok(!env.storage.objects.has(`uploads/${id}/3.part`), "bad part deleted");
  const st = await env.beatbay.handle("upload_status", { session_id: id }, env.ctx.owner);
  assert.deepEqual(st.body.bad, [3]);
  assert.deepEqual(st.body.missing, []);
  assert.deepEqual(st.body.attempts, { 3: 1 });
  // Tickets for verified idx are skipped; only idx 3 gets a URL.
  const t = await env.beatbay.handle("chunk_ticket", { session_id: id, idx: [2, 3, 4] }, env.ctx.owner);
  assert.deepEqual(t.body.tickets.map((x) => x.idx), [3]);
  assert.deepEqual(t.body.skipped.map((x) => x.idx), [2, 4]);
  const putsBefore = env.storage.stats.puts;
  const retry = await sendChunks(env, env.beatbay, env.ctx.owner, { path, session_id: id, cb: s.cb });
  assert.deepEqual(retry.map((r) => r.idx), [3]);
  assert.equal(env.storage.stats.puts - putsBefore, 1);
  const c = await env.beatbay.handle("complete_upload", { session_id: id }, env.ctx.owner);
  assert.equal(c.status, 200);
  assert.equal(c.body.manifest_root_sha256, await manifestRoot(s.h.list), "final file is the original bytes");
});

test("duplicate chunk_done is a no-op; a verified part cannot be overwritten", async () => {
  const env = makeEnv({ limits: SMALL });
  const path = makeWav("dup.wav", 600 * KiB);
  const s = await start(env, env.beatbay, env.ctx.owner, { path });
  const id = s.r.body.session_id;
  await sendChunks(env, env.beatbay, env.ctx.owner, { path, session_id: id, cb: s.cb, only: [0] });
  const downloads = env.storage.stats.downloads;
  const again = await env.beatbay.handle("chunk_done", { session_id: id, idx: 0 }, env.ctx.owner);
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(env.storage.stats.downloads, downloads, "no re-download for a duplicate");
  // A second PUT to the same path (double PUT) is refused by upsert=false.
  const t = await env.beatbay.handle("chunk_ticket", { session_id: id, idx: [0] }, env.ctx.owner);
  assert.equal(t.body.tickets.length, 0, "no ticket for a verified chunk");
  const t1 = await env.beatbay.handle("chunk_ticket", { session_id: id, idx: [1] }, env.ctx.owner);
  const f = openFile(path);
  const bytes = f.read(s.cb, 2 * s.cb);
  assert.equal(env.storage.put(t1.body.tickets[0].signed_url, bytes, t1.body.tickets[0].headers), 200);
  assert.equal(env.storage.put(t1.body.tickets[0].signed_url, bytes, t1.body.tickets[0].headers), 409);
  f.close();
});

test("missing chunk: complete_upload refused with INCOMPLETE and nothing is attached", async () => {
  const env = makeEnv({ limits: SMALL });
  const path = makeWav("gap.wav", 1 * MiB);
  const s = await start(env, env.beatbay, env.ctx.owner, { path });
  const id = s.r.body.session_id;
  await sendChunks(env, env.beatbay, env.ctx.owner, { path, session_id: id, cb: s.cb, only: [0, 1, 3] });
  const c = await env.beatbay.handle("complete_upload", { session_id: id }, env.ctx.owner);
  assert.equal(c.status, 409);
  assert.equal(c.body.code, ERR.INCOMPLETE);
  assert.deepEqual(c.body.missing, [2, 4]);
  const a = await env.beatbay.handleAttach({ intake: "beatbox", id: BEAT, kind: "full", session_id: id }, env.ctx.owner);
  assert.equal(a.body.code, ERR.INVALID_STATE);
  assert.equal((await env.db.getBeat(BEAT)).full_audio_path, null);
  const st = await env.beatbay.handle("upload_status", { session_id: id }, env.ctx.owner);
  assert.equal(st.body.status, "open");
});

test("wrong total_bytes: last chunk fails CHUNK_SIZE_MISMATCH; oversize total fails LIMIT_EXCEEDED", async () => {
  const env = makeEnv({ limits: SMALL });
  const path = makeWav("total.wav", 700 * KiB);
  const size = readFileSync(path).length;
  for (const declared of [size + 1000, size - 1000]) {
    const L = await env.db.getLimits();
    const cb = L.chunk_bytes;
    const count = Math.ceil(declared / cb);
    const hashes = fileHashes(path, cb).list.slice(0, count);
    while (hashes.length < count) hashes.push("0".repeat(64));
    const r = await env.beatbay.handle("start_upload", { beat_id: BEAT, kind: "full", filename: `t${declared}.wav`, total_bytes: declared, chunk_sha256: hashes }, env.ctx.owner);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const last = r.body.chunk_count - 1;
    const f = openFile(path);
    const t = await env.beatbay.handle("chunk_ticket", { session_id: r.body.session_id, idx: [last] }, env.ctx.owner);
    env.storage.put(t.body.tickets[0].signed_url, f.read(last * cb, Math.min(size, (last + 1) * cb)), t.body.tickets[0].headers);
    f.close();
    const d = await env.beatbay.handle("chunk_done", { session_id: r.body.session_id, idx: last }, env.ctx.owner);
    assert.equal(d.body.code, ERR.CHUNK_SIZE_MISMATCH, JSON.stringify(d.body));
    await env.beatbay.handle("abort_upload", { session_id: r.body.session_id }, env.ctx.owner);
  }
  const big = await env.beatbay.handle("start_upload", { beat_id: BEAT, kind: "full", filename: "huge.wav", total_bytes: 900 * MiB + 1, head_sha256: "a".repeat(64) }, env.ctx.owner);
  assert.equal(big.status, 413);
  assert.equal(big.body.code, ERR.LIMIT_EXCEEDED);
  assert.equal(big.body.limit, "max_file_bytes");
  // WAV header that disagrees with the real size (consistent client lie) -> MAGIC_MISMATCH at complete.
  const liar = makeWav("liar.wav", 300 * KiB, { riffDelta: 5000 });
  const up = await fullUpload(env, env.beatbay, env.ctx.owner, { path: liar, beat_id: BEAT2 });
  assert.equal(up.complete.body.code, ERR.MAGIC_MISMATCH);
  assert.equal(up.complete.body.detail, "wav_riff_size_mismatch");
});

test("wrong ext / wrong magic: EXT_NOT_ALLOWED at start, MAGIC_MISMATCH at complete (parts deleted)", async () => {
  const env = makeEnv({ limits: SMALL });
  const exe = await env.beatbay.handle("start_upload", { beat_id: BEAT, kind: "full", filename: "setup.exe", total_bytes: 10, head_sha256: "a".repeat(64) }, env.ctx.owner);
  assert.equal(exe.body.code, ERR.EXT_NOT_ALLOWED);
  const wavAsVideo = await env.beatbay.handle("start_upload", { beat_id: BEAT, kind: "video", filename: "a.wav", total_bytes: 10, head_sha256: "a".repeat(64) }, env.ctx.owner);
  assert.equal(wavAsVideo.body.code, ERR.EXT_NOT_ALLOWED);
  const zipAsFull = await env.beatbay.handle("start_upload", { beat_id: BEAT, kind: "full", filename: "a.zip", total_bytes: 10, head_sha256: "a".repeat(64) }, env.ctx.owner);
  assert.equal(zipAsFull.body.code, ERR.EXT_NOT_ALLOWED);
  const badKind = await env.beatbay.handle("start_upload", { beat_id: BEAT, kind: "preview", filename: "a.wav", total_bytes: 10, head_sha256: "a".repeat(64) }, env.ctx.owner);
  assert.equal(badKind.body.code, ERR.BAD_REQUEST);
  // MP3 bytes named .wav
  const mp3 = makeMp3("fake.wav", 400 * KiB);
  const a = await fullUpload(env, env.beatbay, env.ctx.owner, { path: mp3 });
  assert.equal(a.complete.status, 422);
  assert.equal(a.complete.body.code, ERR.MAGIC_MISMATCH);
  assert.equal(a.complete.body.session_status, "failed");
  assert.deepEqual(objectsUnder(env, a.sessionId), [], "failed session parts deleted");
  assert.ok(env.audits.some((e) => e.action === "upload_failed" && e.details.code === ERR.MAGIC_MISMATCH));
  // MP4 named .zip for stems
  const mp4 = makeMp4("clip-as.zip", 300 * KiB);
  const b = await fullUpload(env, env.beatbay, env.ctx.owner, { path: mp4, kind: "stems", beat_id: BEAT2 });
  assert.equal(b.complete.body.code, ERR.MAGIC_MISMATCH);
  // real mp3 is fine
  const good = makeMp3("good.mp3", 300 * KiB);
  const c = await fullUpload(env, env.beatbay, env.ctx.owner, { path: good, beat_id: BEAT_UNASSIGNED });
  assert.equal(c.complete.status, 200, JSON.stringify(c.complete.body));
});

test("unsafe ZIPs fail closed with ZIP_UNSAFE: .., absolute path, too many entries, symlink, executable", async () => {
  const cases = [];
  const payload = () => randomBytes(8 * KiB);
  cases.push(["dotdot_path", patchZipName(makeZip("dotdot.zip", [{ name: "ok.txt", bytes: payload() }, { name: "xx/evil.txt", bytes: payload() }]), "xx/evil.txt", "../evil.txt")]);
  cases.push(["absolute_path", patchZipName(makeZip("abs.zip", [{ name: "Xetc/passwd", bytes: payload() }]), "Xetc/passwd", "/etc/passwd")]);
  cases.push(["too_many_entries", makeZip("many.zip", Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.wav`, bytes: payload() })))]);
  cases.push(["symlink", makeZip("link.zip", [{ name: "a.wav", bytes: payload() }], { symlinks: [{ name: "link", target: "/etc/passwd" }] })]);
  cases.push(["blocked_ext", makeZip("exe.zip", [{ name: "a.wav", bytes: payload() }, { name: "tools/setup.exe", bytes: payload() }])]);
  for (const [detail, zip] of cases) {
    const env = makeEnv({ limits: { chunk_bytes: 16 * KiB, min_chunk_bytes: 4 * KiB, zip_max_entries: 5 } });
    const up = await fullUpload(env, env.beatbay, env.ctx.owner, { path: zip, kind: "zip" });
    assert.equal(up.complete.status, 422, `${detail}: ${JSON.stringify(up.complete.body)}`);
    assert.equal(up.complete.body.code, ERR.ZIP_UNSAFE);
    assert.equal(up.complete.body.detail, detail);
    assert.deepEqual(objectsUnder(env, up.sessionId), []);
    const a = await env.beatbay.handleAttach({ id: BEAT, kind: "zip", session_id: up.sessionId }, env.ctx.owner);
    assert.equal(a.body.code, ERR.INVALID_STATE);
  }
});

test("expired session: tickets refused, cleanup purges parts (uploads/ only), attached + other files untouched", async () => {
  const env = makeEnv({ limits: SMALL });
  const keep = makeWav("keep.wav", 300 * KiB);
  const kept = await fullUpload(env, env.beatbay, env.ctx.owner, { path: keep, beat_id: BEAT2 });
  const att = await env.beatbay.handleAttach({ intake: "beatbox", id: BEAT2, kind: "full", session_id: kept.sessionId }, env.ctx.owner);
  assert.equal(att.status, 200);
  const path = makeWav("expire.wav", 700 * KiB);
  const s = await start(env, env.beatbay, env.ctx.owner, { path });
  const id = s.r.body.session_id;
  await sendChunks(env, env.beatbay, env.ctx.owner, { path, session_id: id, cb: s.cb, only: [0, 1] });
  env.storage.seed("beatbay/x/full/master.wav", new Uint8Array(10), "audio/wav");
  env.storage.seed("uploads/not-a-uuid/0.part", new Uint8Array(10));
  const orphan = "20000000-0000-4000-8000-000000000009";
  env.storage.seed(`uploads/${orphan}/0.part`, new Uint8Array(10), "audio/wav", env.clock.now());
  env.clock.advance(24 * 3600 * 1000 + 1000);
  const t = await env.beatbay.handle("chunk_ticket", { session_id: id, idx: [2] }, env.ctx.owner);
  assert.equal(t.status, 410);
  assert.equal(t.body.code, ERR.SESSION_EXPIRED);
  const report = await env.beatbay.cleanup({ limit: 20, orphanSweep: true });
  assert.equal(report.purged_sessions, 1);
  assert.equal(report.orphan_folders, 1);
  assert.deepEqual(objectsUnder(env, id), []);
  assert.deepEqual(objectsUnder(env, orphan), []);
  assert.ok(env.storage.objects.has("beatbay/x/full/master.wav"), "never touches beatbay/<id>/full");
  assert.ok(env.storage.objects.has("uploads/not-a-uuid/0.part"), "never touches non-session names");
  assert.equal(objectsUnder(env, kept.sessionId).length, 2 + 1, "attached parts + manifest kept");
  assert.equal((await env.db.getSession(kept.sessionId)).status, "attached");
  assert.equal((await env.db.getSession(id)).status, "expired");
  // Young orphans (< 1 h) are left alone (in-flight safety).
  const young = "20000000-0000-4000-8000-00000000000a";
  env.storage.seed(`uploads/${young}/0.part`, new Uint8Array(10), "audio/wav", env.clock.now());
  await env.beatbay.cleanup();
  assert.equal(objectsUnder(env, young).length, 1);
  // The delete guard itself
  assert.equal(isSafeUploadObject(`uploads/${id}/../../beatbay/x`, id), false);
  assert.equal(isSafeUploadObject(`beatbay/${id}/0.part`, id), false);
  assert.equal(isSafeUploadObject(`uploads/${id}/0.part`, id), true);
});

test("another user's session returns 403 FORBIDDEN; owner tier may read status and abort only", async () => {
  const env = makeEnv({ limits: SMALL });
  const path = makeWav("mine.wav", 500 * KiB);
  const s = await start(env, env.beatbay, env.ctx.staff, { path });
  const id = s.r.body.session_id;
  for (const [action, body] of [
    ["upload_status", { session_id: id }],
    ["chunk_ticket", { session_id: id, idx: [0] }],
    ["chunk_done", { session_id: id, idx: 0 }],
    ["complete_upload", { session_id: id }],
    ["abort_upload", { session_id: id }],
  ]) {
    const r = await env.beatbay.handle(action, body, env.ctx.other);
    assert.equal(r.status, 403, action);
    assert.equal(r.body.code, ERR.FORBIDDEN, action);
  }
  const a = await env.beatbay.handleAttach({ id: BEAT, kind: "full", session_id: id }, env.ctx.other);
  assert.equal(a.status, 403);
  const henry = await env.studio.handle("upload_status", { session_id: id }, env.ctx.henry);
  assert.equal(henry.status, 403);
  // Owner tier: status yes, tickets no (only the uploader PUTs), abort yes.
  assert.equal((await env.beatbay.handle("upload_status", { session_id: id }, env.ctx.owner)).status, 200);
  assert.equal((await env.beatbay.handle("chunk_ticket", { session_id: id, idx: [0] }, env.ctx.owner)).status, 403);
  const ab = await env.beatbay.handle("abort_upload", { session_id: id }, env.ctx.owner);
  assert.equal(ab.status, 200);
  const missing = await env.beatbay.handle("upload_status", { session_id: "30000000-0000-4000-8000-000000000000" }, env.ctx.owner);
  assert.equal(missing.body.code, ERR.SESSION_NOT_FOUND);
  assert.equal((await env.beatbay.handle("upload_status", { session_id: "nope" }, env.ctx.owner)).body.code, ERR.BAD_REQUEST);
});

test("abort: parts deleted, session aborted, later calls refused; attached sessions cannot be aborted", async () => {
  const env = makeEnv({ limits: SMALL });
  const path = makeWav("abort.wav", 700 * KiB);
  const s = await start(env, env.beatbay, env.ctx.staff, { path });
  const id = s.r.body.session_id;
  await sendChunks(env, env.beatbay, env.ctx.staff, { path, session_id: id, cb: s.cb, only: [0, 1] });
  assert.equal(objectsUnder(env, id).length, 2);
  const ab = await env.beatbay.handle("abort_upload", { session_id: id }, env.ctx.staff);
  assert.equal(ab.body.status, "aborted");
  assert.equal(ab.body.removed, 2);
  assert.deepEqual(objectsUnder(env, id), []);
  assert.equal((await env.beatbay.handle("chunk_ticket", { session_id: id, idx: [2] }, env.ctx.staff)).body.code, ERR.INVALID_STATE);
  assert.equal((await env.beatbay.handle("abort_upload", { session_id: id }, env.ctx.staff)).body.already_aborted, true);
  // a fresh start after abort creates a NEW session
  const s2 = await start(env, env.beatbay, env.ctx.staff, { path });
  assert.notEqual(s2.r.body.session_id, id);
  // attached cannot be aborted
  await sendChunks(env, env.beatbay, env.ctx.staff, { path, session_id: s2.r.body.session_id, cb: s2.cb });
  await env.beatbay.handle("complete_upload", { session_id: s2.r.body.session_id }, env.ctx.staff);
  await env.beatbay.handleAttach({ intake: "beatbox", id: BEAT, kind: "full", session_id: s2.r.body.session_id }, env.ctx.staff);
  const no = await env.beatbay.handle("abort_upload", { session_id: s2.r.body.session_id }, env.ctx.owner);
  assert.equal(no.body.code, ERR.INVALID_STATE);
});

test("config-driven limits: chunk size, batch cap, attempts, open sessions, TTL, allowlist, invalid config", async () => {
  const env = makeEnv({ limits: { chunk_bytes: 128 * KiB, min_chunk_bytes: 64 * KiB, ticket_batch_max: 4, max_attempts: 2, max_open_sessions_per_user: 2, session_ttl_seconds: 60, ticket_ttl_seconds: 45 } });
  const path = makeWav("cfg.wav", 1 * MiB);
  const s = await start(env, env.beatbay, env.ctx.owner, { path });
  assert.equal(s.r.body.chunk_bytes, 128 * KiB);
  assert.equal(s.r.body.chunk_count, 9);
  assert.equal(s.r.body.limits.ticket_batch_max, 4);
  assert.equal(s.r.body.limits.max_attempts, 2);
  assert.equal(Date.parse(s.r.body.expires_at) - env.clock.now(), 60_000);
  const id = s.r.body.session_id;
  const tooMany = await env.beatbay.handle("chunk_ticket", { session_id: id, idx: [0, 1, 2, 3, 4] }, env.ctx.owner);
  assert.equal(tooMany.body.code, ERR.LIMIT_EXCEEDED);
  assert.equal(tooMany.body.limit, "ticket_batch_max");
  const ok = await env.beatbay.handle("chunk_ticket", { session_id: id, idx: [0, 1] }, env.ctx.owner);
  assert.ok(ok.body.tickets.every((t) => t.expires_in === 45 && t.headers["content-type"] === "audio/wav" && t.headers["x-upsert"] === "false"));
  assert.ok(ok.body.tickets.every((t) => t.bucket === "release-private" && t.path === `uploads/${id}/${t.idx}.part`));
  const range = await env.beatbay.handle("chunk_ticket", { session_id: id, idx: [9] }, env.ctx.owner);
  assert.equal(range.body.code, ERR.CHUNK_OUT_OF_RANGE);
  // ticket expiry: PUT after expires_in fails at storage; a fresh ticket works.
  env.clock.advance(46_000);
  const f = openFile(path);
  assert.equal(env.storage.put(ok.body.tickets[0].signed_url, f.read(0, 128 * KiB), ok.body.tickets[0].headers), 400);
  // attempts exhausted -> session failed, parts removed
  const flip = (b) => { const c = new Uint8Array(b); c[0] ^= 1; return c; };
  for (let i = 0; i < 2; i += 1) {
    const t = await env.beatbay.handle("chunk_ticket", { session_id: id, idx: [5] }, env.ctx.owner);
    env.storage.put(t.body.tickets[0].signed_url, flip(f.read(5 * 128 * KiB, 6 * 128 * KiB)), t.body.tickets[0].headers);
    const d = await env.beatbay.handle("chunk_done", { session_id: id, idx: 5 }, env.ctx.owner);
    assert.equal(d.body.code, ERR.CHUNK_HASH_MISMATCH);
    assert.equal(d.body.retryable, i === 0);
  }
  f.close();
  assert.equal((await env.db.getSession(id)).status, "failed");
  assert.equal((await env.beatbay.handle("chunk_ticket", { session_id: id, idx: [5] }, env.ctx.owner)).body.code, ERR.INVALID_STATE);
  // client chunk_bytes outside [min, max]
  const cbBad = await env.beatbay.handle("start_upload", { beat_id: BEAT, kind: "full", filename: "x.wav", total_bytes: 1000, chunk_bytes: 256 * KiB, head_sha256: "a".repeat(64) }, env.ctx.owner);
  assert.equal(cbBad.body.code, ERR.LIMIT_EXCEEDED);
  // max open sessions per user
  await start(env, env.beatbay, env.ctx.owner, { path: makeWav("o1.wav", 10 * KiB) });
  await start(env, env.beatbay, env.ctx.owner, { path: makeWav("o2.wav", 11 * KiB) });
  const third = await start(env, env.beatbay, env.ctx.owner, { path: makeWav("o3.wav", 12 * KiB) });
  assert.equal(third.r.status, 429);
  assert.equal(third.r.body.limit, "max_open_sessions_per_user");
  // allowlist edited in config (e.g. Owner adds .aiff? here: remove mp3 from full)
  env.db.state.limits.allowed = { ...env.db.state.limits.allowed, full: { wav: "audio/wav" } };
  const mp3 = await env.beatbay.handle("start_upload", { beat_id: BEAT2, kind: "full", filename: "a.mp3", total_bytes: 10, head_sha256: "a".repeat(64) }, env.ctx.owner);
  assert.equal(mp3.body.code, ERR.EXT_NOT_ALLOWED);
  // invalid config fails closed
  env.db.state.limits.chunk_bytes = 50 * MiB;
  const bad = await env.beatbay.handle("upload_status", { session_id: id }, env.ctx.owner);
  assert.equal(bad.status, 503);
  assert.equal(bad.body.code, ERR.CONFIG_UNAVAILABLE);
  env.db.state.limits = null;
  assert.equal((await env.beatbay.handle("start_upload", { dry_run: true }, env.ctx.owner)).body.code, ERR.CONFIG_UNAVAILABLE);
});

test("Free storage budget: STORAGE_BUDGET_EXCEEDED on start; usage reported by upload_status and dry_run", async () => {
  const env = makeEnv({ limits: { ...SMALL, max_total_upload_bytes: 4 * MiB } });
  env.storage.setOtherBucketBytes("release-public", 2 * MiB); // the Free cap is project-wide
  const dry = await env.beatbay.handle("start_upload", { dry_run: true }, env.ctx.owner);
  assert.equal(dry.body.storage.used_bytes, 2 * MiB);
  assert.equal(dry.body.storage.remaining_bytes, 2 * MiB);
  assert.equal(dry.body.storage.scope, "project");
  const path = makeWav("budget.wav", 1 * MiB);
  const s = await start(env, env.beatbay, env.ctx.owner, { path });
  assert.equal(s.r.status, 201);
  assert.equal(s.r.body.storage.reserved_bytes, 1 * MiB + 44);
  const st = await env.beatbay.handle("upload_status", { session_id: s.r.body.session_id }, env.ctx.owner);
  assert.equal(st.body.storage.used_bytes, 2 * MiB);
  assert.equal(st.body.storage.reserved_bytes, 1 * MiB + 44, "reserved counts bytes not yet verified");
  const big = makeWav("budget2.wav", 1 * MiB + 512 * KiB);
  const over = await start(env, env.beatbay, env.ctx.owner, { path: big, beat_id: BEAT2 });
  assert.equal(over.r.status, 507);
  assert.equal(over.r.body.code, ERR.STORAGE_BUDGET_EXCEEDED);
  assert.ok(over.r.body.storage.remaining_bytes < 1 * MiB);
  // Aborting frees the reservation.
  await env.beatbay.handle("abort_upload", { session_id: s.r.body.session_id }, env.ctx.owner);
  const again = await start(env, env.beatbay, env.ctx.owner, { path: big, beat_id: BEAT2 });
  assert.equal(again.r.status, 201);
  // Bucket-scoped budget (config) ignores other buckets.
  env.db.state.limits.budget_bucket_ids = ["release-private"];
  const scoped = await env.beatbay.handle("start_upload", { dry_run: true }, env.ctx.owner);
  assert.equal(scoped.body.storage.used_bytes, 0);
});

test("attach: kind-bound, beat-bound, still draft, storefront stays false; stems go to beatbay_beat_assets", async () => {
  const env = makeEnv({ limits: SMALL });
  const path = makeWav("attach.wav", 400 * KiB);
  const up = await fullUpload(env, env.beatbay, env.ctx.staff, { path });
  const id = up.sessionId;
  const wrongKind = await env.beatbay.handleAttach({ intake: "beatbox", id: BEAT, kind: "video", session_id: id }, env.ctx.staff);
  assert.equal(wrongKind.body.code, ERR.KIND_MISMATCH);
  const wrongBeat = await env.beatbay.handleAttach({ intake: "beatbox", id: BEAT2, kind: "full", session_id: id }, env.ctx.staff);
  assert.equal(wrongBeat.body.code, ERR.FORBIDDEN);
  const before = await env.db.getBeat(BEAT);
  const ok = await env.beatbay.handleAttach({ intake: "beatbox", id: BEAT, kind: "full", session_id: id }, env.ctx.staff);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.beat.full_audio_path, `uploads/${id}/manifest.json`);
  assert.equal(ok.body.beat.full_audio_bucket, "release-private");
  assert.equal(ok.body.beat.status, before.status);
  assert.equal(ok.body.beat.storefront_enabled, false);
  const twice = await env.beatbay.handleAttach({ intake: "beatbox", id: BEAT, kind: "full", session_id: id }, env.ctx.staff);
  assert.equal(twice.body.already_attached, true);
  // stems
  const zip = makeZip("stems-attach.zip", [{ name: "kick.wav", bytes: Buffer.concat([wavHeader(9000), randomBytes(9000)]) }]);
  const st = await fullUpload(env, env.beatbay, env.ctx.owner, { path: zip, kind: "stems", beat_id: BEAT2 });
  const sa = await env.beatbay.handleAttach({ intake: "beatbox", id: BEAT2, kind: "stems", session_id: st.sessionId }, env.ctx.owner);
  assert.equal(sa.status, 200);
  assert.equal(env.db.state.assets.get(`${BEAT2}:stems`).manifest_path, `uploads/${st.sessionId}/manifest.json`);
  assert.equal((await env.db.getBeat(BEAT2)).full_audio_path, null, "stems never replace the master");
  // failure while updating the beat rolls the session back to verified
  const p2 = makeWav("rollback.wav", 200 * KiB);
  const r2 = await fullUpload(env, env.beatbay, env.ctx.owner, { path: p2, beat_id: BEAT_UNASSIGNED });
  env.db.state.failNextBeatUpdate = true;
  await assert.rejects(env.beatbay.handleAttach({ intake: "beatbox", id: BEAT_UNASSIGNED, kind: "full", session_id: r2.sessionId }, env.ctx.owner));
  assert.equal((await env.db.getSession(r2.sessionId)).status, "verified");
  // expired verified session cannot be attached
  env.clock.advance(25 * 3600 * 1000);
  const late = await env.beatbay.handleAttach({ intake: "beatbox", id: BEAT_UNASSIGNED, kind: "full", session_id: r2.sessionId }, env.ctx.owner);
  assert.equal(late.body.code, ERR.SESSION_EXPIRED);
  // owner master download of a chunked master: manifest + per-part signed URLs
  const dl = await env.beatbay.manifestDownload(`uploads/${id}/manifest.json`, 300);
  assert.equal(dl.chunked, true);
  assert.equal(dl.parts.length, up.r.body.chunk_count);
  assert.ok(dl.parts.every((p) => p.url && p.sha256));
  assert.equal(await env.beatbay.manifestDownload("beatbay/x/full/a.wav", 300), null);
});

test("staff/music_uploader stay draft-only: published beat refused at start and attach; storefront never set", async () => {
  const env = makeEnv({ limits: SMALL });
  const path = makeWav("draftonly.wav", 200 * KiB);
  const staffPub = await start(env, env.beatbay, env.ctx.staff, { path, beat_id: BEAT_PUBLISHED });
  assert.equal(staffPub.r.status, 403);
  assert.equal(staffPub.r.body.code, ERR.FORBIDDEN);
  const henryPub = await start(env, env.studio, env.ctx.henry, { path, beat_id: BEAT_PUBLISHED });
  assert.equal(henryPub.r.body.code, ERR.FORBIDDEN);
  // Beat published between upload and attach -> staff attach refused.
  const up = await fullUpload(env, env.beatbay, env.ctx.staff, { path });
  env.db.state.beats.get(BEAT).status = "available";
  env.db.state.beats.get(BEAT).storefront_enabled = true;
  const a = await env.beatbay.handleAttach({ intake: "beatbox", id: BEAT, kind: "full", session_id: up.sessionId }, env.ctx.staff);
  assert.equal(a.status, 403);
  assert.equal((await env.db.getSession(up.sessionId)).status, "verified", "refused attach does not consume the session");
  // Owner may still attach (same as the existing owner rule), and nothing flips storefront/status.
  const o = await env.beatbay.handleAttach({ intake: "beatbox", id: BEAT, kind: "full", session_id: up.sessionId }, env.ctx.owner);
  assert.equal(o.status, 200);
  assert.equal(o.body.beat.status, "available");
  for (const beat of env.db.state.beats.values()) if (beat.id !== BEAT) assert.equal(beat.storefront_enabled, beat.id === BEAT_PUBLISHED);
});

test("P10 Henry via studio-manager: assigned draft works end-to-end; unassigned is FORBIDDEN", async () => {
  const env = makeEnv({ limits: SMALL, assigned: [BEAT] });
  const path = makeWav("henry.wav", 600 * KiB);
  const up = await fullUpload(env, env.studio, env.ctx.henry, { path, mode: "deferred" });
  assert.equal(up.complete.status, 200, JSON.stringify(up.complete.body));
  assert.equal((await env.db.getSession(up.sessionId)).origin, "studio_manager");
  const a = await env.studio.handleAttach({ beat_id: BEAT, kind: "full", session_id: up.sessionId }, env.ctx.henry);
  assert.equal(a.status, 200);
  assert.equal(a.body.beat.storefront_enabled, false);
  assert.equal(a.body.beat.status, "draft");
  const un = await start(env, env.studio, env.ctx.henry, { path, beat_id: BEAT_UNASSIGNED });
  assert.equal(un.r.status, 403);
  // Studio has no cleanup/owner actions through handle()
  assert.equal((await env.studio.handle("cleanup_uploads", {}, env.ctx.henry)).body.code, ERR.BAD_REQUEST);
});

test("P8 gzip encoding (WAV): magic + WAV size checked on the inflated head only", async () => {
  const env = makeEnv({ limits: SMALL });
  const wav = Buffer.concat([wavHeader(600 * KiB), Buffer.alloc(600 * KiB, 7)]);
  const gz = gzipSync(wav);
  const path = join(TMP, "gz.wav.gz");
  writeFileSync(path, gz);
  const extra = { encoding: "gzip", original_bytes: wav.length, original_sha256: sha(wav) };
  const up = await fullUpload(env, env.beatbay, env.ctx.owner, { path, filename: "gz.wav", extra, chunk_bytes: 64 * KiB });
  assert.equal(up.complete.status, 200, JSON.stringify(up.complete.body));
  const lie = await fullUpload(env, env.beatbay, env.ctx.owner, { path, filename: "gz2.wav", beat_id: BEAT2, extra: { ...extra, original_bytes: wav.length + 99999 }, chunk_bytes: 64 * KiB });
  assert.equal(lie.complete.body.code, ERR.MAGIC_MISMATCH);
  const zipGz = await env.beatbay.handle("start_upload", { beat_id: BEAT, kind: "stems", filename: "a.zip", total_bytes: 100, head_sha256: "a".repeat(64), encoding: "gzip", original_bytes: 200 }, env.ctx.owner);
  assert.equal(zipGz.body.code, ERR.EXT_NOT_ALLOWED);
  const notGz = makeWav("plain.wav", 100 * KiB);
  const ng = await fullUpload(env, env.beatbay, env.ctx.owner, { path: notGz, beat_id: BEAT_UNASSIGNED, extra: { encoding: "gzip", original_bytes: 100 * KiB + 44 } });
  assert.equal(ng.complete.body.code, ERR.MAGIC_MISMATCH);
  assert.equal(ng.complete.body.detail, "not_gzip");
});

test("tamper after verify: a part replaced behind our back fails complete (re-verified on read)", async () => {
  const env = makeEnv({ limits: SMALL });
  const path = makeWav("tamper.wav", 600 * KiB);
  const s = await start(env, env.beatbay, env.ctx.owner, { path });
  await sendChunks(env, env.beatbay, env.ctx.owner, { path, session_id: s.r.body.session_id, cb: s.cb });
  const p0 = `uploads/${s.r.body.session_id}/0.part`;
  const o = env.storage.objects.get(p0);
  o.bytes = new Uint8Array(o.bytes);
  o.bytes[100] ^= 1;
  const c = await env.beatbay.handle("complete_upload", { session_id: s.r.body.session_id }, env.ctx.owner);
  assert.equal(c.body.code, ERR.CHUNK_HASH_MISMATCH);
  assert.equal(c.body.reverify, true);
  assert.equal((await env.db.getSession(s.r.body.session_id)).status, "failed");
});

test("same head + size but different file (upfront hashes differ) replaces the stale open session", async () => {
  const env = makeEnv({ limits: SMALL });
  const a = makeWav("sameA.wav", 600 * KiB);
  const buf = readFileSync(a);
  buf[buf.length - 1] ^= 0xff; // only the last chunk differs
  const b = join(TMP, "sameB.wav");
  writeFileSync(b, buf);
  const sa = await start(env, env.beatbay, env.ctx.owner, { path: a });
  await sendChunks(env, env.beatbay, env.ctx.owner, { path: a, session_id: sa.r.body.session_id, cb: sa.cb, only: [0] });
  const sb = await start(env, env.beatbay, env.ctx.owner, { path: b });
  assert.equal(sb.r.status, 201);
  assert.equal(sb.r.body.replaced_session_id, sa.r.body.session_id);
  assert.equal((await env.db.getSession(sa.r.body.session_id)).status, "aborted");
  assert.deepEqual(objectsUnder(env, sa.r.body.session_id), []);
});

test("DEV ask: storage_used_bytes + storage_quota_bytes on start_upload, upload_status and dry_run", async () => {
  const env = makeEnv({ limits: SMALL });
  env.storage.setOtherBucketBytes("release-public", 3 * MiB);
  const dry = await env.beatbay.handle("start_upload", { dry_run: true }, env.ctx.owner);
  assert.equal(dry.body.storage_used_bytes, 3 * MiB);
  assert.equal(dry.body.storage_quota_bytes, 960 * MiB, "quota = config max_total_upload_bytes (960 MiB default, under the 1 GiB cap)");
  const path = makeWav("quota.wav", 300 * KiB);
  const s = await start(env, env.beatbay, env.ctx.owner, { path });
  assert.equal(s.r.body.storage_used_bytes, 3 * MiB);
  assert.equal(s.r.body.storage_quota_bytes, 960 * MiB);
  await sendChunks(env, env.beatbay, env.ctx.owner, { path, session_id: s.r.body.session_id, cb: s.cb, only: [0] });
  const st = await env.beatbay.handle("upload_status", { session_id: s.r.body.session_id }, env.ctx.owner);
  assert.equal(st.body.storage_used_bytes, 3 * MiB + 256 * KiB, "used counts stored parts");
  assert.equal(st.body.storage_quota_bytes, 960 * MiB);
  env.db.state.limits.max_total_upload_bytes = 4 * MiB;
  const r = await env.beatbay.handle("start_upload", { dry_run: true }, env.ctx.owner);
  assert.equal(r.body.storage_quota_bytes, 4 * MiB, "quota follows config");
  const over = await start(env, env.beatbay, env.ctx.owner, { path: makeWav("quota2.wav", 900 * KiB), beat_id: BEAT2 });
  assert.equal(over.r.body.code, ERR.STORAGE_BUDGET_EXCEEDED, "code kept; client maps it to its LIMIT_EXCEEDED handling");
});

test("Henry emails: at most ONE owner email per upload (attach only); start/verify/fail logged without email", async () => {
  const emails = [];
  const logs = [];
  const studioAudit = uploadAuditRouter({ notify: async (e) => { emails.push(e.action); }, logOnly: async (e) => { logs.push(e.action); } });
  const env = makeEnv({ limits: SMALL, studioAudit });
  const path = makeWav("henry-mail.wav", 700 * KiB);
  let flipped = false;
  const up = await fullUpload(env, env.studio, env.ctx.henry, {
    path, mode: "deferred",
    corrupt: (idx, b) => { if (idx !== 1 || flipped) return b; flipped = true; const c = new Uint8Array(b); c[0] ^= 1; return c; },
  });
  assert.equal(up.complete.body.code, ERR.INCOMPLETE, "chunk 1 went bad on the first pass");
  await sendChunks(env, env.studio, env.ctx.henry, { path, session_id: up.sessionId, cb: up.cb, mode: "deferred", hashes: up.h.list });
  assert.equal((await env.studio.handle("complete_upload", { session_id: up.sessionId }, env.ctx.henry)).status, 200);
  assert.deepEqual(emails, [], "no email before attach");
  assert.deepEqual(logs, ["upload_started", "upload_verified"]);
  await env.studio.handleAttach({ beat_id: BEAT, kind: "full", session_id: up.sessionId }, env.ctx.henry);
  await env.studio.handleAttach({ beat_id: BEAT, kind: "full", session_id: up.sessionId }, env.ctx.henry); // repeat: no 2nd email
  assert.deepEqual(emails, ["upload_attached"]);
  // A failed upload never emails.
  const bad = makeMp3("henry-bad.wav", 200 * KiB);
  const f = await fullUpload(env, env.studio, env.ctx.henry, { path: bad, beat_id: BEAT, mode: "deferred" });
  assert.equal(f.complete.body.code, ERR.MAGIC_MISMATCH);
  const ab = await start(env, env.studio, env.ctx.henry, { path: makeWav("henry-abort.wav", 100 * KiB), mode: "deferred" });
  await env.studio.handle("abort_upload", { session_id: ab.r.body.session_id }, env.ctx.henry);
  assert.deepEqual(emails, ["upload_attached"]);
  assert.ok(logs.includes("upload_failed") && logs.includes("upload_aborted"));
  // studio-manager wires the router: attach -> activityReport (email), everything else -> log-only insert.
  const studio = readFileSync("supabase/functions/studio-manager/index.ts", "utf8");
  assert.match(studio, /audit: uploadAuditRouter\(\{\s*notify: \(event: any\) => activityReport\(/);
  assert.match(studio, /logOnly: \(event: any\) => activityLogOnly\(/);
  const logOnlyFn = studio.slice(studio.indexOf("async function activityLogOnly"), studio.indexOf("function studioUploadActivity"));
  assert.match(logOnlyFn, /email_status: "suppressed"/);
  assert.doesNotMatch(logOnlyFn, /resend|fetch\(/i);
  assert.match(readFileSync("supabase/migrations/20260925_issue91_upload_sessions.sql", "utf8"), /'failed', 'suppressed'/);
});

test("download_full_beat compatibility: chunked master returns download_url null + parts; single-object path untouched", async () => {
  const env = makeEnv({ limits: SMALL });
  const path = makeWav("dl.wav", 600 * KiB);
  const up = await fullUpload(env, env.beatbay, env.ctx.owner, { path });
  await env.beatbay.handleAttach({ intake: "beatbox", id: BEAT, kind: "full", session_id: up.sessionId }, env.ctx.owner);
  const beat = await env.db.getBeat(BEAT);
  const dl = await env.beatbay.manifestDownload(beat.full_audio_path, 300);
  assert.equal(dl.download_url, null, "old clients get no URL instead of manifest.json-as-audio");
  assert.ok(!("manifest_url" in dl));
  assert.equal(dl.chunked, true);
  assert.equal(dl.manifest.total_bytes, readFileSync(path).length);
  assert.equal(dl.manifest.manifest_root_sha256, up.complete.body.manifest_root_sha256);
  assert.deepEqual(dl.parts.map((p) => p.idx), [0, 1, 2]);
  assert.ok(dl.parts.every((p) => p.url && !p.url.includes("manifest.json") && p.sha256 === up.h.list[p.idx]));
  assert.equal(dl.expires_in, 300);
  assert.equal(await env.beatbay.manifestDownload("beatbay/x/full/master.wav", 300), null, "single-object masters are not handled here");
  // The Edge function: chunked branch returns the body as is; the single-object lines are the original ones.
  const src = readFileSync("supabase/functions/beatbay-manager/index.ts", "utf8");
  const action = src.slice(src.indexOf('if (action === "download_full_beat")'), src.indexOf('if (action === "save_auction")'));
  assert.match(action, /isSessionManifestPath\(beat\.full_audio_path\)[\s\S]*?return json\(chunked\);/);
  assert.doesNotMatch(action, /download_url: chunked/);
  assert.match(action, /createSignedUrl\(beat\.full_audio_path, PRIVATE_DOWNLOAD_TTL_SECONDS, \{ download: true \}\)[\s\S]*?return json\(\{ download_url: signed\.signedUrl, expires_in: PRIVATE_DOWNLOAD_TTL_SECONDS \}\);/);
});

test("replaced chunked masters: never auto-deleted; owner dry-run lists replaced_parts + bytes_reclaimable; delete only with confirm", async () => {
  const env = makeEnv({ limits: SMALL });
  const a = makeWav("masterA.wav", 600 * KiB);
  const upA = await fullUpload(env, env.beatbay, env.ctx.owner, { path: a });
  await env.beatbay.handleAttach({ intake: "beatbox", id: BEAT, kind: "full", session_id: upA.sessionId }, env.ctx.owner);
  const b = makeWav("masterB.wav", 400 * KiB);
  const upB = await fullUpload(env, env.beatbay, env.ctx.owner, { path: b });
  await env.beatbay.handleAttach({ intake: "beatbox", id: BEAT, kind: "full", session_id: upB.sessionId }, env.ctx.owner);
  // stems replaced too
  const z1 = makeZip("st1.zip", [{ name: "a.wav", bytes: Buffer.concat([wavHeader(5000), randomBytes(5000)]) }]);
  const z2 = makeZip("st2.zip", [{ name: "b.wav", bytes: Buffer.concat([wavHeader(6000), randomBytes(6000)]) }]);
  const s1 = await fullUpload(env, env.beatbay, env.ctx.owner, { path: z1, kind: "stems" });
  await env.beatbay.handleAttach({ id: BEAT, kind: "stems", session_id: s1.sessionId }, env.ctx.owner);
  const s2 = await fullUpload(env, env.beatbay, env.ctx.owner, { path: z2, kind: "stems" });
  await env.beatbay.handleAttach({ id: BEAT, kind: "stems", session_id: s2.sessionId }, env.ctx.owner);
  const aObjects = objectsUnder(env, upA.sessionId).length;
  assert.equal(aObjects, 3 + 1);
  // Routine / automatic cleanup never touches them, even long after expiry.
  env.clock.advance(30 * 24 * 3600 * 1000);
  await env.beatbay.cleanup();
  await start(env, env.beatbay, env.ctx.owner, { path: makeWav("trigger.wav", 10 * KiB), beat_id: BEAT2 }); // opportunistic pass
  assert.equal(objectsUnder(env, upA.sessionId).length, aObjects);
  // Owner dry run (the action's default): listed, nothing deleted.
  const dry = await env.beatbay.cleanup({ replaced: "dry_run" });
  assert.equal(dry.replaced.dry_run, true);
  assert.deepEqual(dry.replaced.replaced_parts.map((r) => r.session_id).sort(), [upA.sessionId, s1.sessionId].sort());
  const ra = dry.replaced.replaced_parts.find((r) => r.session_id === upA.sessionId);
  const manifestBytes = env.storage.objects.get(`uploads/${upA.sessionId}/manifest.json`).bytes.byteLength;
  assert.equal(ra.bytes, readFileSync(a).length + manifestBytes);
  assert.equal(ra.object_count, 4);
  assert.ok(ra.paths.every((p) => p.startsWith(`uploads/${upA.sessionId}/`)));
  const expected = dry.replaced.replaced_parts.reduce((sum, r) => sum + r.bytes, 0);
  assert.equal(dry.replaced.bytes_reclaimable, expected);
  assert.equal(objectsUnder(env, upA.sessionId).length, aObjects, "dry run deletes nothing");
  // confirm limited to one session
  const one = await env.beatbay.cleanup({ replaced: "confirm", sessionIds: [s1.sessionId] });
  assert.deepEqual(one.replaced.deleted_session_ids, [s1.sessionId]);
  assert.deepEqual(objectsUnder(env, s1.sessionId), []);
  assert.equal(objectsUnder(env, upA.sessionId).length, aObjects);
  // confirm all
  const all = await env.beatbay.cleanup({ replaced: "confirm" });
  assert.deepEqual(all.replaced.deleted_session_ids, [upA.sessionId]);
  assert.equal(all.replaced.bytes_reclaimed, ra.bytes);
  assert.equal(all.replaced.bytes_reclaimable, 0);
  assert.deepEqual(objectsUnder(env, upA.sessionId), []);
  assert.equal((await env.db.getSession(upA.sessionId)).status, "replaced");
  // Current masters (B, stems s2) are never listed or touched.
  assert.equal(objectsUnder(env, upB.sessionId).length, 2 + 1);
  assert.ok(objectsUnder(env, s2.sessionId).length > 0);
  assert.equal((await env.db.getSession(upB.sessionId)).status, "attached");
  assert.equal((await env.beatbay.cleanup({ replaced: "dry_run" })).replaced.replaced_parts.length, 0);
  // Re-pointing between dry run and confirm is respected (re-checked before delete).
  const c = makeWav("masterC.wav", 300 * KiB);
  const upC = await fullUpload(env, env.beatbay, env.ctx.owner, { path: c, beat_id: BEAT2 });
  await env.beatbay.handleAttach({ intake: "beatbox", id: BEAT2, kind: "full", session_id: upC.sessionId }, env.ctx.owner);
  const d = makeWav("masterD.wav", 300 * KiB);
  const upD = await fullUpload(env, env.beatbay, env.ctx.owner, { path: d, beat_id: BEAT2 });
  await env.beatbay.handleAttach({ intake: "beatbox", id: BEAT2, kind: "full", session_id: upD.sessionId }, env.ctx.owner);
  const listed = await env.beatbay.cleanup({ replaced: "dry_run" });
  assert.deepEqual(listed.replaced.replaced_parts.map((r) => r.session_id), [upC.sessionId]);
  env.db.state.beats.get(BEAT2).full_audio_path = `uploads/${upC.sessionId}/manifest.json`; // owner rolled back to C
  const conf = await env.beatbay.cleanup({ replaced: "confirm", sessionIds: [upC.sessionId] });
  assert.deepEqual(conf.replaced.deleted_session_ids, []);
  assert.ok(objectsUnder(env, upC.sessionId).length > 0);
  // Owner-only + confirm wiring in the Edge function.
  const src = readFileSync("supabase/functions/beatbay-manager/index.ts", "utf8");
  const cleanupAction = src.slice(src.indexOf('if (action === "cleanup_uploads")'), src.indexOf('if (action === "save_beat")'));
  assert.match(cleanupAction, /if \(!ownerAccess\) return json\(\{ error: "Owner approval required", code: "FORBIDDEN" \}, 403\);/);
  assert.match(cleanupAction, /replaced: body\.confirm === true \? "confirm" : "dry_run"/);
});

test("small-file path regression: create_upload/attach_asset untouched (diff is additions only) and routing", async () => {
  // Runtime routing: old-style bodies never enter the session path.
  assert.equal(isSessionAttach({ action: "attach_asset", id: BEAT, kind: "full", path: "beatbay/x/full/a.wav" }), false);
  assert.equal(isSessionAttach({ action: "attach_asset", id: BEAT, kind: "full", path: "p", session_id: "" }), false);
  assert.equal(isSessionAttach({ action: "attach_asset", id: BEAT, kind: "full", path: "p", session_id: null }), false);
  assert.equal(isSessionAttach({ action: "attach_asset", id: BEAT, kind: "full", session_id: "x" }), true);
  assert.ok(!UPLOAD_ACTIONS.includes("create_upload") && !UPLOAD_ACTIONS.includes("attach_asset"));
  assert.equal(isSessionManifestPath("beatbay/1/full/a.wav"), false);
  assert.equal(isSessionManifestPath(`uploads/${BEAT}/manifest.json`), true);
  assert.equal(isSessionManifestPath(`uploads/${BEAT}/../x/manifest.json`), false);

  const files = ["supabase/functions/beatbay-manager/index.ts", "supabase/functions/studio-manager/index.ts", "supabase/functions/beatbay-manager/beatbox-guard.mjs"];
  let base = null;
  try { base = execFileSync("git", ["merge-base", "HEAD", "c1064be"], { encoding: "utf8" }).trim(); } catch { /* shallow clone */ }
  if (!base) { console.log("# skip diff regression: base commit c1064be not available"); return; }
  for (const file of files) {
    const diff = execFileSync("git", ["diff", "-U0", base, "--", file], { encoding: "utf8" });
    const removed = diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
    assert.deepEqual(removed, [], `${file} must only gain lines`);
  }
  const src = readFileSync("supabase/functions/beatbay-manager/index.ts", "utf8");
  const orig = execFileSync("git", ["show", `${base}:supabase/functions/beatbay-manager/index.ts`], { encoding: "utf8" });
  const block = (s, a, b) => s.slice(s.indexOf(a), s.indexOf(b));
  assert.equal(block(src, 'if (action === "create_upload")', 'if (action === "attach_asset")'), block(orig, 'if (action === "create_upload")', 'if (action === "attach_asset")'), "create_upload byte-identical");
  const attachNew = block(src, 'if (action === "attach_asset")', 'if (action === "download_full_beat")');
  const attachOld = block(orig, 'if (action === "attach_asset")', 'if (action === "download_full_beat")');
  const inserted = attachNew.slice(attachNew.indexOf("      if (isSessionAttach(body)) {"), attachNew.indexOf("      const id = String(body.id"));
  assert.equal(attachNew.replace(inserted, ""), attachOld, "attach_asset small-file branch byte-identical");
  assert.match(src, /music_uploader is intentionally excluded/);
  assert.match(src, /if \(action === "cleanup_uploads"\) \{\n\s+if \(!ownerAccess\) return json/);
  assert.ok(src.indexOf("UPLOAD_ACTIONS.includes(action)") < src.indexOf('if (action === "save_beat")'));
  const studio = readFileSync("supabase/functions/studio-manager/index.ts", "utf8");
  assert.doesNotMatch(studio, /cleanup_uploads/);
  assert.match(studio, /ownerTier: false/);
  assert.match(studio, /studioAuthorizer/);
  for (const f of ["supabase/functions/_shared/upload-sessions.mjs", "supabase/functions/_shared/upload-sessions-supabase.mjs"]) {
    const text = readFileSync(f, "utf8");
    assert.doesNotMatch(text, /storefront_enabled:\s*true|sk_live_|whsec_|SUPABASE_SERVICE_ROLE_KEY\s*=|eyJ[a-zA-Z0-9_-]{20,}/);
    assert.doesNotMatch(text, /release-public/, "parts never go to the public bucket");
  }
});

test("defaults: 900 MiB max file, 16 MiB chunks (< 50 MiB), 45 MiB threshold, 24 h TTL, 5 attempts", () => {
  assert.equal(DEFAULT_LIMITS.max_file_bytes, 900 * MiB);
  assert.equal(DEFAULT_LIMITS.chunk_bytes, 16 * MiB);
  assert.ok(DEFAULT_LIMITS.chunk_bytes < 50 * MiB);
  assert.equal(DEFAULT_LIMITS.single_object_threshold, 45 * MiB);
  assert.equal(DEFAULT_LIMITS.session_ttl_seconds, 86400);
  assert.equal(DEFAULT_LIMITS.max_attempts, 5);
  assert.deepEqual(Object.keys(DEFAULT_LIMITS.allowed).sort(), ["full", "stems", "video", "zip"]);
  const sql = readFileSync("supabase/migrations/20260925_issue91_upload_sessions.sql", "utf8");
  for (const [col, val] of [["max_file_bytes", 943718400], ["chunk_bytes", 16777216], ["single_object_threshold", 47185920], ["session_ttl_seconds", 86400], ["max_attempts", 5], ["max_total_upload_bytes", 1006632960]]) {
    assert.match(sql, new RegExp(`${col} \\w+ not null default ${val}`), `migration default for ${col} matches DEFAULT_LIMITS`);
  }
  assert.equal(DEFAULT_LIMITS.max_total_upload_bytes, 1006632960);
});

test("1 GiB stored ZIP: refused by Free defaults (LIMIT_EXCEEDED); verified when config allows (ISSUE91_BIG=1)", async (t) => {
  const env = makeEnv();
  const over = await env.beatbay.handle("start_upload", { beat_id: BEAT, kind: "zip", filename: "big.zip", total_bytes: 1024 * MiB, head_sha256: "a".repeat(64) }, env.ctx.owner);
  assert.equal(over.body.code, ERR.LIMIT_EXCEEDED);
  if (process.env.ISSUE91_BIG !== "1") { t.diagnostic("1 GiB end-to-end skipped (set ISSUE91_BIG=1)"); return; }
  const dir = mkdtempSync(join(TMP, "big-"));
  const fd = openSync(join(dir, "master.wav"), "w");
  writeSync(fd, wavHeader(1024 * MiB - 44));
  writeRandom(fd, 1024 * MiB - 44);
  closeSync(fd);
  execFileSync("zip", ["-q", "-0", "-X", join(TMP, "big.zip"), "master.wav"], { cwd: dir });
  rmSync(dir, { recursive: true, force: true });
  const env2 = makeEnv({ limits: { max_file_bytes: 2048 * MiB, max_total_upload_bytes: 4096 * MiB } });
  const up = await fullUpload(env2, env2.beatbay, env2.ctx.owner, { path: join(TMP, "big.zip"), kind: "zip" });
  assert.equal(up.complete.status, 200, JSON.stringify(up.complete.body));
  assert.equal(up.r.body.chunk_count, 65);
  assert.ok(env2.storage.stats.maxDownloadBytes <= 16 * MiB);
  rmSync(join(TMP, "big.zip"));
});
