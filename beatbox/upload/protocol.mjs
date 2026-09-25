import { normalizeLimits, storageFrom } from "./analyze.mjs";

export { storageFrom };

export const FAIL_CLOSED = new Set([
  "LIMIT_EXCEEDED",
  "EXT_NOT_ALLOWED",
  "MAGIC_MISMATCH",
  "ZIP_UNSAFE",
  "FORBIDDEN",
  "CHUNK_OUT_OF_RANGE",
]);

export const TICKET_BATCH_CAP = 16;
export const TICKET_REFRESH_SECONDS = 30;

function asCode(body) {
  if (!body || typeof body !== "object") return "";
  if (typeof body.code === "string") return body.code;
  if (body.error && typeof body.error === "object" && typeof body.error.code === "string") return body.error.code;
  if (typeof body.error === "string" && /^[A-Z0-9_]+$/.test(body.error)) return body.error;
  return "";
}

function asMessage(body, code) {
  if (!body || typeof body !== "object") return code || "Request failed";
  if (typeof body.message === "string" && body.message) return body.message;
  if (body.error && typeof body.error === "object" && typeof body.error.message === "string") return body.error.message;
  if (typeof body.error === "string" && !/^[A-Z0-9_]+$/.test(body.error)) return body.error;
  return code || "Request failed";
}

export function normalizeResponse(httpStatus, body) {
  const code = asCode(body);
  const message = asMessage(body, code);
  const ok = httpStatus >= 200 && httpStatus < 300 && !code;
  return { ok, status: httpStatus, code: code || (ok ? "" : "REQUEST_FAILED"), message, body: body || {} };
}

function hashesRequired(result) {
  if (result.code === "HASHES_REQUIRED") return true;
  const message = `${result.message || ""} ${JSON.stringify(result.body || {})}`.toLowerCase();
  return result.status === 400 && (message.includes("chunk_sha256") || message.includes("file_sha256"));
}

function batchRejected(result) {
  if (result.code === "BATCH_NOT_SUPPORTED") return true;
  const message = `${result.message || ""}`.toLowerCase();
  return result.status === 400 && (message.includes("batch") || message.includes("idx must be"));
}

export function isStorageQuotaFailure(result) {
  if (!result || result.code !== "LIMIT_EXCEEDED") return false;
  const reason = `${result.body?.reason || ""} ${result.body?.limit || ""}`.toLowerCase();
  const message = `${result.message || ""}`.toLowerCase();
  if (reason.includes("storage") || message.includes("storage")) return true;
  const storage = storageFrom(result.body);
  const incoming = Number(result.body?.total_bytes ?? result.body?.incoming_bytes);
  return !!(storage && storage.usedBytes != null && storage.quotaBytes != null && Number.isFinite(incoming) && storage.usedBytes + incoming > storage.quotaBytes);
}

function unknownGzip(result) {
  if (result.code === "UNKNOWN_FIELD") return true;
  const message = `${result.message || ""}`.toLowerCase();
  return result.status === 400 && (message.includes("encoding") || message.includes("original_bytes") || message.includes("original_sha256"));
}

function targetFields(target = {}) {
  const fields = { surface: target.surface || "beatbay" };
  if (target.beat_id) fields.beat_id = target.beat_id;
  if (target.product_id) fields.product_id = target.product_id;
  return fields;
}

function parseTicket(entry) {
  if (!entry || typeof entry !== "object") return null;
  const idx = Number(entry.idx);
  const signedUrl = entry.signed_url || entry.signedUrl || entry.url;
  if (!Number.isInteger(idx) || !signedUrl) return null;
  const headers = entry.headers && typeof entry.headers === "object" ? { ...entry.headers } : null;
  const expiresIn = Number(entry.expires_in ?? entry.expiresIn);
  return {
    idx,
    signedUrl,
    headers,
    contentType: entry.content_type || entry.contentType || headers?.["content-type"] || headers?.["Content-Type"] || "",
    expiresIn: Number.isFinite(expiresIn) ? expiresIn : null,
  };
}

function parseTicketList(body) {
  const raw = Array.isArray(body) ? body : body?.tickets || body?.urls || body?.chunks || null;
  if (Array.isArray(raw)) return raw.map(parseTicket).filter(Boolean);
  const one = parseTicket(body);
  return one ? [one] : [];
}

