/** Beatbox V1 package rules. Pure functions shared by the admin page and node checks. */

import { sandboxedExtractPath } from "../supabase/functions/beatbay-manager/beatbox-guard.mjs";

export {
  QUARANTINE_UPLOAD_TTL_SECONDS,
  PRIVATE_DOWNLOAD_TTL_SECONDS,
  SANDBOX_PREFIX,
  isPublicApiCredential,
  isQuarantinePath,
  isUuid,
  magicAllowlist,
  executableMagic,
  redactLog,
  sandboxedExtractPath,
} from "../supabase/functions/beatbay-manager/beatbox-guard.mjs";

export const LIMITS = {
  zipBytes: 50 * 1024 * 1024,
  audioBytes: 80 * 1024 * 1024,
  coverBytes: 8 * 1024 * 1024,
  sidecarBytes: 64 * 1024,
  uncompressedBytes: 250 * 1024 * 1024,
  maxEntries: 40,
  maxRatio: 500,
};

export const DEFAULT_NONEXCLUSIVE_PRICE = "30.00";

const AUDIO_EXT = new Set(["mp3", "wav"]);
const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "webp"]);
const EXEC_EXT = new Set([
  "exe", "dll", "bat", "cmd", "com", "scr", "msi", "app", "dmg", "sh", "bash",
  "command", "ps1", "vbs", "js", "mjs", "cjs", "jar", "apk", "so", "dylib",
  "html", "htm", "svg", "php", "py", "rb", "pl", "cgi", "wasm", "lnk", "iso", "img",
]);
const JUNK = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i;
const MAC_FORK = /^__MACOSX(\/|$)/i;

const STYLE_WORDS = [
  ["drill", "NY Drill"],
  ["r&b", "R&B"],
  ["rnb", "R&B"],
  ["trap", "Trap"],
  ["gospel", "Gospel"],
  ["afro", "Afrobeat"],
  ["dancehall", "Dancehall"],
  ["reggae", "Reggae"],
  ["country", "Country"],
  ["pop", "Pop"],
  ["edm", "EDM"],
];

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function canonicalZipPath(raw) {
  let norm = String(raw ?? "");
  if (!norm || /[\u0000-\u001f]/.test(norm)) return { error: "invalid path" };
  norm = norm.replace(/\\/g, "/");
  if (norm.length > 240) return { error: "path is too long" };
  if (/^[a-zA-Z]:/.test(norm) || norm.startsWith("//") || norm.startsWith("/")) return { error: "absolute path" };
  while (norm.startsWith("./")) norm = norm.slice(2);
  if (norm.endsWith("/")) norm = norm.replace(/\/+$/, "");
  if (!norm) return { error: "invalid path" };
  const parts = norm.split("/");
  if (parts.includes("..")) return { error: "path traversal" };
  if (parts.some((part) => part === "" || part === ".")) return { error: "invalid path" };
  return { path: parts.join("/") };
}

export function isZipSymlink(unixPermissions) {
  if (unixPermissions == null || unixPermissions === "") return false;
  const mode = Number(unixPermissions);
  if (!Number.isFinite(mode)) return false;
  return (mode & 0o170000) === 0o120000;
}

export function viewZipEntry(file) {
  const originalName = typeof file?.unsafeOriginalName === "string" && file.unsafeOriginalName
    ? file.unsafeOriginalName
    : file?.originalName || file?.name;
  const data = file?._data || {};
  const dir = !!file?.dir || String(file?.name || "").endsWith("/") || String(originalName || "").endsWith("/");
  return {
    originalName: String(originalName ?? ""),
    zipName: String(file?.name || originalName || ""),
    dir,
    uncompressedSize: dir ? 0 : finiteNumber(data.uncompressedSize ?? file?.uncompressedSize),
    compressedSize: dir ? 0 : finiteNumber(data.compressedSize ?? file?.compressedSize),
    unixPermissions: file?.unixPermissions ?? null,
  };
}

