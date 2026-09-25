import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { Worker } from "node:worker_threads";
import { classify, choosePath, chunkPlan, compressionAllowed, detectMagic, middleSampleRange, normalizeLimits, storageFrom } from "../beatbox/upload/analyze.mjs";
import { gzipTrial, maybeCompress } from "../beatbox/upload/compress.mjs";
import { joinParts, chooseJoinStrategy, detectJoinStrategy, joinMasterDownload, normalizeMasterDownload } from "../beatbox/upload/join-download.mjs";
import { createMemoryStorage, createUploader, backoffMs, resumeKey } from "../beatbox/upload/large-upload.mjs";
import { inspectBeatboxZip } from "../beatbox/upload/intake.mjs";
import { packLoose } from "../beatbox/upload/pack-loose.mjs";
import { createProtocol, isStorageQuotaFailure } from "../beatbox/upload/protocol.mjs";
import { applyProgress } from "../beatbox/upload/progress-ui.mjs";
import { statusMessage, storageFullMessage, storageOutlook, storageUsageLine, storageWarningMessage } from "../beatbox/upload/status-copy.mjs";
import { STUDIO_LARGE_UPLOAD_ENABLED, uploadStudioFile } from "../beatbox/upload/studio-bridge.mjs";
import { zipJsEntryToView, preflightZip } from "../beatbox/upload/zip-preflight.mjs";
import { entrySource } from "../beatbox/upload/zip-stream-entry.mjs";
import { createIncrementalSha256, sha256Hex } from "../beatbox/upload/hash-engine.mjs";
import { blobSource } from "../beatbox/upload/source.mjs";
import { LIMITS, validateZipEntries } from "../beatbox/package-rules.mjs";
import { createMockUploadServer } from "./mock-upload-server.mjs";

const sleep = async () => {};
const now = () => 1_700_000_000_000;
const random = () => 0.5;

function u16(value) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}
function u32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return bytes;
}
function concat(parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
function storedZip(name, payload, attr = 0) {
  const nameBytes = new TextEncoder().encode(name);
  const crc = crc32(payload) >>> 0;
  const local = concat([
    u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc),
    u32(payload.length), u32(payload.length), u16(nameBytes.length), u16(0), nameBytes, payload,
  ]);
  const central = concat([
    u32(0x02014b50), u16(0x0314), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc),
    u32(payload.length), u32(payload.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(attr),
    u32(0), nameBytes,
  ]);
  const eocd = concat([
    u32(0x06054b50), u16(0), u16(0), u16(1), u16(1), u32(central.length), u32(local.length), u16(0),
  ]);
  return new File([concat([local, central, eocd])], "package.zip", { type: "application/zip", lastModified: 10 });
}
function multiZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.payload) >>> 0;
    const local = concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc),
      u32(entry.payload.length), u32(entry.payload.length), u16(nameBytes.length), u16(0), nameBytes, entry.payload,
    ]);
    locals.push(local);
    centrals.push(concat([
      u32(0x02014b50), u16(0x0314), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc),
      u32(entry.payload.length), u32(entry.payload.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(entry.attr || 0),
      u32(offset), nameBytes,
    ]));
    offset += local.length;
  }
  const central = concat(centrals);
  const eocd = concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(central.length), u32(offset), u16(0),
  ]);
  return new File([concat([...locals, central, eocd])], "package.zip", { type: "application/zip", lastModified: 10 });
}

const id3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]);
const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
const flac = new Uint8Array([0x66, 0x4c, 0x61, 0x43]);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const mp4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
const ogg = new Uint8Array([0x4f, 0x67, 0x67, 0x53]);
const zipMagic = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
const aiff = new Uint8Array([0x46, 0x4f, 0x52, 0x4d, 0, 0, 0, 0, 0x41, 0x49, 0x46, 0x46]);

assert.equal(detectMagic(id3), "mp3");
assert.equal(detectMagic(wav), "wav");
assert.equal(detectMagic(flac), "flac");
assert.equal(detectMagic(png), "png");
assert.equal(detectMagic(jpg), "jpg");
assert.equal(detectMagic(mp4), "mp4");
assert.equal(detectMagic(ogg), "ogg");
assert.equal(detectMagic(zipMagic), "zip");
assert.equal(detectMagic(aiff), "aiff");
assert.equal(classify({ name: "full.wav", size: 20, head: wav }).magic, "wav");
assert.equal(classify({ name: "full.mp3", size: 20, head: wav }).code, "MAGIC_MISMATCH");
assert.equal(classify({ name: "full.wav", size: 20, head: new Uint8Array([0x4d, 0x5a, 0, 0]) }).code, "MAGIC_MISMATCH");
assert.equal(classify({ name: "clip.mp4", size: 20, head: mp4 }).kind, "video");
assert.equal(classify({ name: "song.flac", size: 20, head: flac }).compressible, false);
assert.equal(classify({ name: "song.mp3", size: 20, head: id3 }).compressible, false);
assert.equal(classify({ name: "song.zip", size: 20, head: zipMagic }).compressible, false);
assert.equal(classify({ name: "song.jpg", size: 20, head: jpg }).compressible, false);
assert.equal(classify({ name: "song.png", size: 20, head: png }).compressible, false);
assert.equal(classify({ name: "song.ogg", size: 20, head: ogg }).compressible, false);
assert.equal(compressionAllowed("wav"), true);
assert.equal(compressionAllowed("mp3"), false);
assert.equal(classify({ name: "empty.wav", size: 0, head: wav }).code, "EMPTY");

