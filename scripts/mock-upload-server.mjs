import { createHash } from "node:crypto";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(code, status = 400, extra = {}) {
  return { status, body: { error: code, code, message: extra.message || code, ...extra } };
}

function ok(body) {
  return { status: 200, body };
}

async function asBytes(body) {
  if (body == null) return new Uint8Array();
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (typeof body.arrayBuffer === "function") return new Uint8Array(await body.arrayBuffer());
  throw new Error("Unsupported upload body");
}

export function createMockUploadServer(options = {}) {
  const limits = {
    chunk_bytes: options.chunkBytes ?? 64 * 1024,
    single_object_threshold: options.singleObjectThreshold ?? 45 * 1024 * 1024,
    max_file_bytes: options.maxFileBytes ?? 900 * 1024 * 1024,
    preview_max_bytes: options.previewMaxBytes ?? 10 * 1024 * 1024,
    compress_min_saving: options.compressMinSaving ?? 0.1,
    compress_max_bytes: options.compressMaxBytes ?? 512 * 1024 * 1024,
    session_ttl_seconds: options.sessionTtlSeconds ?? 24 * 60 * 60,
    max_attempts: options.maxAttempts ?? 5,
    ticket_batch_cap: options.ticketBatchCap ?? options.ticketBatchMax ?? 16,
    ticket_batch_max: options.ticketBatchMax ?? options.ticketBatchCap ?? 16,
    min_chunk_bytes: options.minChunkBytes ?? 1024 * 1024,
    max_total_upload_bytes: options.storageQuotaBytes === undefined ? 960 * 1024 * 1024 : options.storageQuotaBytes,
  };
  const storageQuotaBytes = limits.max_total_upload_bytes;
  const state = {
    hashMode: options.hashMode || "deferred",
    batchSupported: options.batchSupported !== false,
    rejectGzipFields: !!options.rejectGzipFields,
    rejectCompleteHash: !!options.rejectCompleteHash,
    discardBodies: !!options.discardBodies,
    sessions: new Map(),
    objects: new Map(),
    requests: [],
    puts: [],
    putHeaders: [],
    corruptOnce: new Set(options.corruptOnce || []),
    conflictOnce: new Set(options.conflictOnce || []),
    failPutOnce: new Set(options.failPutOnce || []),
    incompleteOnce: !!options.incompleteOnce,
    expireAfterPuts: options.expireAfterPuts ?? null,
    ticketTtl: options.ticketTtl ?? 120,
    shortTicketOnce: !!options.shortTicketOnce,
    putDelayMs: options.putDelayMs ?? 0,
    activePuts: 0,
    peakPuts: 0,
    putCount: 0,
    storageUsedBytes: options.storageUsedBytes ?? 0,
    storageQuotaBytes,
    reservedBytes: options.reservedBytes ?? 0,
  };

  function mimeFor(filename = "") {
    const ext = String(filename).toLowerCase().split(".").pop();
    if (ext === "wav" || ext === "wave") return "audio/wav";
    if (ext === "mp3") return "audio/mpeg";
    if (ext === "zip") return "application/zip";
    if (ext === "mp4") return "video/mp4";
    return "application/octet-stream";
  }

  function sessionOrFail(id) {
    const session = state.sessions.get(id);
    if (!session) return { error: fail("SESSION_NOT_FOUND", 404) };
    if (session.status === "expired" || session.status === "aborted") return { error: fail("SESSION_EXPIRED", 410) };
    if (session.expiresAt <= Date.now()) {
      session.status = "expired";
      return { error: fail("SESSION_EXPIRED", 410) };
    }
    return { session };
  }

  function missingOf(session) {
    const missing = [];
    const bad = [];
    const verified = [];
    for (let idx = 0; idx < session.chunkCount; idx += 1) {
      const row = session.chunks[idx];
      if (row.status === "verified") verified.push(idx);
      else if (row.status === "bad") bad.push(idx);
      else missing.push(idx);
    }
    return { missing, bad, verified };
  }

  function storageSnapshot() {
    if (state.storageQuotaBytes == null) return {};
    const used = state.storageUsedBytes ?? 0;
    const reserved = state.reservedBytes ?? 0;
    const quota = state.storageQuotaBytes;
    return {
      storage_used_bytes: used,
      storage_quota_bytes: quota,
      storage: {
        used_bytes: used,
        reserved_bytes: reserved,
        max_total_upload_bytes: quota,
        remaining_bytes: Math.max(0, quota - used - reserved),
        scope: "project",
      },
    };
  }

  function protocolLimits() {
    return {
      chunk_bytes: limits.chunk_bytes,
      min_chunk_bytes: limits.min_chunk_bytes,
      single_object_threshold: limits.single_object_threshold,
      max_file_bytes: limits.max_file_bytes,
      max_total_upload_bytes: state.storageQuotaBytes,
      session_ttl_seconds: limits.session_ttl_seconds,
      max_attempts: limits.max_attempts,
      ticket_ttl_seconds: state.ticketTtl,
      ticket_batch_max: limits.ticket_batch_max,
      max_open_sessions_per_user: 3,
      preview_max_bytes: limits.preview_max_bytes,
      compress_min_saving: limits.compress_min_saving,
      compress_max_bytes: limits.compress_max_bytes,
      compressible_exts: ["wav"],
      zip_max_entries: 2000,
      allowed: { full: ["wav", "mp3"], stems: ["zip"], video: ["mp4"], zip: ["zip"] },
    };
  }

  function limitBody(extra = {}) {
    return {
      protocol: 1,
      limits: protocolLimits(),
      hash_mode: state.hashMode,
      ...storageSnapshot(),
      ...extra,
    };
  }

  async function handle(message, headers = {}) {
    const action = message.action;
    state.requests.push({ action, body: message, authorization: headers.Authorization || headers.authorization || "" });
    if (action === "upload_status" && message.dry_run) return ok(limitBody());
    if (action === "start_upload" && message.dry_run) return ok(limitBody({ dry_run: true }));
    if (action === "start_upload") return startUpload(message);
    if (action === "chunk_ticket") return chunkTicket(message);
    if (action === "chunk_done") return chunkDone(message);
    if (action === "upload_status") return uploadStatus(message);
    if (action === "complete_upload") return completeUpload(message);
    if (action === "abort_upload") return abortUpload(message);
    if (action === "attach_asset" || action === "beatbay_attach_asset") return attach(message);
    return fail("UNKNOWN_ACTION", 404);
  }

  function startUpload(message) {
    if (state.rejectGzipFields && (message.encoding || message.original_bytes != null || message.original_sha256)) {
      return fail("UNKNOWN_FIELD", 400, { message: "unknown field encoding" });
    }
    const upfront = state.hashMode === "upfront";
    if (upfront && (!message.file_sha256 || !Array.isArray(message.chunk_sha256))) {
      return fail("HASHES_REQUIRED", 400, { message: "file_sha256 and chunk_sha256 are required" });
    }
    if (!upfront && !message.head_sha256 && !message.dry_run) {
      return fail("HEAD_REQUIRED", 400, { message: "head_sha256 is required" });
    }
    const total = Number(message.total_bytes);
    if (!Number.isFinite(total) || total <= 0) return fail("EMPTY", 400);
    const reserved = state.reservedBytes ?? 0;
    if (state.storageQuotaBytes != null && state.storageUsedBytes + reserved + total > state.storageQuotaBytes) {
      return fail("STORAGE_BUDGET_EXCEEDED", 507, {
        message: "Project storage is full",
        total_bytes: total,
        storage: {
          used_bytes: state.storageUsedBytes,
          reserved_bytes: reserved,
          max_total_upload_bytes: state.storageQuotaBytes,
          remaining_bytes: Math.max(0, state.storageQuotaBytes - state.storageUsedBytes - reserved),
          scope: "project",
        },
        storage_used_bytes: state.storageUsedBytes,
        storage_quota_bytes: state.storageQuotaBytes,
      });
    }
    if (total > limits.max_file_bytes) return fail("LIMIT_EXCEEDED", 413, { limit: "max_file_bytes", max: limits.max_file_bytes });
    const chunkBytes = limits.chunk_bytes;
    const chunkCount = Math.ceil(total / chunkBytes);
    if (upfront && message.chunk_sha256.length !== chunkCount) return fail("CHUNK_SIZE_MISMATCH", 400);
    const id = message.session_id || `sess-${state.sessions.size + 1}`;
    const existing = [...state.sessions.values()].find((session) => {
      if (session.status === "aborted" || session.status === "expired") return false;
      if (upfront) return session.fileSha256 && session.fileSha256 === message.file_sha256 && session.total === total;
      return session.headSha256 === message.head_sha256 && session.total === total && session.kind === (message.kind || "full");
    });
    if (existing) return ok({ session_id: existing.id, ...limitBody(), chunk_count: existing.chunkCount, expires_at: new Date(existing.expiresAt).toISOString() });
    const session = {
      id,
      filename: message.filename,
      kind: message.kind || "full",
      total,
      chunkBytes,
      chunkCount,
      headSha256: message.head_sha256 || "",
      fileSha256: message.file_sha256 || "",
      chunkSha256: message.chunk_sha256 || [],
      encoding: message.encoding || "identity",
      originalBytes: message.original_bytes ?? null,
      originalSha256: message.original_sha256 || "",
      status: "open",
      expiresAt: Date.now() + limits.session_ttl_seconds * 1000,
      chunks: Array.from({ length: chunkCount }, () => ({ status: "missing", sha256: "", bytes: 0, attempts: 0 })),
      tickets: new Map(),
      attached: false,
    };
    state.sessions.set(id, session);
    return ok({
      session_id: id,
      ...limitBody(),
      chunk_count: chunkCount,
      expires_at: new Date(session.expiresAt).toISOString(),
    });
  }

  function chunkTicket(message) {
    const found = sessionOrFail(message.session_id);
    if (found.error) return found.error;
    const session = found.session;
    const indexes = Array.isArray(message.idx) ? message.idx : [message.idx];
    if (!state.batchSupported && Array.isArray(message.idx)) return fail("BATCH_NOT_SUPPORTED", 400, { message: "idx must be a number" });
    if (indexes.length > limits.ticket_batch_max) return fail("LIMIT_EXCEEDED", 400, { limit: "ticket_batch_max", max: limits.ticket_batch_max });
    const hashes = Array.isArray(message.sha256) ? message.sha256 : (message.sha256 ? [message.sha256] : []);
    const tickets = [];
    const skipped = [];
    for (let position = 0; position < indexes.length; position += 1) {
      const idx = Number(indexes[position]);
      if (!Number.isInteger(idx) || idx < 0 || idx >= session.chunkCount) return fail("CHUNK_OUT_OF_RANGE", 400);
      const row = session.chunks[idx];
      if (row.status === "verified") {
        skipped.push({ idx, reason: "verified" });
        continue;
      }
      let ttl = state.ticketTtl;
      if (state.shortTicketOnce) {
        ttl = 10;
        state.shortTicketOnce = false;
      }
      const sha = hashes[position] || session.chunkSha256[idx] || "";
      if (state.hashMode === "deferred" && !sha) return fail("HASHES_REQUIRED", 400, { message: "sha256 is required" });
      session.tickets.set(idx, { sha256: sha, expiresAt: Date.now() + ttl * 1000 });
      const bytes = idx === session.chunkCount - 1 ? session.total - idx * session.chunkBytes : session.chunkBytes;
      tickets.push({
        idx,
        method: "PUT",
        bucket: "release-private",
        path: `uploads/${session.id}/${idx}.part`,
        signed_url: `https://upload.mock.local/object/${session.id}/${idx}`,
        headers: { "content-type": mimeFor(session.filename), "x-upsert": "false" },
        bytes,
        sha256: sha || null,
        expires_in: ttl,
      });
    }
    return ok({ session_id: session.id, tickets, skipped });
  }

  function chunkDone(message) {
    const found = sessionOrFail(message.session_id);
    if (found.error) return found.error;
    const session = found.session;
    const idx = Number(message.idx);
    if (!Number.isInteger(idx) || idx < 0 || idx >= session.chunkCount) return fail("CHUNK_OUT_OF_RANGE", 400);
    const row = session.chunks[idx];
    if (row.status === "verified") return ok({ session_id: session.id, idx, status: "verified", duplicate: true, noop: true });
    const stored = state.objects.get(`${session.id}:${idx}`);
    if (!stored) return fail("CHUNK_MISSING", 409, { message: "Chunk object is missing." });
    const expected = session.tickets.get(idx)?.sha256 || session.chunkSha256[idx] || "";
    const actual = stored.sha256;
    const expectedBytes = idx === session.chunkCount - 1 ? session.total - idx * session.chunkBytes : session.chunkBytes;
    row.attempts += 1;
    if (stored.bytes !== expectedBytes) {
      row.status = "bad";
      state.objects.delete(`${session.id}:${idx}`);
      return fail("CHUNK_SIZE_MISMATCH", 400);
    }
    if (expected && actual !== expected) {
      row.status = "bad";
      state.objects.delete(`${session.id}:${idx}`);
      return fail("CHUNK_HASH_MISMATCH", 400);
    }
    row.status = "verified";
    row.sha256 = actual;
    row.bytes = stored.bytes;
    return ok({ status: "verified", idx });
  }

  function uploadStatus(message) {
    const found = sessionOrFail(message.session_id);
    if (found.error) return found.error;
    const lists = missingOf(found.session);
    return ok({
      ...limitBody(),
      session_id: found.session.id,
      status: found.session.status,
      chunk_count: found.session.chunkCount,
      missing: lists.missing,
      bad: lists.bad,
      verified_count: lists.verified.length,
      expires_at: new Date(found.session.expiresAt).toISOString(),
    });
  }

  function completeUpload(message) {
    if (state.rejectCompleteHash && message.file_sha256) return fail("UNKNOWN_FIELD", 400, { message: "unknown field file_sha256" });
    const found = sessionOrFail(message.session_id);
    if (found.error) return found.error;
    const session = found.session;
    const lists = missingOf(session);
    if (state.incompleteOnce) {
      state.incompleteOnce = false;
      const idx = lists.verified[0] ?? 0;
      session.chunks[idx].status = "bad";
      return fail("INCOMPLETE", 409, { missing: [idx], bad: [] });
    }
    if (lists.missing.length || lists.bad.length) {
      return fail("INCOMPLETE", 409, { missing: lists.missing, bad: lists.bad });
    }
    if (message.file_sha256) session.fileSha256 = message.file_sha256;
    session.status = "verified";
    return ok({ status: "verified", session_id: session.id, file_sha256: session.fileSha256 });
  }

  function abortUpload(message) {
    const found = sessionOrFail(message.session_id);
    if (found.error && found.error.body.code === "SESSION_NOT_FOUND") return found.error;
    if (found.session) {
      found.session.status = "aborted";
      for (const key of [...state.objects.keys()]) {
        if (key.startsWith(`${found.session.id}:`)) state.objects.delete(key);
      }
    }
    return ok({ status: "aborted" });
  }

  function attach(message) {
    const found = sessionOrFail(message.session_id);
    if (found.error) return found.error;
    if (found.session.status !== "verified") return fail("INCOMPLETE", 409);
    found.session.attached = true;
    found.session.status = "attached";
    return ok({ attached: true, storefront_enabled: false, status: "draft" });
  }

  async function handlePut(url, body, headers = {}) {
    const match = /\/object\/([^/]+)\/(\d+)/.exec(String(url));
    if (!match) return new Response("missing", { status: 404 });
    const session = state.sessions.get(match[1]);
    const idx = Number(match[2]);
    if (!session) return new Response("SESSION_NOT_FOUND", { status: 404 });
    state.activePuts += 1;
    state.peakPuts = Math.max(state.peakPuts, state.activePuts);
    if (state.putDelayMs) await new Promise((resolve) => setTimeout(resolve, state.putDelayMs));
    let bytes = await asBytes(body);
    state.activePuts -= 1;
    state.putCount += 1;
    state.puts.push(idx);
    state.putHeaders.push(headers);
    if (state.expireAfterPuts != null && state.putCount >= state.expireAfterPuts) session.status = "expired";
    if (state.failPutOnce.has(idx)) {
      state.failPutOnce.delete(idx);
      return new Response("unavailable", { status: 503 });
    }
    if (state.corruptOnce.has(idx)) {
      state.corruptOnce.delete(idx);
      bytes = new Uint8Array(bytes);
      bytes[0] = bytes[0] ^ 0xff;
    }
    const record = { sha256: sha256(bytes), bytes: bytes.byteLength, body: state.discardBodies ? null : bytes };
    state.objects.set(`${session.id}:${idx}`, record);
    if (state.conflictOnce.has(idx)) {
      state.conflictOnce.delete(idx);
      return new Response("already exists", { status: 409 });
    }
    return new Response("ok", { status: 200 });
  }

  async function fetchImpl(url, init = {}) {
    if (String(url).includes("/object/")) return handlePut(url, init.body, init.headers || {});
    const message = JSON.parse(init.body || "{}");
    const result = await handle(message, init.headers || {});
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "content-type": "application/json" },
    });
  }

  return { handle, fetchImpl, state, limits };
}
