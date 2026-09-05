import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type,x-client-info",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

const FINANCE_OR_OWNER_ACTIONS = new Set([
  "analytics",
  "orders",
  "deliveries",
  "downloads",
  "activity",
  "overview",
  "publish",
  "unpublish",
  "set_featured",
  "create_release",
  "update_release",
  "create_checkout",
  "claim_owner",
  "grant_uploader",
  "assign_uploader",
  "unassign_uploader",
  "save_auction",
  "promote",
  "social",
]);

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "content-type": "application/json", "cache-control": "no-store" },
  });
}

function adminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const secretJson = Deno.env.get("SUPABASE_SECRET_KEYS");
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const key = secretJson ? JSON.parse(secretJson)?.default : legacy;
  if (!url || !key) throw new Error("Studio backend unavailable");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function slugify(input: string) {
  return input.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
}

function safeExt(filename: string) {
  return filename.includes(".") ? filename.split(".").pop()!.toLowerCase().replace(/[^a-z0-9]/g, "") : "bin";
}

async function requireMusicUploader(req: Request, supabase: ReturnType<typeof adminClient>) {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!token) return null;
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user) return null;
  const { data: admin, error } = await supabase
    .from("release_admin_users")
    .select("user_id,role,is_active")
    .eq("user_id", userData.user.id)
    .eq("is_active", true)
    .maybeSingle();
  if (error || !admin || admin.role !== "music_uploader") return null;
  return { user: userData.user, admin };
}

async function assignedProductIds(
  supabase: ReturnType<typeof adminClient>,
  userId: string,
) {
  const { data, error } = await supabase
    .from("release_product_assignees")
    .select("product_id")
    .eq("user_id", userId);
  if (error) throw error;
  return (data ?? []).map((row: { product_id: string }) => row.product_id);
}