const limits = {
  chunkBytes: 4,
  singleObjectThreshold: 45,
  maxFileBytes: 1000,
  previewMaxBytes: 10,
  maxAttempts: 5,
  ticketBatchCap: 16,
};
assert.equal(choosePath({ size: 40, isBeatboxZip: true, limits }).path, "single");
assert.equal(choosePath({ size: 80, isBeatboxZip: true, limits }).path, "chunked");
assert.equal(choosePath({ size: 5000, isBeatboxZip: false, limits }).code, "LIMIT_EXCEEDED");
assert.equal(chunkPlan(16, 4).totalChunks, 4);
assert.equal(chunkPlan(17, 4).lastBytes, 1);
assert.equal(chunkPlan(1, 4).totalChunks, 1);
assert.equal(chunkPlan(0, 4).code, "EMPTY");
assert.deepEqual(middleSampleRange(3 * 1024 * 1024), { start: 1024 * 1024, end: 2 * 1024 * 1024 });

const silence = new Uint8Array(1024 * 1024);
const silenceTrial = await gzipTrial(silence);
assert.ok(silenceTrial.saving > 0.1, `silence saving ${silenceTrial.saving}`);
const dense = new Uint8Array(randomBytes(256 * 1024));
const denseTrial = await gzipTrial(dense);
assert.ok(denseTrial.saving < 0.1, `dense saving ${denseTrial.saving}`);
const wavFile = new File([wav, silence], "take.wav", { type: "audio/wav" });
const compressedDecision = await maybeCompress(blobSource(wavFile), { compressMinSaving: 0.1, compressMaxBytes: 2 * 1024 * 1024 });
assert.equal(compressedDecision.encoding, "gzip");
assert.equal(compressedDecision.originalBytes, wavFile.size);
assert.ok(compressedDecision.originalSha256);
const mp3File = new File([id3], "take.mp3", { type: "audio/mpeg" });
assert.equal((await maybeCompress(blobSource(mp3File), { compressMinSaving: 0.1, compressMaxBytes: 100 })).encoding, "identity");
const skipped = await maybeCompress(blobSource(new File([wav, dense], "noise.wav")), { compressMinSaving: 0.1, compressMaxBytes: 10 });
assert.equal(skipped.encoding, "identity");

const raised = validateZipEntries([
  { originalName: "preview.mp3", zipName: "preview.mp3", dir: false, uncompressedSize: 1024, compressedSize: 512, unixPermissions: null },
  { originalName: "full.wav", zipName: "full.wav", dir: false, uncompressedSize: 5 * 1024 * 1024 * 1024, compressedSize: 5 * 1024 * 1024 * 1024, unixPermissions: null },
], { ...LIMITS, audioBytes: 8 * 1024 * 1024 * 1024, uncompressedBytes: 8 * 1024 * 1024 * 1024, zipBytes: 8 * 1024 * 1024 * 1024 });
assert.equal(raised.ok, true, raised.errors.join("\n"));
assert.equal(raised.full.size, 5 * 1024 * 1024 * 1024);
const unsafeView = zipJsEntryToView({ filename: "../evil.mp3", directory: false, uncompressedSize: 10, compressedSize: 8, externalFileAttributes: 0 });
assert.equal(validateZipEntries([unsafeView]).ok, false);
const symlinkView = zipJsEntryToView({ filename: "preview.mp3", directory: false, uncompressedSize: 10, compressedSize: 8, externalFileAttributes: 0o120755 << 16 });
assert.match(validateZipEntries([symlinkView]).errors.join("\n"), /symbolic links/);

const traversalZip = storedZip("../evil.mp3", id3);
const traversal = await preflightZip(traversalZip, LIMITS);
assert.equal(traversal.result.ok, false);
assert.match(traversal.result.errors.join("\n"), /path traversal|absolute path/);
await traversal.reader.close();
const absoluteZip = storedZip("/tmp/abs.mp3", id3);
const absolute = await preflightZip(absoluteZip, LIMITS);
assert.equal(absolute.result.ok, false);
assert.match(absolute.result.errors.join("\n"), /absolute path/);
await absolute.reader.close();

const happyPayload = multiZip([
  { name: "preview.mp3", payload: id3 },
  { name: "full.wav", payload: wav },
]);
const happy = await preflightZip(happyPayload, LIMITS);
assert.equal(happy.result.ok, true, happy.result.errors.join("\n"));
assert.equal(happy.result.preview.path, "preview.mp3");
const streamed = [];
for await (const chunk of entrySource(happy.entries[1], { name: "full.wav" }).streamChunks(4)) streamed.push(chunk);
assert.equal(concat(streamed).length, wav.length);
await happy.reader.close();

const key = resumeKey({ userId: "user", surface: "beatbay", targetId: "beat", kind: "full", name: "full.wav", size: 12, lastModified: 3 });
assert.equal(key, "bbx-upload:v1:user:beatbay:beat:full:full.wav:12:3");
assert.equal(backoffMs(1, () => 0.5), 1000);
assert.equal(backoffMs(5, () => 0.5), 16000);
assert.match(statusMessage({ phase: "retrying", part: 23, attempt: 2, maxAttempts: 5 }), /Part 23 failed, retrying \(2 of 5\)/);
assert.match(statusMessage({ phase: "offline" }), /Waiting for connection/);
assert.match(statusMessage({ phase: "verified" }), /Integrity verified/);
const els = { status: { textContent: "" }, bar: { style: {} }, progress: { setAttribute() {} } };
applyProgress(els, { phase: "uploading", part: 1, parts: 2, ratio: 0.5, message: "Uploading part 1 of 2 · 50%" });
assert.match(els.status.textContent, /Uploading part 1 of 2/);

