export function blobSource(file) {
  return {
    name: file.name || "upload.bin",
    size: Number(file.size) || 0,
    lastModified: Number(file.lastModified || 0) || 0,
    seekable: true,
    slice(start, end) {
      return file.slice(start, end);
    },
  };
}

export async function readSourceRange(source, start, end) {
  if (typeof source.slice === "function" && source.seekable !== false) {
    const part = await source.slice(start, end);
    return bytesOf(part);
  }
  if (typeof source.slice === "function") {
    const part = await source.slice(start, end);
    return bytesOf(part);
  }
  throw new Error("This upload cannot re-read that part.");
}

export async function bytesOf(part) {
  if (part instanceof Uint8Array) return part;
  if (part instanceof ArrayBuffer) return new Uint8Array(part);
  if (ArrayBuffer.isView(part)) return new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
  if (part?.arrayBuffer) return new Uint8Array(await part.arrayBuffer());
  throw new Error("Could not read the file.");
}
