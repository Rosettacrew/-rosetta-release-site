import { executableMagic } from "../package-rules.mjs";

export const HEAD_BYTES = 64 * 1024;
export const TRIAL_SAMPLE_BYTES = 1024 * 1024;
export const COMPRESS_MIN_SAVING_FALLBACK = 0.10;

const NEVER_RECOMPRESS = new Set([
  "zip", "mp3", "mp4", "m4a", "aac", "flac", "jpg", "jpeg", "png", "mov", "ogg", "opus", "webp",
]);
const COMPRESSIBLE = new Set(["wav", "aiff", "aif"]);

const MAGIC_EXTENSIONS = {
  zip: ["zip"],
  wav: ["wav"],
  webp: ["webp"],
  aiff: ["aiff", "aif"],
  flac: ["flac"],
  ogg: ["ogg", "opus"],
  mp4: ["mp4", "m4a", "mov", "aac"],
  aac: ["aac"],
  jpg: ["jpg", "jpeg"],
  png: ["png"],
  mp3: ["mp3"],
};

export function extensionOf(name) {
  const base = String(name || "").split(/[/\\]/).pop() || "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

function ascii(bytes, start, length) {
  let text = "";
  const end = Math.min(bytes.length, start + length);
  for (let index = start; index < end; index += 1) text += String.fromCharCode(bytes[index]);
  return text;
}

export function detectMagic(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || []);
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05) && (bytes[3] === 0x04 || bytes[3] === 0x06)) return "zip";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return "wav";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "webp";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "FORM" && (ascii(bytes, 8, 4) === "AIFF" || ascii(bytes, 8, 4) === "AIFC")) return "aiff";
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === "fLaC") return "flac";
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === "OggS") return "ogg";
  if (bytes.length >= 8 && ascii(bytes, 4, 4) === "ftyp") return "mp4";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "png";
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return "mp3";
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    const layer = (bytes[1] >> 1) & 0x03;
    return layer === 0 ? "aac" : "mp3";
  }
  return "";
}

export function magicMatchesExtension(ext, magic) {
  if (!ext || !magic) return false;
  if ((MAGIC_EXTENSIONS[magic] || []).includes(ext)) return true;
  if (ext === "aac" && (magic === "aac" || magic === "mp4")) return true;
  return false;
}

export function kindForExtension(ext) {
  if (ext === "zip") return "zip";
  if (ext === "mp4" || ext === "mov") return "video";
  if (ext === "jpg" || ext === "jpeg" || ext === "png" || ext === "webp") return "cover";
  if (COMPRESSIBLE.has(ext) || ["mp3", "flac", "m4a", "aac", "ogg", "opus"].includes(ext)) return "full";
  return "";
}

export function numberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeLimits(raw) {
  const source = raw || {};
  return {
    chunkBytes: numberOrNull(source.chunkBytes ?? source.chunk_bytes),
    singleObjectThreshold: numberOrNull(source.singleObjectThreshold ?? source.single_object_threshold),
    maxFileBytes: numberOrNull(source.maxFileBytes ?? source.max_file_bytes),
    previewMaxBytes: numberOrNull(source.previewMaxBytes ?? source.preview_max_bytes),
    compressMinSaving: numberOrNull(source.compressMinSaving ?? source.compress_min_saving),
    compressMaxBytes: numberOrNull(source.compressMaxBytes ?? source.compress_max_bytes),
    sessionTtlSeconds: numberOrNull(source.sessionTtlSeconds ?? source.session_ttl_seconds ?? source.ttl_seconds),
    maxAttempts: numberOrNull(source.maxAttempts ?? source.max_attempts),
    ticketBatchCap: numberOrNull(source.ticketBatchCap ?? source.ticket_batch_cap),
    storageUsedBytes: numberOrNull(source.storageUsedBytes ?? source.storage_used_bytes),
    storageQuotaBytes: numberOrNull(source.storageQuotaBytes ?? source.storage_quota_bytes),
    allowedExt: source.allowedExt || source.allowed_ext || null,
  };
}

export function storageFrom(raw) {
  const source = raw || {};
  const used = numberOrNull(source.usedBytes ?? source.storageUsedBytes ?? source.storage_used_bytes);
  const quota = numberOrNull(source.quotaBytes ?? source.storageQuotaBytes ?? source.storage_quota_bytes);
  if (used == null && quota == null) return null;
  return { usedBytes: used, quotaBytes: quota };
}