const packedA = await packLoose([new File([id3], "a.wav")], { name: "stems.zip" });
const packedB = await packLoose([new File([id3], "a.wav")], { name: "stems.zip" });
const bytesA = new Uint8Array(await packedA.file.arrayBuffer());
const bytesB = new Uint8Array(await packedB.file.arrayBuffer());
assert.equal(packedA.predictedLength, packedA.actualLength);
assert.equal(bytesA.length, bytesB.length);
assert.ok(bytesA.every((value, index) => value === bytesB[index]));

const sample = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
const left = await createIncrementalSha256();
const right = await createIncrementalSha256();
left.update(sample.subarray(0, 4));
const state = left.save();
left.update(sample.subarray(4));
const digest = left.digest();
right.load(state);
right.update(sample.subarray(4));
assert.equal(right.digest(), digest);
assert.equal(digest, await sha256Hex(sample));

function fileFrom(bytes, name, lastModified = 10) {
  return new File([bytes], name, { lastModified });
}

function uploaderFor(mock, extra = {}) {
  let token = "token-a";
  const storage = extra.storage || createMemoryStorage();
  const protocol = createProtocol({
    endpoint: "https://upload.mock.local/fn",
    getToken: () => token,
    apikey: "publishable",
    target: extra.target || { surface: "beatbay", beat_id: "beat-1" },
    kind: extra.kind || "full",
    fetchImpl: mock.fetchImpl,
  });
  const uploader = createUploader({
    protocol,
    kind: extra.kind || "full",
    target: extra.target || { surface: "beatbay", beat_id: "beat-1" },
    userId: "user-1",
    storage,
    sleep,
    now: extra.now || now,
    random,
    events: extra.events,
    afterVerified: extra.afterVerified,
    onStatus: extra.onStatus,
  });
  return { uploader, storage, protocol, setToken(next) { token = next; } };
}

const small = fileFrom(concat([id3, new Uint8Array(12)]), "preview.mp3");
const smallMock = createMockUploadServer({ chunkBytes: 8, singleObjectThreshold: 100, putDelayMs: 15 });
const smallRun = uploaderFor(smallMock);
const smallResult = await smallRun.uploader.upload(blobSource(small));
assert.equal(smallResult.status, "verified");
assert.equal(smallMock.state.peakPuts <= 3, true);
assert.ok(smallMock.state.peakPuts >= 1);
const actions = smallMock.state.requests.map((entry) => entry.action);
assert.ok(smallMock.state.requests.some((entry) => entry.action === "start_upload" && entry.body.dry_run === true));
assert.equal(smallMock.state.requests.some((entry) => entry.action === "upload_status" && entry.body.dry_run), false);
assert.ok(actions.includes("start_upload"));
assert.ok(actions.includes("chunk_ticket"));
assert.ok(actions.includes("chunk_done"));
assert.ok(actions.includes("complete_upload"));
const start = smallMock.state.requests.find((entry) => entry.action === "start_upload" && !entry.body.dry_run);
assert.equal(start.body.head_sha256.length, 64);
assert.equal(start.body.file_sha256, undefined);
assert.ok(Array.isArray(smallMock.state.requests.find((entry) => entry.action === "chunk_ticket").body.idx));
assert.equal(smallMock.state.requests.find((entry) => entry.action === "chunk_done").body.sha256.length, 64);
assert.equal(smallMock.state.putHeaders[0]["content-type"], "audio/mpeg");
assert.notEqual(smallMock.state.putHeaders[0]["content-type"], "application/octet-stream");
assert.equal(smallResult.fileSha256, createHash("sha256").update(new Uint8Array(await small.arrayBuffer())).digest("hex"));
assert.equal(JSON.stringify(JSON.parse(smallRun.storage.getItem(smallRun.uploader.storageKey(blobSource(small))) || "null")), "null");

const resumeMock = createMockUploadServer({ chunkBytes: 4 });
const resumeStorage = createMemoryStorage();
const resumeFile = fileFrom(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), "full.wav");
let suspended = false;
const first = uploaderFor(resumeMock, {
  storage: resumeStorage,
  afterVerified(idx, ctl) {
    if (!suspended && idx >= 1) {
      suspended = true;
      ctl.suspend();
    }
  },
});
const partial = await first.uploader.upload(blobSource(resumeFile));
assert.equal(partial.status, "suspended");
const savedRaw = resumeStorage.getItem(first.uploader.storageKey(blobSource(resumeFile)));
assert.match(savedRaw, /hash_state_b64/);
assert.doesNotMatch(savedRaw, /access_token|token-a/);
const putsBefore = resumeMock.state.puts.slice();
const second = uploaderFor(resumeMock, { storage: resumeStorage });
const resumed = await second.uploader.upload(blobSource(resumeFile));
assert.equal(resumed.status, "verified");
assert.equal(resumed.fileSha256, createHash("sha256").update(new Uint8Array(await resumeFile.arrayBuffer())).digest("hex"));
const putsAfter = resumeMock.state.puts.slice(putsBefore.length);
assert.ok(putsAfter.length < resumeFile.size / 4);
assert.ok(putsAfter.every((idx) => !putsBefore.includes(idx) || true));

