import { LIMITS, magicAllowlist, parseSidecar, uploadFilename, validateZipEntries } from "../package-rules.mjs";
import { HEAD_BYTES, classify, choosePath, normalizeLimits } from "./analyze.mjs";
import { loadZipJs } from "./zip-loader.mjs";
import { preflightZip } from "./zip-preflight.mjs";
import { entrySource } from "./zip-stream-entry.mjs";
import { blobSource } from "./source.mjs";

export function zipLimitsFromServer(server) {
  const limits = normalizeLimits(server);
  const max = limits.maxFileBytes;
  return {
    ...LIMITS,
    ...(max != null ? { zipBytes: max, audioBytes: max, uncompressedBytes: max } : {}),
  };
}

export async function readHead(file, bytes = HEAD_BYTES) {
  const end = Math.min(Number(file.size) || 0, bytes);
  const buffer = await file.slice(0, end).arrayBuffer();
  return new Uint8Array(buffer);
}

function findEntry(entries, item) {
  return entries.find((entry) => entry.filename === item.zipName || entry.filename === item.path);
}

async function readSmall(zip, entries, item, filename) {
  const entry = findEntry(entries, item);
  if (!entry) throw new Error(`Missing ${item.path} after validation.`);
  const blob = await entry.getData(new zip.BlobWriter(), { checkCrc32: true });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.byteLength !== item.size) {
    throw new Error(`${item.path} size did not match the ZIP directory. The file was not uploaded.`);
  }
  const verdict = magicAllowlist(item.ext, bytes);
  if (!verdict.ok) throw new Error(verdict.error);
  const file = new File([bytes], filename || item.path.split("/").pop(), { type: verdict.mime });
  return { bytes, mime: verdict.mime, file, path: item.path };
}

export async function inspectBeatboxZip({ file, protocol, zipApi }) {
  const head = await readHead(file);
  const limitsResult = await protocol.fetchLimits();
  if (!limitsResult.ok) {
    const error = new Error(limitsResult.message || "Large upload is not available.");
    error.code = limitsResult.code || "LARGE_UPLOAD_UNSUPPORTED";
    throw error;
  }
  const limits = limitsResult.limits;
  const classified = classify({ name: file.name, size: file.size, head, limits });
  if (!classified.ok && classified.code !== "LIMIT_EXCEEDED") {
    return { ok: false, errors: [classified.error], code: classified.code };
  }
  const path = choosePath({ size: file.size, isBeatboxZip: true, limits });
  if (path.path === "single") return { ok: true, path: "single", limits };
  if (path.path === "reject" || path.path === "needs-limits") {
    return { ok: false, errors: [classified.error || "This file failed a safety check and was not saved. Nothing was published."], code: path.code || classified.code };
  }
  const zip = zipApi || await loadZipJs();
  const opened = await preflightZip(file, zipLimitsFromServer(limits), zip);
  if (!opened.result.ok) {
    await opened.reader.close().catch(() => {});
    return { ok: false, errors: opened.result.errors, code: "ZIP_UNSAFE" };
  }
  if (limits.previewMaxBytes != null && opened.result.preview && opened.result.preview.size > limits.previewMaxBytes) {
    await opened.reader.close().catch(() => {});
    return {
      ok: false,
      code: "LIMIT_EXCEEDED",
      errors: ["This preview is larger than the server preview limit. Nothing was published."],
    };
  }
  const preview = await readSmall(zip, opened.entries, opened.result.preview, uploadFilename("preview", opened.result.preview.ext));
  let full = null;
  let fullPlan = null;
  if (opened.result.full) {
    const fullPath = choosePath({ size: opened.result.full.size, isBeatboxZip: false, limits });
    if (fullPath.path === "reject") {
      await opened.reader.close().catch(() => {});
      return { ok: false, code: fullPath.code, errors: ["This file failed a safety check and was not saved. Nothing was published."] };
    }
    if (fullPath.path === "single") {
      full = await readSmall(zip, opened.entries, opened.result.full, uploadFilename("full", opened.result.full.ext));
      await opened.reader.close().catch(() => {});
    } else {
      const entry = findEntry(opened.entries, opened.result.full);
      fullPlan = {
        path: "chunked",
        kind: "full",
        name: uploadFilename("full", opened.result.full.ext),
        limits,
        compressible: opened.result.full.ext === "wav" || opened.result.full.ext === "aiff",
        source: entrySource(entry, { name: uploadFilename("full", opened.result.full.ext), lastModified: file.lastModified || 0 }),
        close: () => opened.reader.close(),
      };
    }
  } else {
    await opened.reader.close().catch(() => {});
  }
  let cover = null;
  if (opened.result.cover) cover = await readSmall(zip, opened.entries, opened.result.cover, opened.result.cover.path.split("/").pop());
  let sidecar = { ok: true, fields: {}, warnings: [] };
  if (opened.result.sidecar) {
    const read = await readSmall(zip, opened.entries, opened.result.sidecar, opened.result.sidecar.path.split("/").pop());
    sidecar = parseSidecar(new TextDecoder("utf-8", { fatal: false }).decode(read.bytes));
  }
  return {
    ok: true,
    path: fullPlan ? "chunked" : "single",
    limits,
    result: opened.result,
    preview,
    full,
    fullPlan,
    cover,
    sidecar,
  };
}

