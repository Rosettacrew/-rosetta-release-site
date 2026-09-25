/**
 * Issue #91: Supabase adapters for upload-sessions.mjs (Free plan, Option A).
 * A Pro/TUS or R2/S3 adapter can implement the same two interfaces later.
 * No secrets live here: the service key is passed in at runtime by the Edge Function.
 */

const CHUNK_INSERT_BATCH = 500;
const REMOVE_BATCH = 100;
const LIST_PAGE = 1000;
const DEFAULT_SIGNED_UPLOAD_TTL = 7200; // Storage default when a custom expiresIn is not honoured.

/** DB adapter over supabase-js (service role). Tables are service_role-only. */
export function createSupabaseUploadDb(supabase) {
  const one = async (query) => {
    const { data, error } = await query;
    if (error) throw error;
    return data;
  };
  return {
    async getLimits() {
      return one(supabase.from("upload_limits").select("*").eq("id", 1).maybeSingle());
    },
    async storageUsage(bucketIds) {
      const data = await one(supabase.rpc("upload_storage_usage", { p_bucket_ids: bucketIds ?? null }));
      const row = Array.isArray(data) ? data[0] : data;
      return { used_bytes: Number(row?.used_bytes ?? 0), reserved_bytes: Number(row?.reserved_bytes ?? 0) };
    },
    async findResumable(key) {
      const rows = await one(supabase.from("upload_sessions").select("*")
        .eq("created_by", key.created_by).eq("beat_id", key.beat_id).eq("kind", key.kind)
        .eq("total_bytes", key.total_bytes).eq("head_sha256", key.head_sha256).eq("encoding", key.encoding)
        .eq("chunk_bytes", key.chunk_bytes).in("status", ["open", "complete", "verified"])
        .order("created_at", { ascending: false }).limit(1));
      return rows?.[0] ?? null;
    },
    async insertSession(row, chunks) {
      const { error } = await supabase.from("upload_sessions").insert(row);
      if (error) {
        if (error.code === "23505") return null; // idempotency race
        throw error;
      }
      try {
        for (let i = 0; i < chunks.length; i += CHUNK_INSERT_BATCH) {
          const { error: chunkError } = await supabase.from("upload_chunks").insert(chunks.slice(i, i + CHUNK_INSERT_BATCH));
          if (chunkError) throw chunkError;
        }
      } catch (chunkError) {
        await supabase.from("upload_sessions").delete().eq("id", row.id);
        throw chunkError;
      }
      return row;
    },
    async getSession(id) {
      return one(supabase.from("upload_sessions").select("*").eq("id", id).maybeSingle());
    },
    async casSession(id, fromStatuses, patch) {
      return one(supabase.from("upload_sessions").update(patch).eq("id", id).in("status", fromStatuses).select("*").maybeSingle());
    },
    async updateSession(id, patch) {
      await one(supabase.from("upload_sessions").update(patch).eq("id", id).select("id"));
    },
    async listChunks(id) {
      return one(supabase.from("upload_chunks").select("*").eq("session_id", id).order("idx"));
    },
    async getChunk(id, idx) {
      return one(supabase.from("upload_chunks").select("*").eq("session_id", id).eq("idx", idx).single());
    },
    async updateChunk(id, idx, patch, { notStatus } = {}) {
      let q = supabase.from("upload_chunks").update({ ...patch, updated_at: new Date().toISOString() }).eq("session_id", id).eq("idx", idx);
      if (notStatus) q = q.neq("status", notStatus);
      const rows = await one(q.select("idx"));
      return (rows ?? []).length > 0;
    },
    async countOpenSessions(userId, nowIso) {
      const { count, error } = await supabase.from("upload_sessions").select("id", { count: "exact", head: true })
        .eq("created_by", userId).in("status", ["open", "complete"]).gt("expires_at", nowIso);
      if (error) throw error;
      return count ?? 0;
    },
    async listCleanupCandidates(nowIso, limit) {
      return one(supabase.from("upload_sessions").select("id,status,storage_prefix,expires_at,parts_purged_at")
        .neq("status", "attached")
        .or(`and(status.in.(open,complete,verified),expires_at.lt."${nowIso}"),and(status.in.(failed,aborted,expired),parts_purged_at.is.null)`)
        .order("expires_at").limit(limit));
    },
    async existingSessionIds(ids) {
      if (!ids.length) return [];
      const rows = await one(supabase.from("upload_sessions").select("id").in("id", ids));
      return (rows ?? []).map((r) => r.id);
    },
    async getBeat(id) {
      return one(supabase.from("beatbay_beats").select("*").eq("id", id).maybeSingle());
    },
    async updateBeat(id, patch) {
      return one(supabase.from("beatbay_beats").update(patch).eq("id", id).select("*").single());
    },
    async upsertBeatAsset(row) {
      await one(supabase.from("beatbay_beat_assets").upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: "beat_id,kind" }).select("beat_id"));
    },
  };
}

/** Storage adapter bound to ONE private bucket (release-private). */
export function createSupabaseUploadStorage({ supabase, url, key, bucket }) {
  const store = () => supabase.storage.from(bucket);
  return {
    async signUpload(path, expiresIn) {
      const encoded = path.split("/").map((part) => encodeURIComponent(part)).join("/");
      const attempt = async (body) => {
        const response = await fetch(`${url}/storage/v1/object/upload/sign/${bucket}/${encoded}`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, apikey: key, "content-type": "application/json", "x-upsert": "false" },
          body: JSON.stringify(body),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload?.url) return null;
        const signed = new URL(`${url}/storage/v1${String(payload.url)}`);
        const token = signed.searchParams.get("token");
        return token ? { signedUrl: signed.toString(), token } : null;
      };
      const custom = await attempt({ expiresIn });
      if (custom) return { ...custom, expiresIn };
      const fallback = await attempt({});
      // Report the smaller value so clients refresh early rather than late.
      return fallback ? { ...fallback, expiresIn: Math.min(expiresIn, DEFAULT_SIGNED_UPLOAD_TTL) } : null;
    },
    async download(path) {
      const { data, error } = await store().download(path);
      if (error || !data) return null;
      return new Uint8Array(await data.arrayBuffer());
    },
    async upload(path, bytes, contentType, upsert = false) {
      const { error } = await store().upload(path, bytes, { contentType, upsert });
      return !error;
    },
    async list(prefix) {
      const out = [];
      for (let offset = 0; ; offset += LIST_PAGE) {
        const { data, error } = await store().list(prefix, { limit: LIST_PAGE, offset, sortBy: { column: "name", order: "asc" } });
        if (error) throw error;
        out.push(...(data ?? []).map((o) => ({ name: o.name, created_at: o.created_at ?? null, size: o.metadata?.size ?? null })));
        if (!data || data.length < LIST_PAGE) break;
      }
      return out;
    },
    async remove(paths) {
      for (let i = 0; i < paths.length; i += REMOVE_BATCH) {
        const { error } = await store().remove(paths.slice(i, i + REMOVE_BATCH));
        if (error) throw error;
      }
    },
    async signDownloads(paths, ttlSeconds) {
      const { data, error } = await store().createSignedUrls(paths, ttlSeconds, { download: true });
      if (error) throw error;
      const byPath = new Map((data ?? []).map((d) => [d.path, d.signedUrl]));
      return paths.map((p) => byPath.get(p) ?? null);
    },
  };
}