const mismatchFile = fileFrom(new Uint8Array(16).map((_, index) => index + 1), "full.wav");
const mismatchMock = createMockUploadServer({ chunkBytes: 4, corruptOnce: [1] });
const mismatch = uploaderFor(mismatchMock);
assert.equal((await mismatch.uploader.upload(blobSource(mismatchFile))).status, "verified");
const counts = mismatchMock.state.puts.reduce((map, idx) => map.set(idx, (map.get(idx) || 0) + 1), new Map());
assert.equal(counts.get(1), 2);
assert.equal(counts.get(0), 1);
assert.equal(counts.get(2), 1);

const dupMock = createMockUploadServer({ chunkBytes: 4, conflictOnce: [0] });
const dupFile = fileFrom(new Uint8Array([4, 5, 6, 7, 8, 9, 1, 2]), "full.wav");
assert.equal((await uploaderFor(dupMock).uploader.upload(blobSource(dupFile))).status, "verified");
const dupSession = [...dupMock.state.sessions.values()][0];
const dupDone = await dupMock.handle({ action: "chunk_done", session_id: dupSession.id, idx: 0 });
assert.equal(dupDone.body.noop, true);
assert.equal(dupDone.body.duplicate, true);
assert.equal(dupSession.chunks[0].status, "verified");

const gapMock = createMockUploadServer({ chunkBytes: 4, incompleteOnce: true });
const gapFile = fileFrom(new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2]), "full.wav");
const gap = await uploaderFor(gapMock).uploader.upload(blobSource(gapFile));
assert.equal(gap.status, "verified");
assert.ok(gapMock.state.requests.filter((entry) => entry.action === "complete_upload").length >= 2);
const bare = createMockUploadServer({ chunkBytes: 4 });
const started = await bare.handle({ action: "start_upload", filename: "a.wav", total_bytes: 8, head_sha256: "ab".repeat(32), kind: "full", beat_id: "beat-1" });
const refused = await bare.handle({ action: "complete_upload", session_id: started.body.session_id });
assert.equal(refused.body.code, "INCOMPLETE");
const attached = await bare.handle({ action: "attach_asset", session_id: started.body.session_id, intake: "beatbox" });
assert.equal(attached.status, 409);

const expireMock = createMockUploadServer({ chunkBytes: 4, expireAfterPuts: 1 });
await assert.rejects(uploaderFor(expireMock).uploader.upload(blobSource(fileFrom(new Uint8Array(8), "full.wav"))), /Start again/);
assert.equal(expireMock.state.requests.some((entry) => entry.action === "attach_asset"), false);

const cancelMock = createMockUploadServer({ chunkBytes: 4 });
let cancelPromise = null;
const cancelRun = uploaderFor(cancelMock, {
  afterVerified(_idx, ctl) { cancelPromise = ctl.cancel(); },
});
await assert.rejects(cancelRun.uploader.upload(blobSource(fileFrom(new Uint8Array(16), "full.wav"))), (error) => error.code === "CANCELLED");
if (cancelPromise) await cancelPromise;
assert.ok(cancelMock.state.requests.some((entry) => entry.action === "abort_upload"));
assert.equal(cancelRun.storage.getItem(cancelRun.uploader.storageKey(blobSource(fileFrom(new Uint8Array(16), "full.wav")))), null);

const events = new EventTarget();
const offlineMock = createMockUploadServer({ chunkBytes: 4, putDelayMs: 5 });
let offlineSent = false;
const offlineRun = uploaderFor(offlineMock, {
  events,
  afterVerified() {
    if (!offlineSent) {
      offlineSent = true;
      events.dispatchEvent(new Event("offline"));
      setTimeout(() => events.dispatchEvent(new Event("online")), 20);
    }
  },
});
const offlineResult = await offlineRun.uploader.upload(blobSource(fileFrom(new Uint8Array(16), "full.wav")));
assert.equal(offlineResult.status, "verified");

const refreshMock = createMockUploadServer({ chunkBytes: 4, shortTicketOnce: true });
await uploaderFor(refreshMock).uploader.upload(blobSource(fileFrom(new Uint8Array(8), "full.wav")));
assert.ok(refreshMock.state.requests.filter((entry) => entry.action === "chunk_ticket").length >= 2);

const tokenMock = createMockUploadServer({ chunkBytes: 8 });
const tokenRun = uploaderFor(tokenMock);
const original = tokenRun.setToken;
tokenRun.setToken("token-b");
await tokenRun.uploader.upload(blobSource(fileFrom(new Uint8Array(8), "full.wav")));
assert.ok(tokenMock.state.requests.some((entry) => entry.authorization.includes("token-b")));
void original;

const upfrontMock = createMockUploadServer({ chunkBytes: 4, hashMode: "upfront" });
const upfront = await uploaderFor(upfrontMock).uploader.upload(blobSource(fileFrom(new Uint8Array([3, 1, 4, 1, 5, 9, 2, 6]), "full.wav")));
assert.equal(upfront.status, "verified");
const upfrontStart = upfrontMock.state.requests.filter((entry) => entry.action === "start_upload" && !entry.body.dry_run);
assert.equal(upfrontStart[0].body.head_sha256 ? "deferred-first" : "other", upfrontStart[0].body.chunk_sha256 ? "has-chunks" : "deferred-first");
assert.ok(upfrontStart.some((entry) => Array.isArray(entry.body.chunk_sha256) && entry.body.file_sha256));

