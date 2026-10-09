import { validateZipEntries } from "../package-rules.mjs";
import { loadZipJs } from "./zip-loader.mjs";

export function zipJsEntryToView(entry) {
  const attributes = entry?.externalFileAttributes;
  const mode = attributes == null || attributes === "" ? null : (Number(attributes) >>> 16);
  const directory = !!entry?.directory;
  return {
    originalName: String(entry?.filename ?? ""),
    zipName: String(entry?.filename ?? ""),
    dir: directory,
    uncompressedSize: directory ? 0 : Number(entry?.uncompressedSize),
    compressedSize: directory ? 0 : Number(entry?.compressedSize),
    unixPermissions: mode,
    compressionMethod: entry?.compressionMethod,
    offset: entry?.offset,
  };
}

export async function readCentralDirectory(file, zipApi) {
  const zip = zipApi || await loadZipJs();
  const reader = new zip.ZipReader(new zip.BlobReader(file), { filenameValidation: "tolerant" });
  try {
    const entries = await reader.getEntries({ filenameValidation: "tolerant" });
    return { reader, entries, views: entries.map(zipJsEntryToView) };
  } catch (error) {
    await reader.close().catch(() => {});
    const message = String(error?.message || "");
    if (/unsafe|filename|path/i.test(message) || error?.code === "ERR_UNSAFE_FILENAME") {
      const wrapped = new Error("This file failed a safety check and was not saved. Nothing was published.");
      wrapped.code = "ZIP_UNSAFE";
      throw wrapped;
    }
    throw error;
  }
}

export async function preflightZip(file, limits, zipApi) {
  const opened = await readCentralDirectory(file, zipApi);
  try {
    const result = validateZipEntries(opened.views, limits);
    return { ...opened, result };
  } catch (error) {
    await opened.reader.close().catch(() => {});
    throw error;
  }
}

export async function closeZip(opened) {
  if (opened?.reader?.close) await opened.reader.close();
}
