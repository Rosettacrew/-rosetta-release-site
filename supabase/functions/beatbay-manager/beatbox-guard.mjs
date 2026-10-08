/** Re-export so existing imports keep resolving. Implementation lives in _shared. */
export {
  QUARANTINE_UPLOAD_TTL_SECONDS,
  PRIVATE_DOWNLOAD_TTL_SECONDS,
  SANDBOX_PREFIX,
  MAX_AUDIO_BYTES,
  isPublicApiCredential,
  isUuid,
  sandboxedExtractPath,
  isQuarantinePath,
  executableMagic,
  magicAllowlist,
  redactLog,
} from "../_shared/beatbox-guard.mjs";