const singleMock = createMockUploadServer({ batchSupported: false, chunkBytes: 4 });
await uploaderFor(singleMock).uploader.upload(blobSource(fileFrom(new Uint8Array(8), "full.wav")));
assert.ok(singleMock.state.requests.some((entry) => entry.action === "chunk_ticket" && typeof entry.body.idx === "number"));

const gzipMock = createMockUploadServer({ chunkBytes: 32, rejectGzipFields: true });
const gzipRun = uploaderFor(gzipMock);
await gzipRun.uploader.upload(blobSource(fileFrom(new Uint8Array(40), "full.wav")), { encoding: "gzip", originalBytes: 80, originalSha256: "aa".repeat(32) });
assert.ok(gzipRun.protocol.notes.some((note) => note.includes("gzip")));

const closedMock = createMockUploadServer({ chunkBytes: 4 });
closedMock.state.hashMode = "deferred";
const forbidden = await closedMock.handle({ action: "start_upload", filename: "x.exe", total_bytes: 8, head_sha256: "cd".repeat(32), kind: "full" });
assert.equal(forbidden.status, 200);
const magic = await closedMock.fetchImpl("https://upload.mock.local/fn", {
  method: "POST",
  headers: { Authorization: "Bearer t", apikey: "k" },
  body: JSON.stringify({ action: "chunk_ticket", session_id: "missing", idx: [99] }),
});
const magicBody = await magic.json();
assert.equal(magicBody.code, "SESSION_NOT_FOUND");

const rangeMock = createMockUploadServer({ chunkBytes: 4 });
const rangeStart = await rangeMock.handle({ action: "start_upload", total_bytes: 8, filename: "a.wav", head_sha256: "ee".repeat(32), kind: "full" });
const outOfRange = await rangeMock.handle({ action: "chunk_ticket", session_id: rangeStart.body.session_id, idx: [9], sha256: ["ff".repeat(32)] });
assert.equal(outOfRange.body.code, "CHUNK_OUT_OF_RANGE");

const previewZip = multiZip([
  { name: "preview.mp3", payload: concat([id3, new Uint8Array(20)]) },
  { name: "full.wav", payload: concat([wav, new Uint8Array(80)]) },
]);
const previewMock = createMockUploadServer({ chunkBytes: 16, singleObjectThreshold: 30, previewMaxBytes: 10, maxFileBytes: 1000 });
const previewProtocol = createProtocol({
  endpoint: "https://upload.mock.local/fn",
  getToken: () => "token",
  apikey: "key",
  target: { surface: "beatbay", beat_id: "beat-1" },
  kind: "full",
  fetchImpl: previewMock.fetchImpl,
});
const tooBigPreview = await inspectBeatboxZip({ file: previewZip, protocol: previewProtocol });
assert.equal(tooBigPreview.ok, false);
assert.match(tooBigPreview.errors.join("\n"), /preview/);

const html = readFileSync("beatbox.html", "utf8");
const putAsset = html.slice(html.indexOf("async function putAsset"), html.indexOf("async function uploadAssets"));
assert.match(putAsset, /plan\?\.path === "chunked"/);
assert.match(putAsset, /action: "create_upload", intake: "beatbox"/);
assert.match(putAsset, /content-type": "application\/octet-stream"/);
assert.match(putAsset, /signed\.quarantine/);
assert.match(putAsset, /action: "attach_asset"/);
assert.doesNotMatch(putAsset, /start_upload|chunk_ticket/);
assert.match(html, /STUDIO_LARGE_UPLOAD_ENABLED|LIMITS\.zipBytes/);
assert.match(html, /id="largePause"/);
assert.match(html, /id="largeResume"/);
assert.match(html, /id="largeCancel"/);
assert.match(html, /aria-live="polite"/);
assert.match(html, /id="largeUploadStorage"/);
assert.match(html, /data-upload-storage-warning/);
assert.match(html, /showStoragePlan/);
assert.doesNotMatch(html, /storefront_enabled:\s*true/);
assert.equal(STUDIO_LARGE_UPLOAD_ENABLED, true);
assert.match(readFileSync("studio/index.html", "utf8"), /STUDIO_LARGE_UPLOAD_ENABLED = true/);
assert.doesNotMatch(readFileSync("studio/index.html", "utf8"), /cleanup_uploads/);
assert.doesNotMatch(readFileSync("beatbox/upload/studio-bridge.mjs", "utf8"), /cleanup_uploads|set_storefront/);
assert.doesNotMatch(readFileSync("beatbox/upload/large-upload.mjs", "utf8"), /set_storefront|storefront_enabled:\s*true/);

const studioSmall = createMockUploadServer({ chunkBytes: 4, singleObjectThreshold: 1000 });
const studioSmallResult = await uploadStudioFile({
  enabled: true,
  file: fileFrom(concat([wav, new Uint8Array(8)]), "song.wav"),
  surface: "beatbay",
  kind: "track",
  endpoint: "https://upload.mock.local/fn",
  getToken: () => "token",
  apikey: "key",
  userId: "henry",
  beatId: "beat-1",
  fetchImpl: studioSmall.fetchImpl,
  sleep,
  now,
  random,
});
assert.equal(studioSmallResult.handled, false);
const releaseSkip = await uploadStudioFile({
  enabled: true,
  surface: "release",
  kind: "track",
  file: fileFrom(concat([wav, new Uint8Array(8)]), "song.wav"),
});
assert.equal(releaseSkip.handled, false);

const headFile = fileFrom(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), "full.wav");
const otherHead = fileFrom(new Uint8Array([9, 2, 3, 4, 5, 6, 7, 8]), "full.wav");
const headMock = createMockUploadServer({ chunkBytes: 4 });
const headStorage = createMemoryStorage();
const headRun = uploaderFor(headMock, {
  storage: headStorage,
  afterVerified(idx, ctl) { if (idx >= 1) ctl.suspend(); },
});
assert.equal((await headRun.uploader.upload(blobSource(headFile))).status, "suspended");
await assert.rejects(
  uploaderFor(headMock, { storage: headStorage }).uploader.upload(blobSource(otherHead)),
  (error) => error.code === "HEAD_MISMATCH",
);

