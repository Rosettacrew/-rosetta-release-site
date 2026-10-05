/**
 * Owner and admin upload quarantine.
 * Signed URLs go to private release-private. Attach promotes to release-public
 * only after magicAllowlist and size checks. The stored content-type comes
 * from magic bytes. Client Content-Type and public_url are ignored.
 * No network and no secrets.
 *
 * Shared by beatbay-manager and release-manager. Do not import across
 * function folders; dashboard and CLI deploys both bundle _shared.
 */
import { MAX_AUDIO_BYTES, isUuid, magicAllowlist } from "./beatbox-guard.mjs";

export { MAX_AUDIO_BYTES };

export const QUARANTINE_BUCKET = "release-private";
export const PUBLIC_BUCKET = "release-public";
export const MAX_COVER_BYTES = 20 * 1024 * 1024;

const AUDIO_EXT = new Set(["mp3", "wav"]);
const COVER_EXT = new Set(["jpg", "jpeg", "png", "webp"]);
const UUID_SRC = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export function hasUnsafePath(path) {
  const raw = String(path ?? "");
  if (!raw || raw.length > 512) return true;
  if (raw.includes("\0") || raw.includes("\\") || raw.startsWith("/") || raw.startsWith("\\")) return true;
  if (/%(?:2e|2f|5c)/i.test(raw)) return true;
  if (raw.split("/").some((part) => part === "" || part === "." || part === "..")) return true;
  let decoded = raw;
  for (let pass = 0; pass < 2; pass += 1) {
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return true;
    }
    if (next === decoded) break;
    decoded = next;
  }
  if (decoded !== raw) return true;
  if (decoded.includes("..") || decoded.startsWith("/") || decoded.includes("\\") || decoded.includes("\0")) return true;
  return false;
}

export function parseOwnerBeatAssetPath(beatId, kind, path) {
  const id = String(beatId ?? "").trim();
  const assetKind = String(kind ?? "").trim().toLowerCase();
  const objectPath = String(path ?? "").trim();
  if (!isUuid(id) || (assetKind !== "preview" && assetKind !== "full")) {
    return { ok: false, error: "Asset path is not allowed." };
  }
  if (hasUnsafePath(objectPath)) return { ok: false, error: "Asset path is not allowed." };
  const match = new RegExp(
    `^beatbay/${id}/(preview|full)/(${UUID_SRC})\\.(mp3|wav)$`,
    "i",
  ).exec(objectPath);
  if (!match || match[1].toLowerCase() !== assetKind) {
    return { ok: false, error: "Asset path is not allowed." };
  }
  const ext = match[3].toLowerCase();
  return {
    ok: true,
    ext,
    path: objectPath,
    quarantineBucket: QUARANTINE_BUCKET,
    finalBucket: assetKind === "preview" ? PUBLIC_BUCKET : QUARANTINE_BUCKET,
  };
}

export function parseOwnerCoverPath(productId, path) {
  const id = String(productId ?? "").trim();
  const objectPath = String(path ?? "").trim();
  if (!isUuid(id) || hasUnsafePath(objectPath)) {
    return { ok: false, error: "Cover path is not allowed." };
  }
  const match = new RegExp(`^${id}/cover/cover-(${UUID_SRC})\\.(jpg|jpeg|png|webp)$`, "i").exec(objectPath);
  if (!match) return { ok: false, error: "Cover path is not allowed." };
  return {
    ok: true,
    ext: match[2].toLowerCase(),
    path: objectPath,
    quarantineBucket: QUARANTINE_BUCKET,
    finalBucket: PUBLIC_BUCKET,
  };
}

export function derivedPublicObjectUrl(supabaseUrl, bucket, path) {
  const base = String(supabaseUrl ?? "").replace(/\/+$/, "");
  if (!base || bucket !== PUBLIC_BUCKET || hasUnsafePath(path)) return "";
  return `${base}/storage/v1/object/public/${PUBLIC_BUCKET}/${path}`;
}

export function inspectUploadBytes(ext, bytes, maxBytes) {
  const value = bytes instanceof Uint8Array ? bytes : bytes == null ? null : new Uint8Array(bytes);
  if (!value) return { ok: false, status: 400, error: "Upload failed the size check." };
  if (value.byteLength === 0 || value.byteLength > maxBytes) {
    return { ok: false, status: 400, error: "Upload failed the size check." };
  }
  const verdict = magicAllowlist(String(ext || "").toLowerCase(), value);
  if (!verdict.ok) return { ok: false, status: 400, error: verdict.error || "Upload failed the file check." };
  return { ok: true, mime: verdict.mime, bytes: value };
}