export async function inspectLoosePackage(files, { protocol }) {
  const limitsResult = await protocol.fetchLimits();
  if (!limitsResult.ok) {
    const error = new Error(limitsResult.message || "Large upload is not available.");
    error.code = limitsResult.code || "LARGE_UPLOAD_UNSUPPORTED";
    throw error;
  }
  const limits = limitsResult.limits;
  const entries = files.map((file) => ({
    originalName: file.name,
    zipName: file.name,
    dir: false,
    uncompressedSize: file.size,
    compressedSize: file.size,
    unixPermissions: null,
  }));
  const result = validateZipEntries(entries, zipLimitsFromServer(limits));
  if (!result.ok) return { ok: false, errors: result.errors, code: "ZIP_UNSAFE" };
  if (limits.previewMaxBytes != null && result.preview.size > limits.previewMaxBytes) {
    return { ok: false, code: "LIMIT_EXCEEDED", errors: ["This preview is larger than the server preview limit. Nothing was published."] };
  }
  const byName = new Map(files.map((file) => [file.name, file]));
  const previewFile = byName.get(result.preview.path);
  const previewHead = await readHead(previewFile);
  const previewVerdict = magicAllowlist(result.preview.ext, previewHead);
  if (!previewVerdict.ok) return { ok: false, errors: [previewVerdict.error], code: "MAGIC_MISMATCH" };
  const preview = {
    file: new File([previewFile], uploadFilename("preview", result.preview.ext), { type: previewVerdict.mime, lastModified: previewFile.lastModified }),
    path: result.preview.path,
    mime: previewVerdict.mime,
  };
  let full = null;
  let fullPlan = null;
  if (result.full) {
    const fullFile = byName.get(result.full.path);
    const fullPath = choosePath({ size: fullFile.size, isBeatboxZip: false, limits });
    if (fullPath.path === "reject") {
      return { ok: false, code: fullPath.code, errors: ["This file failed a safety check and was not saved. Nothing was published."] };
    }
    const uploadName = uploadFilename("full", result.full.ext);
    if (fullPath.path === "single") {
      full = {
        file: new File([fullFile], uploadName, { type: fullFile.type || "application/octet-stream", lastModified: fullFile.lastModified }),
        path: result.full.path,
      };
    } else {
      const source = blobSource(fullFile);
      source.name = uploadName;
      fullPlan = {
        path: "chunked",
        kind: "full",
        name: uploadName,
        limits,
        compressible: result.full.ext === "wav" || result.full.ext === "aiff",
        source,
      };
    }
  }
  let cover = null;
  if (result.cover) {
    const coverFile = byName.get(result.cover.path);
    const coverHead = await readHead(coverFile);
    const verdict = magicAllowlist(result.cover.ext, coverHead);
    if (!verdict.ok) return { ok: false, errors: [verdict.error], code: "MAGIC_MISMATCH" };
    cover = { bytes: new Uint8Array(await coverFile.arrayBuffer()), mime: verdict.mime };
  }
  let sidecar = { ok: true, fields: {}, warnings: [] };
  if (result.sidecar) {
    const sidecarFile = byName.get(result.sidecar.path);
    const bytes = new Uint8Array(await sidecarFile.arrayBuffer());
    const verdict = magicAllowlist("json", bytes);
    if (!verdict.ok) return { ok: false, errors: [verdict.error], code: "MAGIC_MISMATCH" };
    sidecar = parseSidecar(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
  }
  return { ok: true, path: fullPlan ? "chunked" : "single", limits, result, preview, full, fullPlan, cover, sidecar };
}