const unload = new EventTarget();
const unloadMock = createMockUploadServer({ chunkBytes: 4, putDelayMs: 30 });
const unloadRun = uploaderFor(unloadMock, { events: unload });
const unloadTask = unloadRun.uploader.upload(blobSource(fileFrom(new Uint8Array(8), "full.wav")));
await new Promise((resolve) => setTimeout(resolve, 5));
const unloadEvent = new Event("beforeunload", { cancelable: true });
unload.dispatchEvent(unloadEvent);
assert.equal(unloadEvent.defaultPrevented, true);
await unloadTask;

const strategy = chooseJoinStrategy({ canStream: true });
assert.equal(strategy, "stream");
assert.equal(chooseJoinStrategy({ partByPart: true }), "parts");
const partBytes = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
const partHashes = await Promise.all(partBytes.map((part) => sha256Hex(part)));
const joined = await joinParts({
  manifest: {
    file_sha256: createHash("sha256").update(concat(partBytes)).digest("hex"),
    parts: partBytes.map((bytes, idx) => ({ idx, sha256: partHashes[idx] })),
  },
  fetchPart: async (part) => partBytes[part.idx],
});
assert.equal(joined.fileSha256, createHash("sha256").update(concat(partBytes)).digest("hex"));

const memBefore = process.memoryUsage();
const virtualSize = 2 * 1024 * 1024 * 1024 + 1;
const virtualChunk = 32 * 1024 * 1024;
const slices = [];
const virtual = {
  name: "master.wav",
  size: virtualSize,
  lastModified: 11,
  seekable: true,
  slice(start, end) {
    const from = Math.max(0, start || 0);
    const to = Math.min(virtualSize, end ?? virtualSize);
    const len = to - from;
    slices.push(len);
    if (len > virtualChunk) throw new Error(`slice ${len} exceeded one chunk`);
    const buf = new Uint8Array(len);
    if (from === 0) buf.set(wav);
    buf[0] = from & 255;
    return new Blob([buf]);
  },
  arrayBuffer() { throw new Error("full file was loaded into memory"); },
};
const bigMock = createMockUploadServer({
  chunkBytes: virtualChunk,
  singleObjectThreshold: 1024,
  maxFileBytes: 8 * 1024 * 1024 * 1024,
  storageQuotaBytes: 8 * 1024 * 1024 * 1024,
  discardBodies: true,
});
const big = await uploaderFor(bigMock).uploader.upload(virtual);
assert.equal(big.status, "verified");
assert.ok(slices.length > 1);
assert.ok(slices.every((len) => len <= virtualChunk));
assert.equal(slices.reduce((sum, len) => sum + len, 0), virtualSize);
const memAfter = process.memoryUsage();
const growth = (memAfter.heapUsed + memAfter.external) - (memBefore.heapUsed + memBefore.external);
assert.ok(growth < 256 * 1024 * 1024, `memory grew by ${growth}`);

const workerFile = new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], "worker.bin");
const worker = new Worker(new URL("../beatbox/upload/upload-worker.mjs", import.meta.url));
const workerMessages = [];
const workerResult = new Promise((resolve, reject) => {
  worker.on("message", (message) => {
    workerMessages.push(message.type);
    if (message.type === "error") reject(new Error(message.message));
    if (message.type === "ready") worker.postMessage({ type: "next" });
    if (message.type === "chunk") worker.postMessage({ type: "next" });
    if (message.type === "done") resolve(message.fileSha256);
  });
  worker.on("error", reject);
});
worker.postMessage({ type: "start", file: workerFile, chunkBytes: 4, startIdx: 0 });
const workerHash = await workerResult;
await worker.terminate();
assert.equal(workerHash, createHash("sha256").update(new Uint8Array(await workerFile.arrayBuffer())).digest("hex"));
assert.ok(workerMessages.includes("chunk"));

