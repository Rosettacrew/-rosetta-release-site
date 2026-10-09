import { chunkPlan, normalizeLimits, storageFrom } from "./analyze.mjs";
import { bytesToBase64, base64ToBytes, createIncrementalSha256, sha256Hex } from "./hash-engine.mjs";
import { FAIL_CLOSED, TICKET_BATCH_CAP, TICKET_REFRESH_SECONDS, createProtocol, declaredContentType, headerContentType, isStorageQuotaFailure, retryFreshTicket } from "./protocol.mjs";
import { bytesOf } from "./source.mjs";
import { FILE_CHANGED_COPY, statusMessage, storageFullMessage, storageOutlook, storageUsageLine, storageWarningMessage } from "./status-copy.mjs";

export const PARALLEL_PUTS = 3;

export function resumeKey({ userId, surface, targetId, kind, name, size, lastModified }) {
  return `bbx-upload:v1:${userId}:${surface}:${targetId}:${kind}:${name}:${size}:${lastModified}`;
}

export function backoffMs(attempt, random = Math.random) {
  const step = Math.min(16, 2 ** Math.max(0, attempt - 1));
  const jitter = 1 + (random() * 2 - 1) * 0.3;
  return Math.round(step * 1000 * jitter);
}

export function createMemoryStorage() {
  const map = new Map();
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
  };
}

