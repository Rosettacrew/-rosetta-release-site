function concatUint(left, right) {
  if (!left?.byteLength) return right;
  if (!right?.byteLength) return left;
  const out = new Uint8Array(left.byteLength + right.byteLength);
  out.set(left, 0);
  out.set(right, left.byteLength);
  return out;
}

export function streamEntryChunks(entry, { chunkBytes, declaredSize, signal } = {}) {
  const size = Number(chunkBytes);
  if (!Number.isFinite(size) || size <= 0) throw new Error("Chunk size is missing.");
  return {
    async *[Symbol.asyncIterator]() {
      let carry = new Uint8Array(0);
      let total = 0;
      const queue = [];
      let dataWait = null;
      let spaceWait = null;
      let error = null;
      const wakeReader = () => {
        if (!dataWait) return;
        const resolve = dataWait;
        dataWait = null;
        resolve();
      };
      const wakeWriter = () => {
        if (!spaceWait) return;
        const resolve = spaceWait;
        spaceWait = null;
        resolve();
      };
      const writable = new WritableStream({
        async write(chunk) {
          if (signal?.aborted) throw new Error("aborted");
          const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          total += data.byteLength;
          if (declaredSize != null && total > declaredSize) {
            throw Object.assign(new Error("ZIP entry exceeded its declared size."), { code: "ZIP_UNSAFE" });
          }
          carry = concatUint(carry, data);
          while (carry.byteLength >= size) {
            queue.push(carry.slice(0, size));
            carry = carry.slice(size);
            wakeReader();
            while (queue.length > 1) await new Promise((resolve) => { spaceWait = resolve; });
          }
        },
      });
      const finished = entry.getData(writable, { checkCrc32: true }).then(() => {
        if (carry.byteLength) queue.push(carry);
        if (declaredSize != null && total !== Number(declaredSize)) {
          error = Object.assign(new Error("ZIP entry size did not match the central directory."), { code: "ZIP_UNSAFE" });
        }
        queue.push(null);
        wakeReader();
      }, (err) => {
        error = err;
        queue.push(null);
        wakeReader();
      });
      while (true) {
        while (queue.length === 0) await new Promise((resolve) => { dataWait = resolve; });
        const item = queue.shift();
        wakeWriter();
        if (item == null) break;
        yield item;
      }
      await finished;
      if (error) throw error;
    },
  };
}

export function entrySource(entry, { name, lastModified = 0 } = {}) {
  const declared = Number(entry.uncompressedSize) || 0;
  return {
    name: name || entry.filename,
    size: declared,
    lastModified,
    seekable: false,
    streamChunks(chunkBytes, signal) {
      return streamEntryChunks(entry, { chunkBytes, declaredSize: declared, signal });
    },
    async slice(start, end) {
      const parts = [];
      let pos = 0;
      const writable = new WritableStream({
        write(chunk) {
          const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          const next = pos + data.byteLength;
          const from = Math.max(pos, start);
          const to = Math.min(next, end);
          if (to > from) parts.push(data.slice(from - pos, to - pos));
          pos = next;
        },
      });
      await entry.getData(writable, { checkCrc32: true });
      if (declared && pos !== declared) {
        throw Object.assign(new Error("ZIP entry size did not match the central directory."), { code: "ZIP_UNSAFE" });
      }
      return concatParts(parts);
    },
  };
}

function concatParts(parts) {
  const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