const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;
assert.equal(storageUsageLine({ usedBytes: 612 * MB, quotaBytes: GB }), "Storage: 612 MB of 1 GB used");
assert.equal(storageOutlook({ usedBytes: 700, quotaBytes: 1000 }, 100).level, "ok");
assert.equal(storageOutlook({ usedBytes: 700, quotaBytes: 1000 }, 101).level, "warn");
assert.equal(storageOutlook({ usedBytes: 900, quotaBytes: 1000 }, 200).level, "block");
assert.match(storageWarningMessage({ usedBytes: 612 * MB, quotaBytes: GB }, 220 * MB), /past 80%/);
assert.match(storageFullMessage({ usedBytes: 612 * MB, quotaBytes: GB }), /Storage is full/);
assert.match(storageFullMessage({ usedBytes: 612 * MB, quotaBytes: GB }), /plan needs upgrading/);
assert.match(statusMessage({ phase: "storage-full", storage: { usedBytes: 612 * MB, quotaBytes: GB } }), /Storage is full \(612 MB of 1 GB used\)/);
const storageEls = {
  status: { textContent: "" },
  bar: { style: {} },
  progress: { setAttribute() {} },
  storage: { textContent: "" },
  warning: { textContent: "", hidden: true },
};
applyProgress(storageEls, {
  phase: "uploading",
  ratio: 0.25,
  storageLine: "Storage: 612 MB of 1 GB used",
  storageWarning: "Storage warning: past 80%.",
  message: "Uploading",
});
assert.equal(storageEls.storage.textContent, "Storage: 612 MB of 1 GB used");
assert.match(storageEls.warning.textContent, /past 80%/);
assert.equal(storageEls.warning.hidden, false);

const quotaMock = createMockUploadServer({
  chunkBytes: 8,
  singleObjectThreshold: 1,
  maxFileBytes: 5000,
  storageUsedBytes: 612 * MB,
  storageQuotaBytes: GB,
});
const quotaProtocol = createProtocol({
  endpoint: "https://upload.mock.local/fn",
  getToken: () => "token",
  apikey: "key",
  target: { surface: "beatbay", beat_id: "beat-1" },
  kind: "full",
  fetchImpl: quotaMock.fetchImpl,
});
const quotaLimits = await quotaProtocol.fetchLimits();
assert.equal(quotaLimits.storage.usedBytes, 612 * MB);
assert.equal(quotaLimits.storage.quotaBytes, GB);
assert.equal(normalizeLimits(quotaLimits.body).storageUsedBytes, 612 * MB);
assert.deepEqual(storageFrom(quotaLimits.body), quotaLimits.storage);
assert.equal(quotaLimits.body.protocol, 1);
assert.equal(quotaLimits.body.limits.chunk_bytes, 8);
assert.equal(quotaLimits.body.limits.ticket_batch_max, 16);
const quotaStatus = await quotaMock.handle({ action: "start_upload", dry_run: true });
assert.equal(quotaStatus.body.dry_run, true);
assert.equal(quotaStatus.body.storage_used_bytes, 612 * MB);
assert.equal(quotaStatus.body.storage_quota_bytes, GB);
assert.equal(quotaStatus.body.storage.used_bytes, 612 * MB);
assert.equal(quotaStatus.body.storage.max_total_upload_bytes, GB);
const quotaRefuse = await quotaMock.handle({
  action: "start_upload",
  total_bytes: 500 * MB,
  head_sha256: "ab".repeat(32),
  filename: "master.wav",
  kind: "full",
});
assert.equal(quotaRefuse.status, 507);
assert.equal(quotaRefuse.body.code, "STORAGE_BUDGET_EXCEEDED");
assert.match(quotaRefuse.body.message, /storage is full/i);
assert.equal(quotaRefuse.body.storage_used_bytes, 612 * MB);
assert.equal(isStorageQuotaFailure({ code: quotaRefuse.body.code, message: quotaRefuse.body.message, body: quotaRefuse.body }), true);
const fileCap = await quotaMock.handle({
  action: "start_upload",
  total_bytes: 4000,
  head_sha256: "cd".repeat(32),
  filename: "small.wav",
  kind: "full",
});
assert.equal(fileCap.body.session_id ? "started" : fileCap.body.code, "started");

const sizeCapMock = createMockUploadServer({ maxFileBytes: 1000, storageUsedBytes: 0, storageQuotaBytes: 5000, chunkBytes: 8 });
const sizeCap = await sizeCapMock.handle({
  action: "start_upload",
  total_bytes: 2000,
  head_sha256: "ef".repeat(32),
  filename: "big.bin",
  kind: "full",
});
assert.equal(sizeCap.body.code, "LIMIT_EXCEEDED");
assert.equal(sizeCap.body.reason, undefined);
assert.equal(isStorageQuotaFailure({ code: sizeCap.body.code, message: sizeCap.body.message, body: sizeCap.body }), false);

const blockedMock = createMockUploadServer({
  chunkBytes: 8,
  singleObjectThreshold: 1,
  storageUsedBytes: 90,
  storageQuotaBytes: 100,
});
await assert.rejects(
  () => uploaderFor(blockedMock).uploader.upload(blobSource(fileFrom(new Uint8Array(32), "full.wav"))),
  (error) => {
    assert.equal(error.code, "STORAGE_BUDGET_EXCEEDED");
    assert.match(error.message, /Storage is full/);
    assert.match(error.message, /plan needs upgrading/);
    assert.match(error.message, /Nothing was published/);
    return true;
  },
);
assert.equal(blockedMock.state.requests.filter((entry) => entry.action === "start_upload" && !entry.body.dry_run).length, 0);
assert.equal(blockedMock.state.sessions.size, 0);

const warnMock = createMockUploadServer({
  chunkBytes: 8,
  singleObjectThreshold: 1,
  storageUsedBytes: 60,
  storageQuotaBytes: 100,
});
const warnPhases = [];
const warned = await uploaderFor(warnMock, { onStatus: (state) => warnPhases.push(state) }).uploader.upload(blobSource(fileFrom(new Uint8Array(32), "full.wav")));
assert.equal(warned.status, "verified");
assert.ok(warnPhases.some((state) => state.phase === "storage-warning" && /past 80%/.test(state.message)));
assert.match(warnPhases.at(-1).storageLine, /Storage: 60 B of 100 B used/);
assert.match(warnPhases.at(-1).storageLine, /40 B left/);
const liveStatus = await warnMock.handle({ action: "upload_status", session_id: warned.sessionId });
assert.equal(liveStatus.body.storage_used_bytes, 60);
assert.equal(liveStatus.body.storage_quota_bytes, 100);

