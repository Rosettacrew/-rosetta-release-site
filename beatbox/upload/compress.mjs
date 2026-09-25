import { COMPRESS_MIN_SAVING_FALLBACK, compressionAllowed, extensionOf, middleSampleRange, normalizeLimits } from "./analyze.mjs";
import { createIncrementalSha256 } from "./hash-engine.mjs";
import { blobSource } from "./source.mjs";

export async function gzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gzipTrial(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (!input.byteLength) return { saving: 0, compressedBytes: 0 };
  const compressed = await gzipBytes(input);
  return { saving: 1 - compressed.byteLength / input.byteLength, compressedBytes: compressed.byteLength };
}

async function readSlice(source, start, end) {
  const part = await source.slice(start, end);
  if (part instanceof Uint8Array) return part;
  if (part instanceof ArrayBuffer) return new Uint8Array(part);
  if (ArrayBuffer.isView(part)) return new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
  if (part?.arrayBuffer) return new Uint8Array(await part.arrayBuffer());
  throw new Error("Could not read the file.");
}

export async function maybeCompress(source, limits, onStatus) {
  const cap = normalizeLimits(limits);
  const ext = extensionOf(source?.name);
  if (!compressionAllowed(ext)) {
    return { encoding: "identity", source, reason: "already-compressed", compressed: false };
  }
  if (source.seekable === false || typeof source.slice !== "function") {
    return { encoding: "identity", source, reason: "the sample could not be read from the middle", compressed: false };
  }
  onStatus?.({ phase: "compress-trial", name: source.name, size: source.size });
  const range = middleSampleRange(source.size);
  const sample = await readSlice(source, range.start, range.end);
  const trial = await gzipTrial(sample);
  const minimum = cap.compressMinSaving == null ? COMPRESS_MIN_SAVING_FALLBACK : cap.compressMinSaving;
  if (trial.saving < minimum) {
    onStatus?.({ phase: "compress-skip", name: source.name, size: source.size, reason: "saving below threshold" });
    return { encoding: "identity", source, reason: "saving below threshold", saving: trial.saving, compressed: false };
  }
  if (cap.compressMaxBytes == null || source.size > cap.compressMaxBytes) {
    onStatus?.({ phase: "compress-skip", name: source.name, size: source.size, reason: "larger than compress_max_bytes" });
    return { encoding: "identity", source, reason: "larger than compress_max_bytes", saving: trial.saving, compressed: false };
  }
  onStatus?.({ phase: "compressing", name: source.name, size: source.size });
  const hasher = await createIncrementalSha256();
  const gzip = new CompressionStream("gzip");
  const writer = gzip.writable.getWriter();
  const compressedPromise = new Response(gzip.readable).arrayBuffer();
  let offset = 0;
  const window = 1024 * 1024;
  while (offset < source.size) {
    const end = Math.min(source.size, offset + window);
    const chunk = await readSlice(source, offset, end);
    hasher.update(chunk);
    await writer.write(chunk);
    offset = end;
  }
  await writer.close();
  const originalSha256 = hasher.digest();
  const gzipped = new File([await compressedPromise], `${source.name}.gz`, {
    type: "application/gzip",
    lastModified: source.lastModified || 0,
  });
  return {
    encoding: "gzip",
    source: blobSource(gzipped),
    originalBytes: source.size,
    originalSha256,
    reason: "compressed",
    saving: trial.saving,
    compressed: true,
  };
}
