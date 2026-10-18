const HASH_URL = new URL("../../vendor/hash-wasm-4.12.0/sha256.umd.min.js", import.meta.url);

let loading;

export function bytesToHex(bytes) {
  const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  let hex = "";
  for (let index = 0; index < view.length; index += 1) hex += view[index].toString(16).padStart(2, "0");
  return hex;
}

export function bytesToBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let index = 0; index < view.length; index += 1) binary += String.fromCharCode(view[index]);
  return btoa(binary);
}

export function base64ToBytes(value) {
  const binary = atob(String(value || ""));
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

export async function sha256Hex(bytes) {
  const view = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const digest = await crypto.subtle.digest("SHA-256", view);
  return bytesToHex(digest);
}

async function loadHashWasm() {
  if (globalThis.hashwasm?.createSHA256) return globalThis.hashwasm;
  if (!loading) {
    loading = import(HASH_URL.href).then((mod) => {
      if (mod?.createSHA256) return mod;
      if (mod?.default?.createSHA256) return mod.default;
      if (globalThis.hashwasm?.createSHA256) return globalThis.hashwasm;
      throw new Error("hash-wasm did not expose createSHA256");
    });
  }
  return loading;
}

export async function createIncrementalSha256() {
  const api = await loadHashWasm();
  const hasher = await api.createSHA256();
  return {
    update(bytes) {
      hasher.update(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    },
    save() {
      return hasher.save();
    },
    load(state) {
      hasher.load(state instanceof Uint8Array ? state : new Uint8Array(state));
    },
    digest() {
      return hasher.digest("hex");
    },
  };
}
