import { createIncrementalSha256, sha256Hex } from "./hash-engine.mjs";

let hasher = null;
let file = null;
let chunkBytes = 0;
let idx = 0;
let total = 0;

function emit(message, transfer) {
  if (typeof WorkerGlobalScope !== "undefined" && typeof self !== "undefined" && typeof self.postMessage === "function" && self instanceof WorkerGlobalScope) {
    self.postMessage(message, transfer || []);
    return;
  }
  if (nodePort) nodePort.postMessage(message, transfer || []);
}

let nodePort = null;

async function hashNext() {
  if (idx >= total) {
    emit({ type: "done", fileSha256: hasher.digest() });
    return;
  }
  const start = idx * chunkBytes;
  const end = Math.min(file.size, start + chunkBytes);
  const sliced = await file.slice(start, end);
  const buf = sliced instanceof ArrayBuffer ? sliced : await sliced.arrayBuffer();
  const sha256 = await sha256Hex(buf);
  hasher.update(new Uint8Array(buf));
  const state = hasher.save();
  const current = idx;
  idx += 1;
  emit({ type: "chunk", idx: current, sha256, buf, state }, [buf]);
}

async function onMessage(event) {
  const msg = event.data ?? event;
  try {
    if (msg.type === "start") {
      hasher = await createIncrementalSha256();
      if (msg.state) hasher.load(msg.state);
      file = msg.file;
      chunkBytes = msg.chunkBytes;
      idx = msg.startIdx || 0;
      total = Math.ceil(file.size / chunkBytes);
      emit({ type: "ready" });
      return;
    }
    if (msg.type === "next") await hashNext();
  } catch (error) {
    emit({ type: "error", message: error?.message || "Worker failed", code: error?.code || "" });
  }
}

const browserWorker = typeof WorkerGlobalScope !== "undefined" && typeof self !== "undefined" && self instanceof WorkerGlobalScope;
if (browserWorker) {
  self.onmessage = (event) => { onMessage(event); };
} else {
  const { parentPort } = await import("node:worker_threads");
  if (parentPort) {
    nodePort = parentPort;
    parentPort.on("message", (data) => { onMessage({ data }); });
  }
}