export function choosePath({ size, isBeatboxZip = false, limits }) {
  const cap = normalizeLimits(limits);
  if (cap.singleObjectThreshold == null) return { path: "needs-limits" };
  if (!Number.isFinite(size) || size <= 0) return { path: "reject", code: "EMPTY" };
  if (cap.maxFileBytes != null && size > cap.maxFileBytes) return { path: "reject", code: "LIMIT_EXCEEDED" };
  if (size <= cap.singleObjectThreshold) return { path: "single", isBeatboxZip: !!isBeatboxZip };
  return { path: "chunked" };
}

export function chunkPlan(totalBytes, chunkBytes) {
  const total = Number(totalBytes);
  const chunk = Number(chunkBytes);
  if (!Number.isFinite(total) || total <= 0) return { ok: false, code: "EMPTY" };
  if (!Number.isFinite(chunk) || chunk <= 0) return { ok: false, code: "BAD_CHUNK" };
  const totalChunks = Math.ceil(total / chunk);
  return {
    ok: true,
    totalBytes: total,
    chunkBytes: chunk,
    totalChunks,
    lastBytes: total - (totalChunks - 1) * chunk,
  };
}

export function middleSampleRange(size, sampleBytes = TRIAL_SAMPLE_BYTES) {
  const total = Number(size) || 0;
  const sample = Math.max(1, Number(sampleBytes) || TRIAL_SAMPLE_BYTES);
  if (total <= sample) return { start: 0, end: total };
  const start = Math.floor((total - sample) / 2);
  return { start, end: start + sample };
}

export function classify({ name, size, head, limits }) {
  const ext = extensionOf(name);
  const bytes = head instanceof Uint8Array ? head : new Uint8Array(head || []);
  const executable = executableMagic(bytes);
  if (!Number.isFinite(Number(size)) || Number(size) <= 0) {
    return { ok: false, ext, magic: "", kind: "", compressible: false, path: "reject", code: "EMPTY", error: "The file is empty." };
  }
  if (executable) {
    return {
      ok: false,
      ext,
      magic: executable,
      kind: kindForExtension(ext),
      compressible: false,
      path: "reject",
      code: "MAGIC_MISMATCH",
      error: `Rejected: file content looks like an executable (${executable}).`,
    };
  }
  const magic = detectMagic(bytes);
  if (!magicMatchesExtension(ext, magic)) {
    return {
      ok: false,
      ext,
      magic,
      kind: kindForExtension(ext),
      compressible: false,
      path: "reject",
      code: "MAGIC_MISMATCH",
      error: "This file failed a safety check and was not saved. Nothing was published.",
    };
  }
  const compressible = COMPRESSIBLE.has(ext);
  const reason = NEVER_RECOMPRESS.has(ext) ? "already-compressed" : (compressible ? "" : "not-pcm");
  const pathChoice = limits ? choosePath({ size: Number(size), isBeatboxZip: ext === "zip", limits }) : { path: "pending" };
  const allowed = normalizeLimits(limits).allowedExt;
  if (allowed && pathChoice.path !== "reject") {
    const list = Array.isArray(allowed) ? allowed : allowed[kindForExtension(ext)] || allowed["*"] || null;
    if (Array.isArray(list) && list.length && !list.map((item) => String(item).toLowerCase()).includes(ext)) {
      return {
        ok: false,
        ext,
        magic,
        kind: kindForExtension(ext),
        compressible: false,
        path: "reject",
        code: "EXT_NOT_ALLOWED",
        error: "This file failed a safety check and was not saved. Nothing was published.",
      };
    }
  }
  return {
    ok: pathChoice.path !== "reject",
    ext,
    magic,
    kind: kindForExtension(ext),
    compressible,
    reason,
    path: pathChoice.path,
    code: pathChoice.code || "",
    error: pathChoice.path === "reject" ? "This file failed a safety check and was not saved. Nothing was published." : "",
  };
}

export function compressionAllowed(ext) {
  return COMPRESSIBLE.has(String(ext || "").toLowerCase()) && !NEVER_RECOMPRESS.has(String(ext || "").toLowerCase());
}
