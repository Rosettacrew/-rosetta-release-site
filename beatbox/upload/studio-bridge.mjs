import { classify, choosePath } from "./analyze.mjs";
import { maybeCompress } from "./compress.mjs";
import { createUploader } from "./large-upload.mjs";
import { createProtocol } from "./protocol.mjs";
import { readHead } from "./intake.mjs";
import { blobSource } from "./source.mjs";

export const STUDIO_LARGE_UPLOAD_ENABLED = false;

const KIND_MAP = {
  track: "full",
  full: "full",
  preview: "preview",
  package: "zip",
  zip: "zip",
  stems: "stems",
  video: "video",
};

export async function uploadStudioFile(options) {
  if (!options?.enabled && !STUDIO_LARGE_UPLOAD_ENABLED) return { handled: false };
  if (options.kind === "cover") return { handled: false };
  const kind = KIND_MAP[options.kind] || "full";
  const protocol = options.protocol || createProtocol({ ...options, kind });
  const limitsResult = options.limits ? { ok: true, limits: options.limits } : await protocol.fetchLimits();
  if (!limitsResult.ok) return { handled: false, code: limitsResult.code || "LARGE_UPLOAD_UNSUPPORTED" };
  const head = await readHead(options.file);
  const classified = classify({ name: options.file.name, size: options.file.size, head, limits: limitsResult.limits });
  if (!classified.ok) {
    const error = new Error(classified.error);
    error.code = classified.code;
    throw error;
  }
  const choice = choosePath({ size: options.file.size, isBeatboxZip: false, limits: limitsResult.limits });
  if (choice.path !== "chunked") return { handled: false };
  let source = blobSource(options.file);
  let meta = { encoding: "identity", limits: limitsResult.limits };
  if (classified.compressible) {
    const decision = await maybeCompress(source, limitsResult.limits, options.onStatus);
    source = decision.source;
    meta = {
      encoding: decision.encoding,
      originalBytes: decision.originalBytes,
      originalSha256: decision.originalSha256,
      limits: limitsResult.limits,
    };
  }
  const target = options.surface === "release"
    ? { surface: "release", product_id: options.productId }
    : { surface: "beatbay", beat_id: options.beatId };
  const uploader = createUploader({
    endpoint: options.endpoint,
    getToken: options.getToken,
    apikey: options.apikey,
    target,
    kind,
    userId: options.userId,
    protocol,
    storage: options.storage,
    sleep: options.sleep,
    now: options.now,
    random: options.random,
    onStatus: options.onStatus,
    events: options.events,
  });
  const result = await uploader.upload(source, meta);
  if (options.attach !== false) {
    const attached = await protocol.attach({
      kind,
      sessionId: result.sessionId,
      studio: options.surface !== "release",
      filename: options.file.name,
      durationSeconds: kind === "preview" ? 30 : null,
    });
    if (!attached.ok) {
      const error = new Error(attached.message || attached.code);
      error.code = attached.code;
      throw error;
    }
  }
  return { handled: true, result, uploader };
}
