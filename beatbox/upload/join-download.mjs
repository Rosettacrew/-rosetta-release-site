import { createIncrementalSha256, sha256Hex } from "./hash-engine.mjs";

export function chooseJoinStrategy({ canStream = false, partByPart = false } = {}) {
  if (partByPart) return "parts";
  if (canStream) return "stream";
  return "blob";
}

export async function joinParts({ manifest, fetchPart, writable, encoding = "identity" }) {
  const parts = [...(manifest?.parts || [])].sort((left, right) => left.idx - right.idx);
  const compressed = await createIncrementalSha256();
  const plainChunks = [];
  const useBlob = !writable;
  let gunzip = null;
  let gunzipWriter = null;
  let gunzipDone = null;
  if (encoding === "gzip") {
    gunzip = new DecompressionStream("gzip");
    gunzipWriter = gunzip.writable.getWriter();
    gunzipDone = new Response(gunzip.readable).arrayBuffer();
  }
  for (const part of parts) {
    const bytes = await bytesOf(await fetchPart(part));
    const actual = await sha256Hex(bytes);
    if (part.sha256 && actual !== part.sha256) {
      throw Object.assign(new Error(`Part ${part.idx} failed the integrity check.`), { code: "CHUNK_HASH_MISMATCH" });
    }
    compressed.update(bytes);
    if (gunzipWriter) await gunzipWriter.write(bytes);
    else if (writable) await writable.write(bytes);
    else plainChunks.push(bytes);
  }
  const fileSha256 = compressed.digest();
  if (manifest?.file_sha256 && fileSha256 !== manifest.file_sha256) {
    throw Object.assign(new Error("The joined file failed the integrity check."), { code: "CHUNK_HASH_MISMATCH" });
  }
  if (gunzipWriter) {
    await gunzipWriter.close();
    const plain = new Uint8Array(await gunzipDone);
    if (writable) await writable.write(plain);
    if (manifest?.original_sha256) {
      const original = await sha256Hex(plain);
      if (original !== manifest.original_sha256) {
        throw Object.assign(new Error("The joined file failed the integrity check."), { code: "CHUNK_HASH_MISMATCH" });
      }
    }
    if (writable?.close) await writable.close();
    return { fileSha256, bytes: writable ? null : plain, strategy: writable ? "stream" : "blob" };
  }
  if (writable?.close) await writable.close();
  if (!useBlob) return { fileSha256, bytes: null, strategy: "stream" };
  const blob = new Blob(plainChunks);
  return { fileSha256, bytes: new Uint8Array(await blob.arrayBuffer()), strategy: "blob" };
}

export function normalizeMasterDownload(body) {
  if (body && body.chunked === true) {
    const manifest = { ...(body.manifest || {}) };
    const parts = [...(body.parts || [])]
      .map((part) => ({
        idx: Number(part.idx),
        bytes: part.bytes,
        sha256: part.sha256,
        url: part.url,
      }))
      .sort((left, right) => left.idx - right.idx);
    return {
      mode: "chunked",
      downloadUrl: null,
      expiresIn: body.expires_in ?? null,
      manifest: { ...manifest, parts },
      parts,
    };
  }
  return {
    mode: "single",
    downloadUrl: body?.download_url || null,
    expiresIn: body?.expires_in ?? null,
    chunked: false,
  };
}

export function detectJoinStrategy(env = globalThis) {
  const navigator = env.navigator;
  const ua = navigator?.userAgent || "";
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator?.platform === "MacIntel" && navigator?.maxTouchPoints > 1);
  if (ios || env.partByPart) return "parts";
  if (typeof env.showSaveFilePicker === "function") return "stream";
  return chooseJoinStrategy({ canStream: !!env.canStream, partByPart: false });
}

export async function joinMasterDownload({ response, fetchPart, writable, strategy }) {
  const plan = normalizeMasterDownload(response);
  if (plan.mode !== "chunked") return plan;
  const chosen = strategy || (writable ? "stream" : detectJoinStrategy());
  if (chosen === "parts") {
    const files = [];
    for (const part of plan.parts) {
      const bytes = await bytesOf(await fetchPart(part));
      const actual = await sha256Hex(bytes);
      if (part.sha256 && actual !== part.sha256) {
        throw Object.assign(new Error(`Part ${part.idx} failed the integrity check.`), { code: "CHUNK_HASH_MISMATCH" });
      }
      files.push({ idx: part.idx, bytes, sha256: actual, url: part.url });
    }
    return { mode: "parts", parts: files, manifest: plan.manifest, downloadUrl: null };
  }
  const joined = await joinParts({
    manifest: plan.manifest,
    fetchPart,
    writable: chosen === "stream" ? writable : undefined,
    encoding: plan.manifest.encoding || "identity",
  });
  return { mode: chosen, ...joined, manifest: plan.manifest, downloadUrl: null };
}

async function bytesOf(part) {
  if (part instanceof Uint8Array) return part;
  if (part instanceof ArrayBuffer) return new Uint8Array(part);
  if (part?.arrayBuffer) return new Uint8Array(await part.arrayBuffer());
  throw new Error("Missing part bytes.");
}
