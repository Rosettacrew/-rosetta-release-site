export function formatBytes(size) {
  const bytes = Number(size) || 0;
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;
export const STORAGE_WARN_RATIO = 0.8;

function trimFixed(value, digits) {
  return value.toFixed(digits).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

export function formatStorageBytes(size) {
  const bytes = Number(size) || 0;
  if (bytes >= GB) return `${trimFixed(bytes / GB, 2)} GB`;
  if (bytes >= MB) return `${trimFixed(bytes / MB, 1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function storageUsageLine(storage) {
  if (!storage || storage.usedBytes == null || storage.quotaBytes == null) return "";
  const used = `Storage: ${formatStorageBytes(storage.usedBytes)} of ${formatStorageBytes(storage.quotaBytes)} used`;
  if (storage.remainingBytes == null) return used;
  return `${used} · ${formatStorageBytes(storage.remainingBytes)} left`;
}

export function storageOutlook(storage, incomingBytes = 0) {
  if (!storage || storage.usedBytes == null || storage.quotaBytes == null) return { level: "unknown" };
  const incoming = Number(incomingBytes) || 0;
  const reserved = Number(storage.reservedBytes) || 0;
  const projected = storage.usedBytes + reserved + incoming;
  if (!(storage.quotaBytes > 0) || projected > storage.quotaBytes) return { level: "block", projected };
  if (projected / storage.quotaBytes > STORAGE_WARN_RATIO) return { level: "warn", projected };
  return { level: "ok", projected };
}

export function storageWarningMessage(storage, incomingBytes = 0) {
  const outlook = storageOutlook(storage, incomingBytes);
  const projected = formatStorageBytes(outlook.projected ?? 0);
  const quota = formatStorageBytes(storage?.quotaBytes ?? 0);
  return `Storage warning: this upload would use ${projected} of ${quota}, past 80%. You can continue. The plan will need upgrading when storage gets full.`;
}

export function storageFullMessage(storage) {
  const usage = storageUsageLine(storage);
  const where = usage ? ` (${usage.replace(/^Storage: /, "")})` : "";
  return `Storage is full${where}. The plan needs upgrading before more files can be saved. Nothing was published.`;
}

export const STORAGE_FULL_COPY = storageFullMessage(null);

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return "about 1 min left";
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `about ${minutes} min left`;
}

export function statusMessage(state = {}) {
  const name = state.name || "file";
  const phase = state.phase || "analyzing";
  if (phase === "analyzing") return `Checking ${name} (${formatBytes(state.size)})…`;
  if (phase === "compress-trial") return "Seeing if this file can be made smaller…";
  if (phase === "compress-skip") {
    if (state.reason === "already-compressed") return "Already compact, sending as is.";
    return `Compression skipped${state.reason ? `: ${state.reason}` : ""}.`;
  }
  if (phase === "compressing") return `Compressing ${name}…`;
  if (phase === "preparing") {
    const parts = state.parts || 0;
    const percent = state.ratio == null ? "" : ` ${Math.round(state.ratio * 100)}%`;
    if (state.hashMode === "upfront") return `Checking file…${percent}`;
    return parts ? `Large file detected. Beatbox is preparing ${parts} upload parts.${percent}` : `Large file detected. Beatbox is preparing the upload.${percent}`;
  }
  if (phase === "uploading") {
    const part = state.part || 0;
    const parts = state.parts || 0;
    const percent = `${Math.round((state.ratio || 0) * 100)}%`;
    const eta = formatEta(state.etaSeconds);
    return `Uploading part ${part} of ${parts} · ${percent}${eta ? ` · ${eta}` : ""}`;
  }
  if (phase === "retrying") {
    const max = state.maxAttempts || 5;
    return `Part ${state.part} failed, retrying (${state.attempt} of ${max})…`;
  }
  if (phase === "offline" || phase === "paused-offline") return "Paused. Waiting for connection.";
  if (phase === "paused") return "Paused.";
  if (phase === "resumable") return `Resume ${name}: choose the same file again.`;
  if (phase === "verifying") return "All parts received. Checking integrity…";
  if (phase === "verified") return "Integrity verified ✓. Continuing to review.";
  if (phase === "restart") return "This upload expired. Start again.";
  if (phase === "cancelled") return "Upload cancelled. Nothing was published.";
  if (phase === "storage-warning") return state.detail || state.storageWarning || "This upload would use more than 80% of storage.";
  if (phase === "storage-full") return state.detail || storageFullMessage(state.storage);
  if (phase === "failed") return state.detail || "This file failed a safety check and was not saved. Nothing was published.";
  return state.detail || "Working…";
}

export const FAIL_CLOSED_COPY = "This file failed a safety check and was not saved. Nothing was published.";
export const FILE_CHANGED_COPY = "This file changed. Start over.";