async function requireAssignedProduct(
  supabase: ReturnType<typeof adminClient>,
  userId: string,
  productId: string,
) {
  if (!productId) return false;
  const { data, error } = await supabase
    .from("release_product_assignees")
    .select("product_id")
    .eq("user_id", userId)
    .eq("product_id", productId)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

function publicLibraryItem(release: any) {
  const tracks = (release.tracks ?? []).map((track: any) => ({
    id: track.id,
    track_number: track.track_number,
    title: track.title,
    audio_attached: !!(track.audio_bucket && track.audio_object_path),
  }));
  return {
    id: release.id,
    artist_name: release.artist_name,
    title: release.title,
    product_type: release.product_type,
    status: release.status,
    release_at: release.release_at,
    cover_attached: !!release.cover_art_path,
    preview_attached: !!release.preview_path,
    package_attached: !!release.storage_object_path,
    tracks,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const supabase = adminClient();
    const session = await requireMusicUploader(req, supabase);
    if (!session) return json({ error: "Music Studio access required" }, 403);

    let body: any = null;
    if (req.method === "POST") body = await req.json();
    const action = String(body?.action ?? "");
    const view = req.method === "GET" ? (new URL(req.url).searchParams.get("view") ?? "library") : "";

    if (FINANCE_OR_OWNER_ACTIONS.has(action) || FINANCE_OR_OWNER_ACTIONS.has(view)) {
      return json({ error: "Forbidden" }, 403);
    }

    if (req.method === "GET") {
      if (view === "whoami") {
        return json({
          portal: "music_studio",
          role: session.admin.role,
          email: session.user.email ?? null,
        });
      }
      if (view !== "library") return json({ error: "Forbidden" }, 403);

      const ids = await assignedProductIds(supabase, session.user.id);
      if (!ids.length) return json({ releases: [], role: session.admin.role });

      const { data, error } = await supabase
        .from("release_products")
        .select("id,artist_name,title,product_type,status,release_at,cover_art_path,preview_path,storage_object_path,tracks:release_tracks(id,track_number,title,audio_bucket,audio_object_path)")
        .in("id", ids)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return json({
        releases: (data ?? []).map(publicLibraryItem),
        role: session.admin.role,
      });
    }

    if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405);

    if (action === "signed_upload") {
      const productId = String(body.product_id ?? "");
      const kind = String(body.kind ?? "");
      const filename = String(body.filename ?? "").trim();
      if (!productId || !filename || !["cover", "track", "preview", "package"].includes(kind)) {
        return json({ error: "product_id, filename and valid kind are required" }, 400);
      }
      if (!(await requireAssignedProduct(supabase, session.user.id, productId))) {
        return json({ error: "Forbidden" }, 403);
      }
      const ext = safeExt(filename);
      if (kind === "cover" && !["jpg", "jpeg", "png", "webp"].includes(ext)) {
        return json({ error: "Cover art must be JPG, PNG, or WebP" }, 400);
      }
      if ((kind === "track" || kind === "preview") && !["mp3", "wav"].includes(ext)) {
        return json({ error: "Audio must be MP3 or WAV" }, 400);
      }
      if (kind === "package" && ext !== "zip") return json({ error: "Release package must be ZIP" }, 400);

      let path: string;
      let bucket = "release-private";
      if (kind === "cover") {
        bucket = "release-public";
        path = `${productId}/cover/cover-${crypto.randomUUID()}.${ext}`;
      } else if (kind === "preview") {
        path = `${productId}/preview/preview-${crypto.randomUUID()}.${ext}`;
      } else if (kind === "package") {
        path = `${productId}/package/release-${crypto.randomUUID()}.${ext}`;
      } else {
        path = String(body.object_path ?? `${productId}/tracks/${crypto.randomUUID()}.${ext}`);
      }

      const { data, error } = await supabase.storage.from(bucket).createSignedUploadUrl(path, { upsert: false });
      if (error) throw error;
      return json({
        bucket,
        path,
        token: data.token,
        signed_url: data.signedUrl,
        public_url: bucket === "release-public"
          ? `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/${bucket}/${path}`
          : null,
      });
    }

    if (action === "add_track") {
      const productId = String(body.product_id ?? "");
      const title = String(body.title ?? "").trim();
      const trackNumber = Number(body.track_number);
      if (!productId || !title || !Number.isInteger(trackNumber) || trackNumber < 1) {
        return json({ error: "product_id, title and track_number are required" }, 400);
      }
      if (!(await requireAssignedProduct(supabase, session.user.id, productId))) {
        return json({ error: "Forbidden" }, 403);
      }
      const ext = safeExt(body.filename ?? "audio.mp3");
      const safeName = slugify(String(body.filename ?? `${trackNumber}-${title}`).replace(/\.[^.]+$/, "")) || `track-${trackNumber}`;
      const path = `${productId}/tracks/${String(trackNumber).padStart(2, "0")}-${safeName}.${ext}`;
      const payload = {
        product_id: productId,
        track_number: trackNumber,
        title,
        version: body.version ?? null,
        explicit: !!body.explicit,
        audio_bucket: "release-private",
        audio_object_path: path,
        is_downloadable: body.is_downloadable !== false,
        metadata: body.metadata ?? {},
      };
      const { data, error } = await supabase.from("release_tracks").upsert(payload, { onConflict: "product_id,track_number" }).select("id,product_id,track_number,title,audio_object_path").single();
      if (error) throw error;
      return json({ track: data });
    }

    if (action === "attach_asset") {
      const productId = String(body.product_id ?? "");
      const kind = String(body.kind ?? "");
      const path = String(body.path ?? "");
      if (!productId || !path) return json({ error: "product_id and path are required" }, 400);
      if (!(await requireAssignedProduct(supabase, session.user.id, productId))) {
        return json({ error: "Forbidden" }, 403);
      }
      const changes: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (kind === "cover") {
        changes.cover_art_path = path;
        changes.cover_art_bucket = "release-public";
      } else if (kind === "preview") {
        changes.preview_path = path;
      } else if (kind === "package") {
        changes.storage_object_path = path;
        changes.delivery_filename = body.delivery_filename ?? path.split("/").pop();
      } else {
        return json({ error: "Invalid asset kind" }, 400);
      }
      const { data, error } = await supabase
        .from("release_products")
        .update(changes)
        .eq("id", productId)
        .select("id,artist_name,title,cover_art_path,preview_path,storage_object_path")
        .single();
      if (error) throw error;
      return json({ release: publicLibraryItem({ ...data, tracks: [] }) });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
