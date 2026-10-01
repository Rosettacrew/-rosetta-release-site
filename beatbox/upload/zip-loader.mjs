const ZIP_URL = new URL("../../vendor/zipjs-2.18.2/zip.min.js", import.meta.url);

let loading;

export async function loadZipJs() {
  if (globalThis.zip?.ZipReader) return globalThis.zip;
  if (!loading) {
    loading = import(ZIP_URL.href).then((mod) => {
      const api = mod?.ZipReader ? mod : mod?.default?.ZipReader ? mod.default : globalThis.zip;
      if (!api?.ZipReader) throw new Error("zip.js did not expose ZipReader");
      if (typeof api.configure === "function") api.configure({ useWebWorkers: false });
      return api;
    });
  }
  return loading;
}
