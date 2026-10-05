/** Shared Beatbox guards. No secrets. Used by the Edge function, the admin page, and node checks. */

export const QUARANTINE_UPLOAD_TTL_SECONDS = 120;
export const PRIVATE_DOWNLOAD_TTL_SECONDS = 300;
export const SANDBOX_PREFIX = "beatbox-sandbox";
export const MAX_AUDIO_BYTES = 80 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isPublicApiCredential(token, apiKey) {
  const value = String(token ?? "").trim();
  const key = String(apiKey ?? "").trim();
  if (!value) return true;
  if (key && value === key) return true;
  if (/^sb_(?:publishable|secret|anon)_/i.test(value)) return true;
  return false;
}

export function isUuid(value) {
  return UUID.test(String(value ?? "").trim());
}

export function sandboxedExtractPath(canonicalPath) {
  const path = String(canonicalPath ?? "");
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..") || path.split("/").includes("")) return null;
  if (path.startsWith(`${SANDBOX_PREFIX}/`) || path === SANDBOX_PREFIX) return null;
  return `${SANDBOX_PREFIX}/${path}`;
}

export function isQuarantinePath(beatId, path, ext) {
  const id = String(beatId ?? "");
  const objectPath = String(path ?? "");
  const extension = String(ext ?? "").toLowerCase();
  if (!isUuid(id) || !["mp3", "wav"].includes(extension)) return false;
  if (objectPath.includes("..") || objectPath.includes("\\") || objectPath.startsWith("/")) return false;
  return new RegExp(`^beatbay/${id}/quarantine/${UUID.source.slice(1, -1)}\\.${extension}$`, "i").test(objectPath);
}

function bytesOf(value) {
  if (value instanceof Uint8Array) return value;
  return new Uint8Array(value || []);
}

function startsWith(bytes, signature) {
  if (bytes.length < signature.length) return false;
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) return false;
  }
  return true;
}

function asciiHas(bytes, needle) {
  const slice = bytes.subarray(0, Math.min(bytes.length, 1024));
  return new TextDecoder("latin1").decode(slice).toLowerCase().includes(needle);
}

export function executableMagic(value) {
  const bytes = bytesOf(value);
  if (bytes.length < 2) return "";
  if (bytes[0] === 0x4d && bytes[1] === 0x5a) return "MZ";
  if (bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) return "ELF";
  if (bytes[0] === 0x23 && bytes[1] === 0x21) return "shebang";
  if (bytes.length >= 4) {
    const magic = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
    if (magic === 0xfeedface || magic === 0xcefaedfe || magic === 0xfeedfacf || magic === 0xcffaedfe || magic === 0xcafebabe) return "mach-o";
  }
  return "";
}

export function magicAllowlist(ext, value) {
  const bytes = bytesOf(value);
  const kind = String(ext || "").toLowerCase();
  const executable = executableMagic(bytes);
  if (executable) return { ok: false, error: `Rejected: file content looks like an executable (${executable}).` };
  if (asciiHas(bytes, "<script") || asciiHas(bytes, "<?php")) {
    return { ok: false, error: "Rejected: file content looks like a script polyglot." };
  }
  if (kind === "mp3") {
    const id3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
    const frame = bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
    if (!id3 && !frame) return { ok: false, error: "Rejected: MP3 content does not match an MP3 file." };
    return { ok: true, mime: "audio/mpeg" };
  }
  if (kind === "wav") {
    const riff = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
    const wave = bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45;
    if (!riff || !wave) return { ok: false, error: "Rejected: WAV content does not match a WAV file." };
    return { ok: true, mime: "audio/wav" };
  }
  if (kind === "jpg" || kind === "jpeg") {
    if (!(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) return { ok: false, error: "Rejected: cover content does not match a JPEG file." };
    return { ok: true, mime: "image/jpeg" };
  }
  if (kind === "png") {
    if (!startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ok: false, error: "Rejected: cover content does not match a PNG file." };
    return { ok: true, mime: "image/png" };
  }
  if (kind === "webp") {
    const riff = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
    const webp = bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
    if (!riff || !webp) return { ok: false, error: "Rejected: cover content does not match a WebP file." };
    return { ok: true, mime: "image/webp" };
  }
  if (kind === "json") {
    if (bytes.includes(0)) return { ok: false, error: "Rejected: sidecar contains binary data." };
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim();
    if (!text.startsWith("{")) return { ok: false, error: "Rejected: sidecar must be a JSON object." };
    try {
      const data = JSON.parse(text);
      if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, error: "Rejected: sidecar must be a JSON object." };
    } catch {
      return { ok: false, error: "Rejected: sidecar is not valid JSON." };
    }
    return { ok: true, mime: "application/json" };
  }
  return { ok: false, error: "Rejected: this file type is not on the allowlist." };
}

export function redactLog(value) {
  return String(value ?? "")
    .replace(/bearer\s+[a-z0-9\-._~+/]+=*/gi, "bearer [redacted]")
    .replace(/sb_(?:secret|publishable|anon)_[a-z0-9_\-]+/gi, "[redacted-key]")
    .replace(/\bsk_(?:live|test)_[a-z0-9]+\b/gi, "[redacted-key]")
    .replace(/\bwhsec_[a-z0-9]+\b/gi, "[redacted-key]")
    .replace(/\beyJ[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}/gi, "[redacted-jwt]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .slice(0, 300);
}