function extensionOf(path) {
  const base = path.split("/").pop() || "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

function label(path) {
  return String(path || "entry").replace(/[\u0000-\u001f]/g, "").slice(0, 180) || "entry";
}

function isPreviewName(path) {
  return /(^|\/)preview\.(mp3|wav)$/i.test(path);
}

function isFullName(path) {
  return /(^|\/)(full|master)\.(mp3|wav)$/i.test(path);
}

function pickAudio(audio) {
  if (audio.length === 1) {
    const only = audio[0];
    return {
      preview: only,
      full: null,
      warnings: isFullName(only.path) ? ["Only one audio file was found, so it will be used as the preview."] : [],
    };
  }
  if (audio.length > 2) {
    return { error: "Keep one preview and at most one full master. Extra audio files are not allowed in Beatbox V1." };
  }
  const [first, second] = audio;
  const firstPreview = isPreviewName(first.path);
  const secondPreview = isPreviewName(second.path);
  const firstFull = isFullName(first.path);
  const secondFull = isFullName(second.path);
  if (firstPreview && secondPreview) return { error: "Only one preview audio file is allowed. Name the master full.wav." };
  if (firstFull && secondFull) return { error: "Only one full master is allowed. Name the preview preview.mp3." };
  if (firstPreview && (secondFull || !secondPreview)) return { preview: first, full: second, warnings: [] };
  if (secondPreview && (firstFull || !firstPreview)) return { preview: second, full: first, warnings: [] };
  if (firstFull && !secondFull) return { preview: second, full: first, warnings: [] };
  if (secondFull && !firstFull) return { preview: first, full: second, warnings: [] };
  return { error: "Name the preview preview.mp3 (or include a single MP3 at the ZIP root) and the optional master full.wav." };
}

export function validateZipEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ok: false, errors: ["The archive is empty."], warnings: [], preview: null, full: null, cover: null, sidecar: null };
  }
  const errors = [];
  const warnings = [];
  const audio = [];
  const images = [];
  const sidecars = [];
  let uncompressed = 0;
  let kept = 0;

  for (const entry of entries) {
    const original = String(entry?.originalName || entry?.name || "");
    // JSZip synthesizes a "/" directory when a name starts with ./ or ../.
    if ((entry?.dir || original.endsWith("/")) && (original === "/" || original === "")) continue;
    const parsed = canonicalZipPath(original);
    if (parsed.error) {
      errors.push(`Rejected ${label(original)}: ${parsed.error}.`);
      continue;
    }
    if (isZipSymlink(entry.unixPermissions)) {
      errors.push(`Rejected ${label(parsed.path)}: symbolic links are not allowed.`);
      continue;
    }
    if (entry.dir || String(original).endsWith("/")) continue;
    if (MAC_FORK.test(parsed.path) || JUNK.test(parsed.path)) continue;

    const size = finiteNumber(entry.uncompressedSize);
    const compressed = finiteNumber(entry.compressedSize);
    if (size == null || size < 0) {
      errors.push(`Rejected ${label(parsed.path)}: the file size could not be read before opening it.`);
      continue;
    }
    if (compressed != null) {
      if (compressed === 0 && size > 0) {
        errors.push(`Rejected ${label(parsed.path)}: invalid compressed size.`);
        continue;
      }
      if (compressed > 0 && size / compressed > LIMITS.maxRatio) {
        errors.push(`Rejected ${label(parsed.path)}: compression ratio is too high.`);
        continue;
      }
    }
    uncompressed += size;
    kept += 1;
    const storedName = String(entry.zipName || parsed.path);
    const stored = canonicalZipPath(storedName);
    if (stored.error || stored.path !== parsed.path || !sandboxedExtractPath(parsed.path)) {
      errors.push(`Rejected ${label(parsed.path)}: entry name escapes the sandbox.`);
      continue;
    }
    const ext = extensionOf(parsed.path);
    const file = { path: parsed.path, zipName: storedName, ext, size, sandbox: sandboxedExtractPath(parsed.path) };
    if (ext === "zip") {
      errors.push(`Rejected ${label(parsed.path)}: nested ZIP files are not supported.`);
      continue;
    }
    if (EXEC_EXT.has(ext)) {
      errors.push(`Rejected ${label(parsed.path)}: executable or script files are not allowed.`);
      continue;
    }
    if (AUDIO_EXT.has(ext)) {
      if (size === 0) errors.push(`Rejected ${label(parsed.path)}: audio file is empty.`);
      else if (size > LIMITS.audioBytes) errors.push(`Rejected ${label(parsed.path)}: audio file is larger than 80 MB.`);
      else audio.push(file);
      continue;
    }
    if (IMAGE_EXT.has(ext)) {
      if (size === 0) errors.push(`Rejected ${label(parsed.path)}: cover image is empty.`);
      else if (size > LIMITS.coverBytes) errors.push(`Rejected ${label(parsed.path)}: cover image is larger than 8 MB.`);
      else images.push(file);
      continue;
    }
    if (ext === "json" && /^(beat|metadata)\.json$/i.test(parsed.path.split("/").pop() || "")) {
      if (size === 0) errors.push(`Rejected ${label(parsed.path)}: sidecar is empty.`);
      else if (size > LIMITS.sidecarBytes) errors.push(`Rejected ${label(parsed.path)}: sidecar is larger than 64 KB.`);
      else sidecars.push(file);
      continue;
    }
    errors.push(`Rejected ${label(parsed.path)}: unexpected file type. Allowed files are MP3, WAV, one JPG/PNG/WebP cover, and optional beat.json or metadata.json.`);
  }

  if (kept === 0 && errors.length === 0) errors.push("The archive is empty.");
  if (kept > LIMITS.maxEntries) errors.push(`This archive has too many files (maximum ${LIMITS.maxEntries}).`);
  if (uncompressed > LIMITS.uncompressedBytes) errors.push("Uncompressed contents exceed 250 MB.");
  if (audio.length === 0 && !errors.some((error) => error.includes("at least one"))) {
    errors.push("Add at least one MP3 or WAV audio file.");
  }
  if (images.length > 1) errors.push("Only one cover image is allowed (jpg, png, or webp).");
  if (sidecars.length > 1) errors.push("Only one sidecar is allowed (beat.json or metadata.json).");

  let preview = null;
  let full = null;
  let cover = images.length === 1 ? images[0] : null;
  let sidecar = sidecars.length === 1 ? sidecars[0] : null;
  if (errors.length === 0) {
    const picked = pickAudio(audio);
    if (picked.error) errors.push(picked.error);
    else {
      preview = picked.preview;
      full = picked.full;
      warnings.push(...(picked.warnings || []));
    }
  }
  if (errors.length) {
    preview = null;
    full = null;
    cover = null;
    sidecar = null;
  }
  return { ok: errors.length === 0, errors, warnings, preview, full, cover, sidecar };
}