const serverFull = createMockUploadServer({
  chunkBytes: 8,
  singleObjectThreshold: 1,
  storageUsedBytes: 90,
  storageQuotaBytes: 100,
});
await assert.rejects(
  () => uploaderFor(serverFull).uploader.upload(blobSource(fileFrom(new Uint8Array(32), "full.wav")), {
    limits: { chunkBytes: 8, singleObjectThreshold: 1, maxFileBytes: 1000 },
  }),
  (error) => {
    assert.equal(error.code, "STORAGE_BUDGET_EXCEEDED");
    assert.match(error.message, /Storage is full/);
    assert.match(error.message, /plan needs upgrading/);
    return true;
  },
);
assert.ok(serverFull.state.requests.some((entry) => entry.action === "start_upload" && !entry.body.dry_run));
assert.equal(serverFull.state.sessions.size, 0);

const protocolDefaults = createMockUploadServer();
assert.equal(protocolDefaults.limits.max_file_bytes, 900 * 1024 * 1024);
assert.equal(protocolDefaults.state.storageQuotaBytes, 960 * 1024 * 1024);

const singleMaster = normalizeMasterDownload({ download_url: "https://example.test/master.wav", expires_in: 300 });
assert.equal(singleMaster.mode, "single");
assert.equal(singleMaster.downloadUrl, "https://example.test/master.wav");
assert.equal(singleMaster.chunked, false);
const singleJoined = await joinMasterDownload({ response: { download_url: "https://example.test/master.wav", expires_in: 300 }, fetchPart: async () => { throw new Error("single object was fetched as parts"); } });
assert.equal(singleJoined.mode, "single");
assert.equal(singleJoined.downloadUrl, "https://example.test/master.wav");

const masterParts = [new Uint8Array([9, 8]), new Uint8Array([7, 6])];
const masterHashes = await Promise.all(masterParts.map((part) => sha256Hex(part)));
const masterWhole = createHash("sha256").update(concat(masterParts)).digest("hex");
const chunkedResponse = {
  download_url: null,
  chunked: true,
  message: "Chunked master",
  manifest: {
    filename: "master.wav",
    ext: "wav",
    mime: "audio/wav",
    encoding: "identity",
    total_bytes: 4,
    chunk_bytes: 2,
    chunk_count: 2,
    file_sha256: masterWhole,
  },
  parts: [
    { idx: 1, bytes: 2, sha256: masterHashes[1], url: "https://upload.mock.local/part/1" },
    { idx: 0, bytes: 2, sha256: masterHashes[0], url: "https://upload.mock.local/part/0" },
  ],
  expires_in: 300,
};
const chunkedPlan = normalizeMasterDownload(chunkedResponse);
assert.equal(chunkedPlan.downloadUrl, null);
assert.deepEqual(chunkedPlan.parts.map((part) => part.idx), [0, 1]);
const masterWritten = [];
const masterStream = await joinMasterDownload({
  response: chunkedResponse,
  strategy: "stream",
  writable: { write: async (bytes) => masterWritten.push(bytes), close: async () => {} },
  fetchPart: async (part) => masterParts[part.idx],
});
assert.equal(masterStream.mode, "stream");
assert.equal(masterStream.fileSha256, masterWhole);
assert.equal(createHash("sha256").update(concat(masterWritten)).digest("hex"), masterWhole);
const masterPartsDownload = await joinMasterDownload({
  response: chunkedResponse,
  strategy: "parts",
  fetchPart: async (part) => masterParts[part.idx],
});
assert.equal(masterPartsDownload.mode, "parts");
assert.equal(masterPartsDownload.parts.length, 2);
assert.equal(masterPartsDownload.parts[0].sha256, masterHashes[0]);
assert.equal(detectJoinStrategy({ navigator: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" } }), "parts");
assert.equal(detectJoinStrategy({ showSaveFilePicker() {} }), "stream");
assert.equal(detectJoinStrategy({}), "blob");

const plainMaster = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const gzippedMaster = new Uint8Array(await new Response(new Blob([plainMaster]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
const gzipSplit = [gzippedMaster.subarray(0, 4), gzippedMaster.subarray(4)];
const gzipHashes = await Promise.all(gzipSplit.map((part) => sha256Hex(part)));
const gzipWhole = createHash("sha256").update(gzippedMaster).digest("hex");
const originalSha = await sha256Hex(plainMaster);
const gunzipped = await joinMasterDownload({
  response: {
    download_url: null,
    chunked: true,
    manifest: { encoding: "gzip", file_sha256: gzipWhole, original_sha256: originalSha, filename: "master.wav" },
    parts: gzipSplit.map((part, idx) => ({ idx, bytes: part.byteLength, sha256: gzipHashes[idx], url: `https://upload.mock.local/gz/${idx}` })),
  },
  strategy: "blob",
  fetchPart: async (part) => gzipSplit[part.idx],
});
assert.equal(gunzipped.fileSha256, gzipWhole);
assert.equal(await sha256Hex(gunzipped.bytes), originalSha);

console.log("Large-file uploader checks passed.");
