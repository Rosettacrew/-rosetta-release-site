/**
 * music_uploader beat writes that change an asset.
 * A pre-read of status is not the boundary. The write is one SQL UPDATE
 * in commit_music_uploader_beat_update (service_role only).
 * No network and no secrets.
 *
 * NULL storefront_enabled is treated as false (off the storefront), matching
 * coalesce(storefront_enabled, false) in the RPC. A draft with a NULL flag
 * is eligible. A true flag is not.
 */

export const MUSIC_UPLOADER_BEAT_UPDATE_RPC = "commit_music_uploader_beat_update";

/** Fast reject only. The RPC is the write boundary. */
export function preReadAllowsMusicUploaderBeat(beat) {
  return !!beat && beat.status === "draft" && beat.storefront_enabled !== true;
}

export function statusForMatchedBeatUpdate(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { status: 403, error: "Forbidden", row: null };
  }
  return { status: 200, error: null, row: data };
}

export async function commitMusicUploaderBeatUpdate(supabase, { beatId, userId, changes }) {
  const { data, error } = await supabase.rpc(MUSIC_UPLOADER_BEAT_UPDATE_RPC, {
    p_beat_id: beatId,
    p_user_id: userId,
    p_changes: changes ?? {},
  });
  if (error) throw error;
  return statusForMatchedBeatUpdate(data);
}