export function createProtocol({ endpoint, getToken, apikey, target, kind, fetchImpl }) {
  const state = {
    hashMode: "deferred",
    batch: true,
    stripGzip: false,
    notes: [],
  };
  const fetchFn = fetchImpl || globalThis.fetch;

  async function call(action, fields) {
    const token = typeof getToken === "function" ? getToken() : "";
    const response = await fetchFn(endpoint, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        apikey: apikey || "",
        "content-type": "application/json",
      },
      body: JSON.stringify({ action, ...fields }),
    });
    const body = await response.json().catch(() => ({}));
    return normalizeResponse(response.status, body);
  }

  function note(text) {
    if (!state.notes.includes(text)) state.notes.push(text);
  }

  function clientStart(input, { gzip }) {
    return {
      ...targetFields(target),
      kind: input.kind || kind,
      filename: input.filename,
      total_bytes: input.totalBytes,
      last_modified: input.lastModified,
      head_sha256: input.headSha256,
      ...(gzip && input.encoding ? { encoding: input.encoding } : {}),
      ...(gzip && input.originalBytes != null ? { original_bytes: input.originalBytes } : {}),
      ...(gzip && input.originalSha256 ? { original_sha256: input.originalSha256 } : {}),
    };
  }

  function bobStart(input) {
    return {
      ...targetFields(target),
      kind: input.kind || kind,
      filename: input.filename,
      total_bytes: input.totalBytes,
      file_sha256: input.fileSha256,
      chunk_sha256: input.chunkSha256,
    };
  }

  return {
    get hashMode() {
      return state.hashMode;
    },
    get notes() {
      return state.notes.slice();
    },
    async fetchLimits() {
      let result = await call("upload_status", { dry_run: true });
      if (!(result.ok && (result.body.chunk_bytes != null || result.body.chunkBytes != null))) {
        result = await call("start_upload", { dry_run: true, total_bytes: 0, filename: "limits.bin", kind: kind || "full", ...targetFields(target) });
      }
      if (result.status === 404 || result.code === "UNKNOWN_ACTION") {
        return { ok: false, code: "LARGE_UPLOAD_UNSUPPORTED", message: "Large upload is not available.", limits: null };
      }
      if (!result.ok) return { ...result, limits: null, storage: storageFrom(result.body) };
      return { ok: true, code: "", message: "", limits: normalizeLimits(result.body), storage: storageFrom(result.body), body: result.body };
    },
    async start(input) {
      if (state.hashMode === "upfront" || input.forceUpfront) {
        if (!input.fileSha256 || !Array.isArray(input.chunkSha256)) {
          return { ok: false, code: "HASHES_REQUIRED", message: "HASHES_REQUIRED", needsUpfrontHashes: true };
        }
        const result = await call("start_upload", bobStart(input));
        if (!result.ok) return result;
        note("start_upload uses BoB upfront file_sha256 and chunk_sha256[]");
        return { ...result, sessionId: result.body.session_id, limits: normalizeLimits(result.body), storage: storageFrom(result.body), hashMode: "upfront" };
      }
      let fields = clientStart(input, { gzip: !state.stripGzip });
      let result = await call("start_upload", fields);
      if (!result.ok && !state.stripGzip && unknownGzip(result)) {
        state.stripGzip = true;
        note("server rejected gzip session fields; retrying without encoding/original_bytes/original_sha256");
        fields = clientStart(input, { gzip: false });
        result = await call("start_upload", fields);
      }
      if (!result.ok && hashesRequired(result)) {
        state.hashMode = "upfront";
        note("server requires chunk_sha256[] up front; switching to two-pass hashing");
        return { ok: false, code: "HASHES_REQUIRED", message: result.message, needsUpfrontHashes: true };
      }
      if (!result.ok) return result;
      note("start_upload uses deferred head_sha256");
      return { ...result, sessionId: result.body.session_id, limits: normalizeLimits(result.body), storage: storageFrom(result.body), hashMode: "deferred" };
    },
    async tickets(sessionId, parts) {
      const list = parts.filter((part) => Number.isInteger(part.idx));
      const cap = TICKET_BATCH_CAP;
      const out = [];
      for (let offset = 0; offset < list.length; offset += cap) {
        const batch = list.slice(offset, offset + cap);
        const grouped = await requestBatch(batch);
        out.push(...grouped);
      }
      return out;

      async function requestBatch(batch) {
        if (!state.batch || batch.length === 1 && state.batch === "single-only") {
          return requestEach(batch);
        }
        const fields = {
          session_id: sessionId,
          idx: batch.map((part) => part.idx),
        };
        if (state.hashMode !== "upfront") fields.sha256 = batch.map((part) => part.sha256);
        let result = await call("chunk_ticket", fields);
        if (!result.ok && batchRejected(result)) {
          state.batch = false;
          note("chunk_ticket batch was rejected; falling back to one idx per call");
          return requestEach(batch);
        }
        if (!result.ok && state.hashMode !== "upfront" && hashesRequired(result)) {
          state.hashMode = "upfront";
          note("chunk_ticket rejected per-chunk sha256");
          return requestEach(batch);
        }
        if (!result.ok) {
          const error = new Error(result.message || result.code || "Ticket failed");
          error.code = result.code || "REQUEST_FAILED";
          error.result = result;
          throw error;
        }
        const tickets = parseTicketList(result.body);
        if (!tickets.length) {
          const error = new Error("Upload ticket was missing a signed URL.");
          error.code = "REQUEST_FAILED";
          throw error;
        }
        return tickets.map(markHeaders);
      }

      async function requestEach(batch) {
        const tickets = [];
        for (const part of batch) {
          const fields = { session_id: sessionId, idx: part.idx };
          if (state.hashMode !== "upfront" && part.sha256) fields.sha256 = part.sha256;
          const result = await call("chunk_ticket", fields);
          if (!result.ok) {
            const error = new Error(result.message || result.code || "Ticket failed");
            error.code = result.code || "REQUEST_FAILED";
            error.result = result;
            throw error;
          }
          const ticket = parseTicketList(result.body)[0];
          if (!ticket) throw Object.assign(new Error("Upload ticket was missing a signed URL."), { code: "REQUEST_FAILED" });
          tickets.push(markHeaders(ticket));
        }
        return tickets;
      }

      function markHeaders(ticket) {
        if (!ticket.headers) {
          note("ticket omitted headers; using application/octet-stream");
          ticket.headers = { "content-type": ticket.contentType || "application/octet-stream" };
        }
        return ticket;
      }
    },
    async chunkDone(sessionId, idx) {
      return call("chunk_done", { session_id: sessionId, idx });
    },
    async status(sessionId) {
      const result = await call("upload_status", { session_id: sessionId });
      if (!result.ok) return result;
      const body = result.body || {};
      return {
        ...result,
        limits: normalizeLimits(body),
        storage: storageFrom(body),
        missing: body.missing_idx || body.missing || [],
        bad: body.bad_idx || body.bad || [],
        verified: body.verified_idx || body.verified || [],
        sessionStatus: body.status || "",
        expiresAt: body.expires_at || body.expiresAt || "",
      };
    },
    async complete(sessionId, fileSha256) {
      let result = await call("complete_upload", { session_id: sessionId, file_sha256: fileSha256 });
      if (!result.ok && unknownGzip(result)) {
        note("complete_upload rejected file_sha256; retrying without it");
        result = await call("complete_upload", { session_id: sessionId });
      }
      if (!result.ok && result.code === "INCOMPLETE") {
        return {
          ...result,
          missing: result.body.missing_idx || result.body.missing || [],
        };
      }
      return result;
    },
    async abort(sessionId) {
      return call("abort_upload", { session_id: sessionId });
    },
    async attach(input) {
      const surface = target?.surface || "beatbay";
      if (surface === "release") {
        return call(input.action || "attach_asset", {
          product_id: target.product_id,
          kind: input.kind || kind,
          session_id: input.sessionId,
          path: input.path,
          delivery_filename: input.filename,
        });
      }
      if (input.studio) {
        return call("beatbay_attach_asset", {
          beat_id: target.beat_id,
          kind: input.kind || kind,
          session_id: input.sessionId,
          duration_seconds: input.durationSeconds ?? null,
          surface,
        });
      }
      return call("attach_asset", {
        intake: "beatbox",
        id: target.beat_id,
        kind: input.kind || kind,
        session_id: input.sessionId,
        duration_seconds: input.durationSeconds ?? null,
      });
    },
    async putChunk(ticket, bytes) {
      const headers = { ...(ticket.headers || {}) };
      if (!headers["content-type"] && !headers["Content-Type"]) {
        headers["content-type"] = "application/octet-stream";
        note("PUT used application/octet-stream because the ticket had no content-type");
      }
      const response = await fetchFn(ticket.signedUrl, { method: "PUT", headers, body: bytes });
      const text = await response.text().catch(() => "");
      return { ok: response.ok, status: response.status, text };
    },
  };
}