export function ownerBeatSignedUploadTarget(beatId, kind, fileId, ext) {
  const assetKind = String(kind ?? "").trim().toLowerCase();
  const extension = String(ext ?? "").toLowerCase();
  if (!isUuid(beatId) || !isUuid(fileId) || (assetKind !== "preview" && assetKind !== "full")) {
    return { ok: false };
  }
  if (!AUDIO_EXT.has(extension)) return { ok: false };
  return {
    ok: true,
    bucket: QUARANTINE_BUCKET,
    path: `beatbay/${String(beatId).trim()}/${assetKind}/${String(fileId).trim()}.${extension}`,
    public_url: null,
    quarantine: true,
  };
}

export function ownerCoverSignedUploadTarget(productId, fileId, ext) {
  const extension = String(ext ?? "").toLowerCase();
  if (!isUuid(productId) || !isUuid(fileId) || !COVER_EXT.has(extension)) return { ok: false };
  return {
    ok: true,
    bucket: QUARANTINE_BUCKET,
    path: `${String(productId).trim()}/cover/cover-${String(fileId).trim()}.${extension}`,
    public_url: null,
    quarantine: true,
  };
}

/**
 * clientContentType and bodyPublicUrl are accepted so tests can prove a
 * client-chosen type and URL are never copied onto the public object.
 */
export function evaluateOwnerBeatAttach({
  beatId,
  kind,
  path,
  bytes,
  supabaseUrl,
  durationSeconds,
  clientContentType,
  bodyPublicUrl,
}) {
  void clientContentType;
  void bodyPublicUrl;
  const parsed = parseOwnerBeatAssetPath(beatId, kind, path);
  if (!parsed.ok) return { status: 400, error: parsed.error };
  if (bytes == null) return { status: 409, error: "Upload the audio file before attaching it." };
  const inspected = inspectUploadBytes(parsed.ext, bytes, MAX_AUDIO_BYTES);
  if (!inspected.ok) {
    return {
      status: inspected.status,
      error: inspected.error,
      remove: { bucket: parsed.quarantineBucket, path: parsed.path },
    };
  }
  const promote = {
    fromBucket: parsed.quarantineBucket,
    toBucket: parsed.finalBucket,
    path: parsed.path,
    bytes: inspected.bytes,
    contentType: inspected.mime,
  };
  if (String(kind).toLowerCase() === "preview") {
    const duration = Number(durationSeconds || 30);
    return {
      status: 200,
      changes: {
        preview_url: derivedPublicObjectUrl(supabaseUrl, PUBLIC_BUCKET, parsed.path),
        preview_duration_seconds: duration,
      },
      promote,
    };
  }
  return {
    status: 200,
    changes: {
      full_audio_bucket: QUARANTINE_BUCKET,
      full_audio_path: parsed.path,
    },
    promote,
  };
}

export function evaluateOwnerCoverAttach({ productId, path, bytes, clientContentType }) {
  void clientContentType;
  const parsed = parseOwnerCoverPath(productId, path);
  if (!parsed.ok) return { status: 400, error: parsed.error };
  if (bytes == null) return { status: 409, error: "Upload the cover file before attaching it." };
  const inspected = inspectUploadBytes(parsed.ext, bytes, MAX_COVER_BYTES);
  if (!inspected.ok) {
    return {
      status: inspected.status,
      error: inspected.error,
      remove: { bucket: parsed.quarantineBucket, path: parsed.path },
    };
  }
  return {
    status: 200,
    mime: inspected.mime,
    promote: {
      fromBucket: parsed.quarantineBucket,
      toBucket: parsed.finalBucket,
      path: parsed.path,
      bytes: inspected.bytes,
      contentType: inspected.mime,
    },
  };
}

export function promotionUploadOptions(promote) {
  return {
    contentType: promote.contentType,
    upsert: promote.fromBucket === promote.toBucket,
  };
}

export async function commitPromotion(storage, promote) {
  const options = promotionUploadOptions(promote);
  const { error } = await storage.from(promote.toBucket).upload(promote.path, promote.bytes, options);
  if (error) throw error;
  if (promote.fromBucket !== promote.toBucket) {
    const removed = await storage.from(promote.fromBucket).remove([promote.path]);
    if (removed?.error) console.error("Quarantine cleanup failed");
  }
}

export async function rejectUpload(storage, removal) {
  if (!removal?.bucket || !removal?.path) return;
  const { error } = await storage.from(removal.bucket).remove([removal.path]);
  if (error) console.error("Rejected upload cleanup failed");
}