export function zipRejectedReason(file) {
  const name = String(file?.name || "");
  if (!name) return "Choose a .zip package.";
  if (!/\.zip$/i.test(name)) return "Choose a .zip package. Other archive types are not accepted.";
  const size = Number(file?.size);
  if (!Number.isFinite(size)) return "Could not read the ZIP size.";
  if (size <= 0) return "The ZIP file is empty.";
  if (size > LIMITS.zipBytes) return "This ZIP is larger than 50 MB. Reduce the audio size and try again.";
  return null;
}

function cleanText(value, max) {
  const text = String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
  if (text.length <= max) return text;
  return text.slice(0, max);
}

export function parseSidecar(text) {
  let data;
  try {
    data = JSON.parse(String(text ?? ""));
  } catch {
    return { ok: false, error: "beat.json / metadata.json is not valid JSON.", fields: {}, warnings: [] };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: "Sidecar must be a JSON object.", fields: {}, warnings: [] };
  }
  const fields = {};
  const warnings = [];
  if (data.title != null) {
    const title = cleanText(data.title, 120);
    if (!title) warnings.push("Sidecar title is empty.");
    else fields.title = title;
    if (String(data.title).trim().length > 120) warnings.push("Sidecar title was shortened to 120 characters.");
  }
  if (data.bpm != null && data.bpm !== "") {
    const bpm = Math.round(Number(data.bpm));
    if (!Number.isFinite(bpm) || bpm < 40 || bpm > 240) warnings.push("Sidecar BPM was ignored because it is outside 40–240.");
    else fields.bpm = bpm;
  }
  if (data.style != null) {
    const style = cleanText(data.style, 80);
    if (style) fields.style = style;
  }
  const keySource = data.musical_key ?? data.key;
  if (keySource != null) {
    const musicalKey = cleanText(keySource, 40);
    if (musicalKey) fields.musical_key = musicalKey;
  }
  if (data.beat_code != null && String(data.beat_code).trim()) {
    const code = String(data.beat_code).trim().toUpperCase().replace(/\s+/g, " ");
    if (!/^BEAT [0-9]{4}$/.test(code)) warnings.push("Sidecar beat_code was ignored. Use the form BEAT 0007.");
    else fields.beat_code = code;
  }
  if (data.description != null) {
    const description = cleanText(data.description, 2000);
    fields.description = description;
    if (String(data.description).trim().length > 2000) warnings.push("Sidecar description was shortened to 2000 characters.");
  }
  if (data.tags != null) {
    const list = Array.isArray(data.tags) ? data.tags : String(data.tags).split(",");
    const tags = [];
    let dropped = false;
    for (const item of list) {
      const tag = cleanText(item, 32).toLowerCase();
      if (!tag) continue;
      if (String(item).trim().length > 32 || !/^[a-z0-9][a-z0-9 +#.&'-]*$/i.test(tag)) {
        dropped = true;
        continue;
      }
      if (!tags.includes(tag)) tags.push(tag);
      if (tags.length > 12) {
        dropped = true;
        break;
      }
    }
    if (dropped) warnings.push("Some sidecar tags were ignored. Use up to 12 short tags.");
    if (tags.length) fields.tags = tags.join(", ");
  }
  return { ok: true, error: "", fields, warnings };
}