function fail(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

export function createUploader(options) {
  return new UploadController(options);
}

class UploadController {
  constructor(options = {}) {
    this.options = options;
    this.protocol = options.protocol || createProtocol(options);
    this.storage = options.storage || (typeof localStorage !== "undefined" ? localStorage : createMemoryStorage());
    this.random = options.random || Math.random;
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now || (() => Date.now());
    this.onStatus = options.onStatus || (() => {});
    this.kind = options.kind || "full";
    this.target = options.target || {};
    this.surface = this.target.surface || "beatbay";
    this.targetId = this.target.beat_id || this.target.product_id || "";
    this.userId = options.userId || "";
    this.phase = "idle";
    this.paused = false;
    this.offline = false;
    this.stopped = "";
    this.pauseWaiters = [];
    this.verified = new Set();
    this.countedBytes = new Set();
    this.tickets = new Map();
    this.ticketIssuedAt = new Map();
    this.wanted = [];
    this.flushing = null;
    this.peakInFlight = 0;
    this.inFlight = 0;
    this.bytesDone = 0;
    this.startedAt = 0;
    this.ckpt = -1;
    this.sessionId = "";
    this.headSha256 = "";
    this.eventsBound = false;
  }

  storageKey(source = this.source) {
    return resumeKey({
      userId: this.userId,
      surface: this.surface,
      targetId: this.targetId,
      kind: this.kind,
      name: source?.name || "",
      size: source?.size || 0,
      lastModified: source?.lastModified || 0,
    });
  }

  rememberStorage(raw) {
    const storage = storageFrom(raw);
    if (storage) this.storageUsage = storage;
  }

  emit(partial = {}) {
    const storage = partial.storage || this.storageUsage || null;
    const state = {
      name: this.source?.name || "",
      size: this.source?.size || 0,
      parts: this.plan?.totalChunks || 0,
      maxAttempts: this.maxAttempts || 5,
      ratio: 0,
      ...partial,
      phase: partial.phase || this.phase,
      storage,
    };
    state.storageLine = storageUsageLine(storage);
    if (this.storageWarning && state.phase !== "storage-full") {
      state.storageWarning = partial.storageWarning || this.storageWarning;
    }
    state.message = statusMessage(state);
    this.onStatus(state);
    return state;
  }

  bindEvents() {
    const target = this.options.events;
    if (!target?.addEventListener || this.eventsBound) return;
    this.eventsBound = true;
    const onOffline = () => {
      this.offline = true;
      this.paused = true;
      this.phase = "offline";
      this.emit({ phase: "offline" });
    };
    const onOnline = () => {
      this.offline = false;
      const resume = () => {
        this.paused = false;
        this.phase = "uploading";
        this.flushPause();
      };
      if (!this.sessionId) {
        resume();
        return;
      }
      this.protocol.status(this.sessionId).then((status) => {
        if (status.ok) this.applyStatus(status);
        else if (status.code === "SESSION_EXPIRED" || status.code === "SESSION_NOT_FOUND") {
          this.dropSession(status.code);
        }
        resume();
      }).catch(() => resume());
    };
    const onVisible = () => {
      const hidden = target.visibilityState && target.visibilityState !== "visible";
      if (hidden || !this.sessionId) return;
      this.protocol.status(this.sessionId).then((status) => {
        if (status.ok) this.applyStatus(status);
      }).catch(() => {});
    };
    const onUnload = (event) => {
      if (["uploading", "preparing", "retrying", "verifying", "compressing"].includes(this.phase)) {
        event.preventDefault();
        try { event.returnValue = "Upload in progress"; } catch { /* Events in Node expose returnValue as read-only. */ }
      }
    };
    target.addEventListener("offline", onOffline);
    target.addEventListener("online", onOnline);
    target.addEventListener("visibilitychange", onVisible);
    target.addEventListener("beforeunload", onUnload);
    this.unsub = () => {
      target.removeEventListener("offline", onOffline);
      target.removeEventListener("online", onOnline);
      target.removeEventListener("visibilitychange", onVisible);
      target.removeEventListener("beforeunload", onUnload);
    };
  }

  flushPause() {
    const waiters = this.pauseWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  async waitWhilePaused() {
    while ((this.paused || this.offline) && !this.stopped) {
      await new Promise((resolve) => this.pauseWaiters.push(resolve));
    }
  }

  pause() {
    this.paused = true;
    this.phase = this.offline ? "offline" : "paused";
    this.emit({ phase: this.phase });
  }

  resume() {
    if (this.offline) return;
    this.paused = false;
    this.phase = "uploading";
    this.flushPause();
  }

  async cancel() {
    this.stopped = "cancel";
    this.paused = false;
    this.offline = false;
    this.flushPause();
    const sessionId = this.sessionId;
    if (this.source) this.storage.removeItem(this.storageKey());
    this.phase = "cancelled";
    this.emit({ phase: "cancelled" });
    if (sessionId) await this.protocol.abort(sessionId);
  }

  suspend() {
    this.stopped = "suspend";
    this.flushPause();
  }

  dropSession(code) {
    if (this.source) this.storage.removeItem(this.storageKey());
    this.stopped = "restart";
    this.phase = "restart";
    this.emit({ phase: "restart" });
    this.flushPause();
    throw fail(code || "SESSION_EXPIRED", "This upload expired. Start again.");
  }

  readSaved(source) {
    const raw = this.storage.getItem(this.storageKey(source));
    if (!raw) return null;
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      this.storage.removeItem(this.storageKey(source));
      return null;
    }
    if (record.expires_at && Date.parse(record.expires_at) <= this.now()) return { expired: true, record };
    return { expired: false, record };
  }

  persist() {
    if (this.stopped || !this.source || !this.sessionId || !this.hashState) return;
    const record = {
      session_id: this.sessionId,
      chunk_bytes: this.plan.chunkBytes,
      total_chunks: this.plan.totalChunks,
      hash_ckpt_idx: this.ckpt,
      hash_state_b64: bytesToBase64(this.hashState),
      encoding: this.encoding || "identity",
      expires_at: this.expiresAt || "",
      head_sha256: this.headSha256,
    };
    this.storage.setItem(this.storageKey(), JSON.stringify(record));
  }

  applyStatus(status) {
    this.verified = new Set((status.verified || []).map(Number));
    if (status.limits?.chunkBytes && this.plan && status.limits.chunkBytes !== this.plan.chunkBytes) {
      throw fail("CHUNK_SIZE_MISMATCH", "The server changed the chunk size.");
    }
  }

  needs(idx) {
    return !this.verified.has(idx);
  }

  rangeFor(idx) {
    const start = idx * this.plan.chunkBytes;
    const end = Math.min(this.source.size, start + this.plan.chunkBytes);
    return { start, end };
  }

  async readRange(idx) {
    const { start, end } = this.rangeFor(idx);
    return bytesOf(await this.source.slice(start, end));
  }

  async hashSliceOnly(idx) {
    const buf = await this.readRange(idx);
    return { idx, sha256: await sha256Hex(buf), buf };
  }

  async hashSequential(idx) {
    const buf = await this.readRange(idx);
    const sha256 = await sha256Hex(buf);
    this.hasher.update(buf);
    this.hashState = this.hasher.save();
    this.ckpt = idx;
    return { idx, sha256, buf };
  }

  async restoreHasher(state) {
    this.hasher = await createIncrementalSha256();
    if (state) this.hasher.load(state);
  }

  async fileHash() {
    const state = this.hasher.save();
    const hex = this.hasher.digest();
    await this.restoreHasher(state);
    this.hashState = state;
    return hex;
  }

  async upload(source, meta = {}) {
    this.source = source;
    this.meta = meta;
    this.encoding = meta.encoding || "identity";
    this.originalBytes = meta.originalBytes ?? null;
    this.originalSha256 = meta.originalSha256 || "";
    this.stopped = "";
    this.paused = false;
    this.verified = new Set();
    this.bytesDone = 0;
    this.countedBytes = new Set();
    this.startedAt = this.now();
    this.bindEvents();
    this.phase = "analyzing";
    this.emit({ phase: "analyzing" });
    const limitsResult = meta.limits ? { ok: true, limits: normalizeLimits(meta.limits) } : await this.protocol.fetchLimits();
    if (!limitsResult.ok) throw fail(limitsResult.code || "LARGE_UPLOAD_UNSUPPORTED", limitsResult.message);
    this.limits = limitsResult.limits;
    this.rememberStorage(limitsResult.storage || limitsResult.limits);
    this.contentType = declaredContentType(source.name, { kind: this.kind, allowed: this.limits.allowed });
    if (!this.contentType) throw fail("EXT_NOT_ALLOWED", "This file has no allowed content type. Nothing was published.");
    if (!this.limits.chunkBytes) throw fail("BAD_CHUNK", "The server did not provide chunk_bytes.");
    this.maxAttempts = this.limits.maxAttempts || 5;
    this.plan = chunkPlan(source.size, this.limits.chunkBytes);
    if (!this.plan.ok) throw fail(this.plan.code || "EMPTY", "The file could not be split.");
    const saved = this.readSaved(source);
    if (saved?.expired) this.storage.removeItem(this.storageKey(source));
    const resuming = !!(saved && !saved.expired);
    if (!resuming) this.guardStorage(source.size);
    if (resuming) await this.resumeSaved(source, saved.record);
    else await this.beginFresh(source, meta);
    if (this.stopped === "suspend") return { status: "suspended", sessionId: this.sessionId };
    await this.transfer();
    if (this.stopped === "suspend") {
      this.persist();
      return { status: "suspended", sessionId: this.sessionId };
    }
    if (this.stopped === "cancel") throw fail("CANCELLED", "Upload cancelled. Nothing was published.");
    if (this.stopped === "restart") throw fail("SESSION_EXPIRED", "This upload expired. Start again.");
    this.phase = "verifying";
    this.emit({ phase: "verifying", ratio: 1 });
    const fileSha256 = await this.fileHash();
    let completed = await this.protocol.complete(this.sessionId, fileSha256);
    if (!completed.ok && completed.code === "HASH_CONFLICT") await this.abortForHashConflict();
    if (!completed.ok && completed.code === "INCOMPLETE") {
      const status = await this.protocol.status(this.sessionId);
      if (!status.ok) throw fail(status.code, status.message);
      this.applyStatus(status);
      for (const idx of completed.missing || []) this.verified.delete(Number(idx));
      await this.transfer();
      this.phase = "verifying";
      this.emit({ phase: "verifying", ratio: 1 });
      completed = await this.protocol.complete(this.sessionId, fileSha256);
    }
    if (!completed.ok && completed.code === "HASH_CONFLICT") await this.abortForHashConflict();
    if (!completed.ok) throw fail(completed.code || "REQUEST_FAILED", completed.message);
    this.phase = "verified";
    this.emit({ phase: "verified", ratio: 1 });
    this.storage.removeItem(this.storageKey(source));
    return { status: "verified", sessionId: this.sessionId, fileSha256, encoding: this.encoding };
  }

  async beginFresh(source, meta) {
    await this.restoreHasher();
    this.ckpt = -1;
    this.phase = "preparing";
    this.emit({ phase: "preparing", parts: this.plan.totalChunks, ratio: 0 });
    if (source.seekable === false && typeof source.streamChunks === "function") {
      this.stream = source.streamChunks(this.plan.chunkBytes)[Symbol.asyncIterator]();
      const first = await this.stream.next();
      if (first.done) throw fail("EMPTY", "The file is empty.");
      const buf = first.value;
      const sha256 = await sha256Hex(buf);
      this.hasher.update(buf);
      this.hashState = this.hasher.save();
      this.ckpt = 0;
      this.headSha256 = sha256;
      this.pendingFirst = { idx: 0, sha256, buf };
    } else {
      const first = await this.hashSequential(0);
      this.headSha256 = first.sha256;
      this.pendingFirst = first;
    }
    let started = await this.openSession(meta, { headSha256: this.headSha256 });
    if (started.needsUpfrontHashes) {
      const hashes = await this.collectHashes();
      this.phase = "preparing";
      this.emit({ phase: "preparing", hashMode: "upfront", ratio: 1, parts: this.plan.totalChunks });
      started = await this.openSession(meta, {
        headSha256: hashes[0],
        fileSha256: await this.fileHash(),
        chunkSha256: hashes,
        forceUpfront: true,
      });
    }
    if (!started.ok) this.raiseStartFailure(started);
    this.acceptSession(started);
    this.persist();
  }

  async collectHashes() {
    const hashes = new Array(this.plan.totalChunks);
    hashes[0] = this.headSha256;
    if (this.stream) {
      let idx = 1;
      for await (const buf of { [Symbol.asyncIterator]: () => this.stream }) {
        if (this.stopped) break;
        const sha256 = await sha256Hex(buf);
        this.hasher.update(buf);
        this.hashState = this.hasher.save();
        this.ckpt = idx;
        hashes[idx] = sha256;
        this.emit({ phase: "preparing", hashMode: "upfront", ratio: (idx + 1) / this.plan.totalChunks, parts: this.plan.totalChunks });
        idx += 1;
      }
      this.stream = null;
      this.pendingFirst = null;
      return hashes;
    }
    for (let idx = 1; idx < this.plan.totalChunks; idx += 1) {
      const item = await this.hashSequential(idx);
      hashes[idx] = item.sha256;
      item.buf = null;
      this.emit({ phase: "preparing", hashMode: "upfront", ratio: (idx + 1) / this.plan.totalChunks, parts: this.plan.totalChunks });
    }
    this.pendingFirst = null;
    return hashes;
  }

  async openSession(meta, hashes) {
    return this.protocol.start({
      filename: this.source.name,
      totalBytes: this.source.size,
      lastModified: this.source.lastModified,
      kind: this.kind,
      encoding: this.encoding,
      contentType: this.contentType,
      originalBytes: this.originalBytes,
      originalSha256: this.originalSha256,
      headSha256: hashes.headSha256,
      fileSha256: hashes.fileSha256,
      chunkSha256: hashes.chunkSha256,
      forceUpfront: hashes.forceUpfront,
    });
  }

  acceptSession(started) {
    this.sessionId = started.sessionId || started.body?.session_id;
    if (!this.sessionId) throw fail("REQUEST_FAILED", "The server did not return a session.");
    const limits = started.limits || normalizeLimits(started.body || {});
    if (limits.chunkBytes && limits.chunkBytes !== this.plan.chunkBytes) {
      throw fail("CHUNK_SIZE_MISMATCH", "The server changed the chunk size.");
    }
    if (limits.maxAttempts) this.maxAttempts = limits.maxAttempts;
    this.limits = { ...this.limits, ...limits };
    this.rememberStorage(started.storage || limits);
    const ttl = limits.sessionTtlSeconds;
    this.expiresAt = started.body?.expires_at || started.body?.expiresAt || (ttl ? new Date(this.now() + ttl * 1000).toISOString() : "");
  }

  async resumeSaved(source, record) {
    if (record.chunk_bytes) this.plan = chunkPlan(source.size, record.chunk_bytes);
    this.sessionId = record.session_id;
    this.ckpt = Number(record.hash_ckpt_idx);
    this.encoding = record.encoding || this.encoding;
    this.headSha256 = record.head_sha256 || "";
    this.expiresAt = record.expires_at || "";
    await this.restoreHasher(record.hash_state_b64 ? base64ToBytes(record.hash_state_b64) : null);
    this.hashState = record.hash_state_b64 ? base64ToBytes(record.hash_state_b64) : null;
    const head = await this.hashSliceOnly(0);
    if (!this.headSha256 || head.sha256 !== this.headSha256) {
      throw fail("HEAD_MISMATCH", `Resume ${source.name}: choose the same file again.`);
    }
    const status = await this.protocol.status(this.sessionId);
    if (!status.ok) {
      if (status.code === "SESSION_EXPIRED" || status.code === "SESSION_NOT_FOUND") this.dropSession(status.code);
      throw fail(status.code || "REQUEST_FAILED", status.message);
    }
    this.applyStatus(status);
    this.rememberStorage(status.storage || status.limits);
    this.phase = "preparing";
    this.emit({ phase: "preparing", parts: this.plan.totalChunks, ratio: this.verified.size / this.plan.totalChunks });
  }

  async transfer() {
    if (this.stream) await this.transferOpenStream();
    else await this.transferSeekable();
  }

  async transferSeekable() {
    const early = [];
    for (let idx = 0; idx <= this.ckpt; idx += 1) if (this.needs(idx)) early.push(idx);
    await this.mapPool(early, async (idx) => {
      const cached = idx === 0 ? this.pendingFirst : null;
      const item = cached && cached.sha256 ? cached : await this.hashSliceOnly(idx);
      if (idx === 0) this.pendingFirst = null;
      await this.putWithRetry(item);
    });
    if (this.stopped) return;
    await this.pipeline(async (emit) => {
      for (let idx = this.ckpt + 1; idx < this.plan.totalChunks; idx += 1) {
        if (this.stopped) return;
        await this.waitWhilePaused();
        const item = await this.hashSequential(idx);
        this.persist();
        this.emit({
          phase: "preparing",
          parts: this.plan.totalChunks,
          ratio: (idx + 1) / this.plan.totalChunks,
        });
        if (this.needs(idx)) await emit(item);
        else item.buf = null;
      }
    });
  }

  async transferOpenStream() {
    await this.pipeline(async (emit) => {
      if (this.pendingFirst && this.needs(0)) await emit(this.pendingFirst);
      this.pendingFirst = null;
      let idx = this.ckpt + 1;
      while (!this.stopped) {
        await this.waitWhilePaused();
        const next = await this.stream.next();
        if (next.done) break;
        const buf = next.value;
        const sha256 = await sha256Hex(buf);
        this.hasher.update(buf);
        this.hashState = this.hasher.save();
        this.ckpt = idx;
        this.persist();
        if (this.needs(idx)) await emit({ idx, sha256, buf });
        idx += 1;
      }
      this.stream = null;
    });
  }

  async mapPool(indexes, fn) {
    let cursor = 0;
    const width = Math.min(PARALLEL_PUTS, indexes.length);
    await Promise.all(Array.from({ length: width }, async () => {
      while (!this.stopped) {
        const current = cursor;
        cursor += 1;
        if (current >= indexes.length) return;
        await fn(indexes[current]);
      }
    }));
  }

  async pipeline(produce) {
    const queue = [];
    let producing = true;
    let failure = null;
    const waiters = [];
    const poke = () => {
      while (waiters.length) waiters.shift()();
    };
    const producer = (async () => {
      try {
        await produce(async (item) => {
          while (queue.length >= 1 && !this.stopped) await new Promise((resolve) => waiters.push(resolve));
          if (this.stopped) return;
          queue.push(item);
          poke();
        });
      } catch (error) {
        failure = error;
      } finally {
        producing = false;
        poke();
      }
    })();
    const consumers = Array.from({ length: PARALLEL_PUTS }, async () => {
      while (true) {
        while (queue.length === 0 && producing) await new Promise((resolve) => waiters.push(resolve));
        if (queue.length === 0) return;
        const item = queue.shift();
        poke();
        try {
          await this.putWithRetry(item);
          if (this.stopped === "cancel" || this.stopped === "suspend") return;
          this.options.afterVerified?.(item.idx, this);
          if (this.stopped === "cancel" || this.stopped === "suspend") return;
        } catch (error) {
          if (this.stopped === "cancel" || this.stopped === "suspend") return;
          failure = failure || error;
          this.stopped = this.stopped || "error";
          poke();
          return;
        }
      }
    });
    await Promise.all([producer, ...consumers]);
    if (failure && this.stopped !== "suspend" && this.stopped !== "cancel") throw failure;
  }

  remaining(idx) {
    const ticket = this.tickets.get(idx);
    if (!ticket) return 0;
    const issued = this.ticketIssuedAt.get(idx) || this.now();
    const age = (this.now() - issued) / 1000;
    const lifetimes = [];
    if (ticket.expiresIn != null) lifetimes.push(ticket.expiresIn);
    if (this.limits?.ticketTtlSeconds != null) lifetimes.push(this.limits.ticketTtlSeconds);
    if (!lifetimes.length) return TICKET_REFRESH_SECONDS;
    return Math.min(...lifetimes) - age;
  }

  chunkContentType(ticket) {
    const fromTicket = headerContentType(ticket?.headers);
    if (fromTicket && fromTicket !== "application/octet-stream") return fromTicket;
    return this.contentType;
  }

  async ticketFor(item, refreshed = false) {
    if (this.verified.has(item.idx)) return null;
    const cached = this.tickets.get(item.idx);
    if (cached && this.remaining(item.idx) >= TICKET_REFRESH_SECONDS) return cached;
    await this.enqueueTicket(item);
    if (this.verified.has(item.idx)) return null;
    const ticket = this.tickets.get(item.idx);
    if (!ticket) throw fail("REQUEST_FAILED", "Upload ticket was missing a signed URL.");
    if (!refreshed && this.remaining(item.idx) < TICKET_REFRESH_SECONDS) {
      this.tickets.delete(item.idx);
      return this.ticketFor(item, true);
    }
    return ticket;
  }

  enqueueTicket(part) {
    this.wanted.push(part);
    if (!this.flushing) {
      this.flushing = (async () => {
        await Promise.resolve();
        const cap = Math.min(TICKET_BATCH_CAP, this.limits?.ticketBatchCap || TICKET_BATCH_CAP);
        while (this.wanted.length) {
          const batch = this.wanted.splice(0, cap);
          const unique = [];
          const seen = new Set();
          for (const item of batch) {
            if (seen.has(item.idx)) continue;
            seen.add(item.idx);
            unique.push(item);
          }
          const issuedBatch = await this.protocol.tickets(this.sessionId, unique);
          const tickets = Array.isArray(issuedBatch) ? issuedBatch : (issuedBatch.tickets || []);
          const skipped = Array.isArray(issuedBatch) ? [] : (issuedBatch.skipped || []);
          const issued = this.now();
          for (const skip of skipped) {
            if (skip.reason === "verified") this.verified.add(Number(skip.idx));
          }
          for (const ticket of tickets) {
            this.tickets.set(ticket.idx, ticket);
            this.ticketIssuedAt.set(ticket.idx, issued);
          }
        }
        this.flushing = null;
      })();
    }
    return this.flushing;
  }

  async putWithRetry(item) {
    let attempt = 0;
    let missingRetries = 0;
    let current = item;
    while (attempt < this.maxAttempts) {
      await this.waitWhilePaused();
      if (this.stopped) return;
      if (this.verified.has(current.idx)) return;
      attempt += 1;
      try {
        const ticket = await this.ticketFor(current);
        if (!ticket) {
          if (this.verified.has(current.idx)) return;
          throw fail("REQUEST_FAILED", "Upload ticket was missing a signed URL.");
        }
        const contentType = this.chunkContentType(ticket);
        if (!contentType || contentType === "application/octet-stream") {
          throw fail("EXT_NOT_ALLOWED", "This file has no allowed content type. Nothing was published.");
        }
        if (headerContentType(ticket.headers) !== contentType) {
          ticket.headers = { ...(ticket.headers || {}), "content-type": contentType };
        }
        this.inFlight += 1;
        this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
        let put;
        try {
          put = await this.protocol.putChunk(ticket, current.buf);
        } finally {
          this.inFlight -= 1;
        }
        if (!put.ok && (put.status === 409 || put.status === 400) && /already exists/i.test(put.text || "")) {
          const done = await this.protocol.chunkDone(this.sessionId, current.idx, current.sha256, contentType);
          if (!done.ok) {
            if (await this.recoverChunkDone(done, current)) {
              if (attempt >= this.maxAttempts) throw fail(done.code, done.message);
              continue;
            }
            this.raiseProtocol(done);
          }
          this.markVerified(current);
          return;
        }
        if (!put.ok && (put.status === 408 || put.status === 429 || put.status >= 500)) {
          throw fail("RETRY", "The upload was interrupted.");
        }
        if (!put.ok) throw fail("PUT_FAILED", "Upload failed.");
        const done = await this.protocol.chunkDone(this.sessionId, current.idx, current.sha256, contentType);
        if (!done.ok) {
          if (done.code === "CHUNK_MISSING") {
            missingRetries += 1;
            if (missingRetries > this.maxAttempts) throw fail(done.code, done.message);
            this.tickets.delete(current.idx);
            attempt -= 1;
            continue;
          }
          if (done.code === "INVALID_STATE") {
            const status = await this.protocol.status(this.sessionId);
            if (!status.ok) this.raiseProtocol(status);
            this.applyStatus(status);
            if (this.verified.has(current.idx)) return;
            this.raiseProtocol(done);
          }
          if (done.code === "CHUNK_HASH_MISMATCH" || done.code === "CHUNK_SIZE_MISMATCH") {
            if (done.body?.retryable === false || done.body?.session_status === "failed") {
              throw fail(done.code, done.message || "This file failed a safety check and was not saved. Nothing was published.");
            }
            current = await this.hashSliceOnly(current.idx);
            this.phase = "retrying";
            this.emit({ phase: "retrying", part: current.idx + 1, attempt: Math.min(this.maxAttempts, attempt + 1) });
            if (attempt >= this.maxAttempts) throw fail(done.code, done.message);
            await this.sleep(backoffMs(attempt, this.random));
            continue;
          }
          if (await this.recoverChunkDone(done, current)) {
            if (attempt >= this.maxAttempts) throw fail(done.code, done.message);
            continue;
          }
          this.raiseProtocol(done);
        }
        this.markVerified(current);
        return;
      } catch (error) {
        if (this.stopped === "cancel" || this.stopped === "suspend") return;
        if (this.stopped === "restart") throw error;
        if (FAIL_CLOSED.has(error.code) || error.code === "SESSION_EXPIRED" || error.code === "SESSION_NOT_FOUND" || error.code === "HEAD_MISMATCH") throw error;
        if (attempt >= this.maxAttempts) throw error;
        this.phase = "retrying";
        this.emit({ phase: "retrying", part: current.idx + 1, attempt: Math.min(this.maxAttempts, attempt + 1) });
        await this.sleep(backoffMs(attempt, this.random));
      }
    }
  }

  guardStorage(incomingBytes) {
    const outlook = storageOutlook(this.storageUsage, incomingBytes);
    if (outlook.level === "block") {
      const message = storageFullMessage(this.storageUsage);
      this.phase = "storage-full";
      this.emit({ phase: "storage-full", detail: message });
      throw fail("STORAGE_BUDGET_EXCEEDED", message);
    }
    if (outlook.level === "warn") {
      this.storageWarning = storageWarningMessage(this.storageUsage, incomingBytes);
      this.phase = "storage-warning";
      this.emit({ phase: "storage-warning", storageWarning: this.storageWarning, detail: this.storageWarning });
    }
  }

  raiseStartFailure(result) {
    if (isStorageQuotaFailure(result)) {
      this.rememberStorage(result.storage || result.body);
      const message = storageFullMessage(this.storageUsage);
      this.phase = "storage-full";
      this.emit({ phase: "storage-full", detail: message });
      throw fail("STORAGE_BUDGET_EXCEEDED", message);
    }
    throw fail(result.code || "REQUEST_FAILED", result.message);
  }

  async recoverChunkDone(result, current) {
    if (result.code === "HASH_CONFLICT") await this.abortForHashConflict();
    if (!retryFreshTicket(result)) return false;
    this.tickets.delete(current.idx);
    this.phase = "retrying";
    this.emit({ phase: "retrying", part: current.idx + 1, attempt: Math.min(this.maxAttempts, (current.attempt || 1)) });
    await this.sleep(backoffMs(1, this.random));
    return true;
  }

  async abortForHashConflict() {
    const sessionId = this.sessionId;
    if (this.source) this.storage.removeItem(this.storageKey());
    this.stopped = "restart";
    this.phase = "failed";
    this.emit({ phase: "failed", detail: FILE_CHANGED_COPY });
    if (sessionId) {
      try { await this.protocol.abort(sessionId); } catch { /* The hash conflict is still reported. */ }
    }
    throw fail("HASH_CONFLICT", FILE_CHANGED_COPY);
  }

  raiseProtocol(result) {
    if (result.code === "HASH_CONFLICT") {
      this.stopped = "restart";
      if (this.source) this.storage.removeItem(this.storageKey());
      if (this.sessionId) this.protocol.abort(this.sessionId).catch(() => {});
      this.phase = "failed";
      this.emit({ phase: "failed", detail: FILE_CHANGED_COPY });
      throw fail("HASH_CONFLICT", FILE_CHANGED_COPY);
    }
    if (result.code === "SESSION_EXPIRED" || result.code === "SESSION_NOT_FOUND") this.dropSession(result.code);
    if (isStorageQuotaFailure(result)) this.raiseStartFailure(result);
    if (FAIL_CLOSED.has(result.code)) throw fail(result.code, "This file failed a safety check and was not saved. Nothing was published.");
    throw fail(result.code || "REQUEST_FAILED", result.message || "Upload failed.");
  }

  markVerified(item) {
    const fresh = !this.verified.has(item.idx);
    this.verified.add(item.idx);
    if (fresh && !this.countedBytes.has(item.idx)) {
      this.countedBytes.add(item.idx);
      this.bytesDone += item.buf?.byteLength || 0;
    }
    const elapsed = (this.now() - this.startedAt) / 1000;
    const rate = elapsed > 0 ? this.bytesDone / elapsed : 0;
    const left = Math.max(0, (this.source?.size || 0) - this.bytesDone);
    item.buf = null;
    this.phase = "uploading";
    this.emit({
      phase: "uploading",
      part: item.idx + 1,
      parts: this.plan.totalChunks,
      ratio: this.plan.totalChunks ? this.verified.size / this.plan.totalChunks : 0,
      etaSeconds: rate > 0 ? left / rate : undefined,
    });
  }
}