export function keywordStyle(name) {
  const text = String(name || "").toLowerCase();
  for (const [word, style] of STYLE_WORDS) if (text.includes(word)) return style;
  return null;
}

export function suggestStyle(name, bpm) {
  const named = keywordStyle(name);
  if (named) return named;
  const tempo = Number(bpm);
  if (!Number.isFinite(tempo)) return null;
  if (tempo >= 125) return "Trap / Hip-Hop";
  if (tempo <= 105) return "R&B / Hip-Hop";
  return "Hip-Hop";
}

export function detectKey(name) {
  const match = String(name || "").match(/\b([A-G](?:#|b)?)\s*(min(?:or)?|maj(?:or)?|m)\b/i);
  if (!match) return null;
  const letter = match[1][0].toUpperCase();
  const accidental = match[1].slice(1) === "#" ? "#" : match[1].slice(1).toLowerCase() === "b" ? "b" : "";
  const quality = /maj/i.test(match[2]) ? "major" : "minor";
  return `${letter}${accidental} ${quality}`;
}

export function titleFromFilename(path) {
  let base = String(path || "").split("/").pop() || "";
  base = base.replace(/\.(mp3|wav)$/i, "");
  base = base.replace(/\b\d{2,3}\s*bpm\b/gi, " ");
  base = base.replace(/\bbpm[\s_-]*\d{2,3}\b/gi, " ");
  base = base.replace(/\b[A-G](?:#|b)?\s*(?:min(?:or)?|maj(?:or)?|m)\b/gi, " ");
  base = base.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!base) return "";
  return base.slice(0, 120).replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

export function filenameHints(path) {
  const base = String(path || "").split("/").pop() || "";
  const bpmMatch = base.match(/(?:^|[^0-9])(\d{2,3})\s*bpm\b/i) || base.match(/\bbpm[\s_-]*(\d{2,3})(?!\d)/i);
  let bpm = bpmMatch ? Number(bpmMatch[1]) : null;
  if (bpm != null && (bpm < 40 || bpm > 240)) bpm = null;
  return {
    title: titleFromFilename(base),
    bpm,
    style: keywordStyle(base),
    musical_key: detectKey(base),
  };
}

export function nextBeatCode(codes) {
  let max = -1;
  for (const code of codes || []) {
    const match = String(code || "").trim().toUpperCase().match(/^BEAT ([0-9]{4})$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  const next = max + 1;
  if (next > 9999) return null;
  return `BEAT ${String(next).padStart(4, "0")}`;
}

export function defaultLicensing() {
  return {
    nonexclusive_enabled: true,
    nonexclusive_price: DEFAULT_NONEXCLUSIVE_PRICE,
    exclusive_enabled: false,
    exclusive_price: "",
    ownership_enabled: false,
    ownership_price: "",
  };
}

export function buildReviewDraft({ previewPath, sidecar, existingCodes }) {
  const hints = filenameHints(previewPath);
  const fields = sidecar?.ok === false ? {} : (sidecar?.fields || {});
  const warnings = [...(sidecar?.warnings || [])];
  if (sidecar?.ok === false && sidecar.error) warnings.push(sidecar.error);
  let beatCode = fields.beat_code || "";
  const taken = new Set((existingCodes || []).map((code) => String(code || "").trim().toUpperCase()));
  if (beatCode && taken.has(beatCode)) {
    warnings.push(`${beatCode} is already in the catalog. A new number was suggested.`);
    beatCode = "";
  }
  if (!beatCode) {
    beatCode = nextBeatCode(existingCodes) || "";
    if (!beatCode) warnings.push("The catalog has no free BEAT numbers left. Enter one manually.");
  }
  return {
    beat_code: beatCode,
    title: fields.title || hints.title || "",
    style: fields.style || "",
    bpm: fields.bpm ?? "",
    musical_key: fields.musical_key || "",
    tags: fields.tags || "",
    description: fields.description || "",
    ...defaultLicensing(),
    suggestions: {
      bpm: fields.bpm == null ? hints.bpm : null,
      style: fields.style ? null : hints.style,
      musical_key: fields.musical_key ? null : hints.musical_key,
    },
    sources: {
      title: fields.title ? "sidecar" : hints.title ? "filename" : "",
      bpm: fields.bpm != null ? "sidecar" : "",
      style: fields.style ? "sidecar" : "",
      musical_key: fields.musical_key ? "sidecar" : "",
    },
    warnings,
  };
}

export function validateReview(form) {
  const errors = [];
  const code = String(form?.beat_code || "").trim().toUpperCase().replace(/\s+/g, " ");
  if (!/^BEAT [0-9]{4}$/.test(code)) errors.push("Beat number must look like BEAT 0007.");
  if (!String(form?.title || "").trim()) errors.push("Title is required.");
  if (form?.bpm !== "" && form?.bpm != null) {
    const bpm = Number(form.bpm);
    if (!Number.isFinite(bpm) || bpm < 40 || bpm > 240) errors.push("BPM must be between 40 and 240, or left blank.");
  }
  if (form?.nonexclusive_enabled !== false) {
    const price = Number(form?.nonexclusive_price);
    if (!Number.isFinite(price) || price < 0) errors.push("Non-exclusive price is required.");
  }
  return errors;
}

export function buildSaveBody(form, { id = "", publish = false } = {}) {
  const exclusive = form?.exclusive_enabled === true;
  const ownership = form?.ownership_enabled === true;
  const nonexclusive = form?.nonexclusive_enabled !== false;
  return {
    action: "save_beat",
    intake: "beatbox",
    id: String(id || ""),
    beat_code: String(form?.beat_code || "").trim(),
    title: String(form?.title || "").trim(),
    style: String(form?.style || "").trim(),
    bpm: form?.bpm === "" || form?.bpm == null ? "" : String(form.bpm),
    musical_key: String(form?.musical_key || "").trim(),
    status: publish ? "available" : "draft",
    tags: Array.isArray(form?.tags) ? form.tags.join(", ") : String(form?.tags || ""),
    description: String(form?.description || ""),
    metadata_source: "beatbox",
    signature_sound: false,
    nonexclusive_enabled: nonexclusive,
    nonexclusive_price: nonexclusive ? String(form?.nonexclusive_price || DEFAULT_NONEXCLUSIVE_PRICE) : "",
    exclusive_enabled: exclusive,
    exclusive_price: exclusive ? String(form?.exclusive_price || "") : "",
    ownership_enabled: ownership,
    ownership_price: ownership ? String(form?.ownership_price || "") : "",
  };
}

export function inflateEntry(item) {
  const sandbox = sandboxedExtractPath(item?.path);
  const stored = canonicalZipPath(item?.zipName);
  if (!sandbox || stored.error || stored.path !== item?.path) {
    return { ok: false, error: "Refused to open an entry outside the Beatbox sandbox." };
  }
  const names = [];
  if (item.zipName) names.push(String(item.zipName));
  if (item.path && item.path !== item.zipName) names.push(String(item.path));
  return { ok: true, names };
}

export function buildPublishBody(id) {
  return {
    action: "set_storefront",
    id: String(id || ""),
    enabled: true,
    intake: "beatbox",
    confirm_publish: true,
  };
}

export function canPublishRole(role) {
  return role === "owner" || role === "admin";
}

export function uploadFilename(kind, ext) {
  const clean = String(ext || "").toLowerCase() === "jpeg" ? "jpg" : String(ext || "").toLowerCase();
  if (kind === "preview" && !AUDIO_EXT.has(clean)) throw new Error("Preview audio must be MP3 or WAV.");
  if (kind === "full" && !AUDIO_EXT.has(clean)) throw new Error("Full audio must be MP3 or WAV.");
  if (kind !== "preview" && kind !== "full") throw new Error("Upload type must be preview or full.");
  return `${kind}.${clean}`;
}

export function declaredSizeMatches(declared, actual) {
  return Number.isFinite(declared) && Number.isFinite(actual) && declared === actual && actual >= 0;
}
