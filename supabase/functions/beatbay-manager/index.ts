import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  MAX_AUDIO_BYTES,
  QUARANTINE_UPLOAD_TTL_SECONDS,
  PRIVATE_DOWNLOAD_TTL_SECONDS,
  isPublicApiCredential,
  isQuarantinePath,
  isUuid,
  magicAllowlist,
  redactLog,
} from "./beatbox-guard.mjs";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type,x-client-info",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...cors, "content-type": "application/json" } });

function serviceCredentials() {
  const url = Deno.env.get("SUPABASE_URL");
  const secretJson = Deno.env.get("SUPABASE_SECRET_KEYS");
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const key = secretJson ? JSON.parse(secretJson)?.default : legacy;
  if (!url || !key) throw new Error("Supabase admin credentials unavailable");
  return { url, key };
}

function client() {
  const { url, key } = serviceCredentials();
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function logSafe(error: unknown) {
  const message = error instanceof Error ? error.message : "request failed";
  console.error(redactLog(message));
}

async function requireTeam(req: Request, supabase: ReturnType<typeof client>) {
  const header = req.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  // Publishable, anon, and secret keys are not team sessions. Fail closed before getUser.
  if (isPublicApiCredential(token, req.headers.get("apikey") ?? "")) return { ok: false as const, status: 401 as const };
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user) return { ok: false as const, status: 401 as const };
  const { data: admin, error } = await supabase.from("release_admin_users")
    .select("user_id,role,is_active").eq("user_id", userData.user.id).eq("is_active", true).maybeSingle();
  // music_uploader is intentionally excluded. Partners use studio-manager only.
  if (error || !admin || !["owner", "admin", "staff"].includes(admin.role)) return { ok: false as const, status: 403 as const };
  return { ok: true as const, user: userData.user, admin };
}

async function signPrivateUpload(bucket: string, objectPath: string, expiresIn: number | null) {
  const { url, key } = serviceCredentials();
  const encoded = objectPath.split("/").map((part) => encodeURIComponent(part)).join("/");
  const response = await fetch(`${url}/storage/v1/object/upload/sign/${bucket}/${encoded}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      apikey: key,
      "content-type": "application/json",
    },
    body: JSON.stringify(expiresIn ? { expiresIn } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.url) return null;
  const signed = new URL(`${url}/storage/v1${String(payload.url)}`);
  const uploadToken = signed.searchParams.get("token");
  if (!uploadToken) return null;
  return { signedUrl: signed.toString(), token: uploadToken };
}

const isOwner = (session: any) => ["owner", "admin"].includes(session?.admin?.role);
const dollars = (value: unknown) => {
  if (value === "" || value === null || value === undefined) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new Error("Price must be a valid positive amount");
  return Math.round(amount * 100);
};
const integer = (value: unknown) => value === "" || value === null || value === undefined ? null : Math.round(Number(value));
const safeExt = (name: string) => name.includes(".") ? name.split(".").pop()!.toLowerCase().replace(/[^a-z0-9]/g, "") : "bin";

// Beatbox intake records a draft listing. It must never enable the storefront.
// Publishing stays on set_storefront, which remains owner/admin only.
function beatboxLicenseChanges(body: any): { error?: string; changes?: Record<string, unknown> } {
  try {
    const nonexclusive = body.nonexclusive_enabled !== false;
    const exclusive = body.exclusive_enabled === true;
    const ownership = body.ownership_enabled === true;
    const nonexclusivePrice = dollars(nonexclusive ? (body.nonexclusive_price ?? "30") : "");
    if (nonexclusive && nonexclusivePrice === null) return { error: "Non-exclusive price is required" };
    return {
      changes: {
        signature_sound: false,
        nonexclusive_enabled: nonexclusive,
        nonexclusive_price_cents: nonexclusive ? nonexclusivePrice : null,
        exclusive_enabled: exclusive,
        exclusive_price_cents: exclusive ? dollars(body.exclusive_price) : null,
        ownership_enabled: ownership,
        ownership_price_cents: ownership ? dollars(body.ownership_price) : null,
      },
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Invalid license price" };
  }
}

async function activityReport(
  supabase: ReturnType<typeof client>,
  session: any,
  input: { action: string; entityType: string; entityId?: string | null; summary: string; details?: Record<string, unknown> },
) {
  try {
    const { data: event, error } = await supabase.from("music_activity_log").insert({
      actor_user_id: session.user.id,
      actor_email: session.user.email ?? null,
      actor_role: session.admin.role,
      surface: "beatbay",
      action: input.action,
      entity_type: input.entityType,
      entity_id: input.entityId ?? null,
      summary: input.summary,
      details: input.details ?? {},
    }).select("id,created_at").single();
    if (error || !event || session.admin.role !== "music_uploader") return;
    const apiKey = Deno.env.get("RESEND_API_KEY");
    const from = Deno.env.get("ACTIVITY_EMAIL_FROM");
    let recipients = (Deno.env.get("OWNER_ACTIVITY_EMAIL") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    if (!recipients.length) {
      const { data: owners } = await supabase.from("release_admin_users").select("user_id").eq("role", "owner").eq("is_active", true);
      for (const owner of owners ?? []) {
        const { data } = await supabase.auth.admin.getUserById(owner.user_id);
        if (data.user?.email) recipients.push(data.user.email);
      }
    }
    recipients = [...new Set(recipients)];
    if (!apiKey || !from || !recipients.length) {
      await supabase.from("music_activity_log").update({ email_status: "not_configured" }).eq("id", event.id);
      return;
    }
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from,
        to: recipients,
        subject: `[Rosetta Crew] ${input.summary}`,
        text: `${session.user.email ?? "Music uploader"} completed this action:\n\n${input.summary}\n\nArea: BeatBay\nTime: ${event.created_at}\n\nReview the permanent Activity Report in the owner dashboard.`,
      }),
    });
    await supabase.from("music_activity_log").update(response.ok
      ? { email_status: "sent", email_sent_at: new Date().toISOString(), email_error: null }
      : { email_status: "failed", email_error: redactLog(await response.text()) }
    ).eq("id", event.id);
  } catch (error) {
    logSafe(error);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const supabase = client();
    const gate = await requireTeam(req, supabase);
    if (!gate.ok) return json({ error: gate.status === 403 ? "Forbidden" : "Unauthorized" }, gate.status);
    const session = gate;
    const ownerAccess = isOwner(session);

    if (req.method === "GET") {
      if (ownerAccess) {
        const { data: beats, error: beatError } = await supabase.from("beatbay_beats").select("*").order("beat_code");
        if (beatError) throw beatError;
        const { data: auctions, error: auctionError } = await supabase.from("beatbay_auctions")
          .select("*, beat:beatbay_beats(id,beat_code,title)").order("created_at", { ascending: false });
        if (auctionError) throw auctionError;
        return json({ beats, auctions, role: session.admin.role });
      }
      const { data: beats, error: beatError } = await supabase.from("beatbay_beats")
        .select("id,beat_code,title,producer,style,bpm,musical_key,description,tags,status,storefront_enabled,preview_url,preview_duration_seconds,preview_pattern,full_audio_path,metadata_source,created_at,updated_at")
        .order("beat_code");
      if (beatError) throw beatError;
      const { data: auctions, error: auctionError } = await supabase.from("beatbay_auctions")
        .select("id,beat_id,status,starting_bid_cents,minimum_increment_cents,reserve_price_cents,starts_at,ends_at,created_at,updated_at,beat:beatbay_beats(id,beat_code,title)")
        .order("created_at", { ascending: false });
      if (auctionError) throw auctionError;
      const safeBeats = (beats ?? []).map(({ full_audio_path, ...beat }: any) => ({ ...beat, has_full_audio: !!full_audio_path }));
      return json({ beats: safeBeats, auctions, role: session.admin.role });
    }
    if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
    const body = await req.json();
    const action = String(body.action ?? "");

    if (action === "save_beat") {
      const id = String(body.id ?? "").trim();
      const beatCode = String(body.beat_code ?? "").trim().toUpperCase();
      const title = String(body.title ?? "").trim();
      const beatboxIntake = body.intake === "beatbox";
      if (beatboxIntake && body.storefront_enabled === true) return json({ error: "Beatbox cannot publish from save. Use Approve & publish." }, 400);
      if (!/^BEAT [0-9]{4}$/.test(beatCode)) return json({ error: "Beat number must look like BEAT 0000" }, 400);
      if (!title) return json({ error: "Beat title is required" }, 400);
      const bpm = integer(body.bpm);
      if (bpm !== null && (bpm < 40 || bpm > 240)) return json({ error: "BPM must be between 40 and 240" }, 400);
      const musicChanges: Record<string, unknown> = {
        beat_code: beatCode,
        title,
        producer: String(body.producer || "Rosetta Crew Music Group").trim(),
        style: String(body.style ?? "").trim() || null,
        bpm,
        metadata_source: beatboxIntake ? "beatbox" : String(body.metadata_source || "manual"),
        musical_key: String(body.musical_key ?? "").trim() || null,
        description: String(body.description ?? "").trim() || null,
        tags: String(body.tags ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean),
      };
      let ownerChanges: Record<string, any> = {};
      if (beatboxIntake) {
        const status = String(body.status || "draft");
        if (ownerAccess && !["draft", "available"].includes(status)) return json({ error: "Beatbox can only save a draft or mark a beat Available" }, 400);
        const licenses = beatboxLicenseChanges(body);
        if (licenses.error) return json({ error: licenses.error }, 400);
        ownerChanges = { ...licenses.changes, status: ownerAccess ? status : "draft" };
      } else if (ownerAccess) {
        ownerChanges = {
          signature_sound: body.signature_sound === true,
          status: String(body.status || "draft"),
          nonexclusive_enabled: body.nonexclusive_enabled !== false,
          nonexclusive_price_cents: dollars(body.nonexclusive_price),
          exclusive_enabled: body.exclusive_enabled !== false,
          exclusive_price_cents: dollars(body.exclusive_price),
          ownership_enabled: body.ownership_enabled !== false,
          ownership_price_cents: dollars(body.ownership_price),
        };
        if (ownerChanges.nonexclusive_enabled && ownerChanges.nonexclusive_price_cents === null) return json({ error: "Non-exclusive price is required" }, 400);
      }
      let result;
      if (id && !ownerAccess) {
        const { data: current, error } = await supabase.from("beatbay_beats").select("status,storefront_enabled").eq("id", id).single();
        if (error) throw error;
        if (current.status !== "draft" || current.storefront_enabled) return json({ error: "Published or active beats require owner approval" }, 403);
      }
      if (id) result = await supabase.from("beatbay_beats").update({ ...musicChanges, ...ownerChanges, updated_at: new Date().toISOString() }).eq("id", id).select("*").single();
      else result = await supabase.from("beatbay_beats").insert({
        ...musicChanges, ...ownerChanges, created_by: session.user.id,
        ...(!ownerAccess && !beatboxIntake ? { status: "draft", signature_sound: false, nonexclusive_enabled: false, exclusive_enabled: false, ownership_enabled: false, storefront_enabled: false, is_featured: false } : {}),
        ...(beatboxIntake ? { storefront_enabled: false, is_featured: false } : {}),
      }).select("*").single();
      if (result.error) throw result.error;
      await activityReport(supabase, session, {
        action: id ? "update_beat_draft" : "create_beat_draft",
        entityType: "beat",
        entityId: result.data.id,
        summary: `${id ? "Updated" : "Created"} ${beatboxIntake ? "Beatbox" : "BeatBay"} draft: ${beatCode} — ${title}`,
        ...(beatboxIntake ? { details: { intake: "beatbox", status: ownerChanges.status ?? "draft" } } : {}),
      });
      return json({ beat: result.data });
    }

    if (["set_storefront", "set_featured"].includes(action)) {
      if (!ownerAccess) return json({ error: "Owner approval required" }, 403);
      const id = String(body.id ?? "");
      const { data: beat, error: readError } = await supabase.from("beatbay_beats").select("*").eq("id", id).single();
      if (readError) throw readError;
      if (action === "set_storefront") {
        const enabled = body.enabled === true;
        if (enabled && body.intake === "beatbox" && body.confirm_publish !== true) return json({ error: "Approve & publish requires an explicit confirmation." }, 400);
        if (enabled && !beat.preview_url) return json({ error: "Upload a protected preview before publishing this beat" }, 400);
        if (enabled && beat.status === "draft") return json({ error: "Set the beat status to Available before publishing" }, 400);
        const changes = enabled ? { storefront_enabled: true, published_at: beat.published_at ?? new Date().toISOString() } : { storefront_enabled: false, is_featured: false };
        const { data, error } = await supabase.from("beatbay_beats").update(changes).eq("id", id).select("*").single();
        if (error) throw error;
        await activityReport(supabase, session, { action, entityType: "beat", entityId: id, summary: `${enabled ? "Published" : "Removed"} BeatBay listing: ${beat.beat_code} — ${beat.title}` });
        return json({ beat: data });
      }
      const featured = body.featured === true;
      if (featured && (!beat.storefront_enabled || !beat.published_at)) return json({ error: "Publish the beat before featuring it" }, 400);
      if (featured) await supabase.from("beatbay_beats").update({ is_featured: false }).neq("id", id);
      const { data, error } = await supabase.from("beatbay_beats").update({ is_featured: featured }).eq("id", id).select("*").single();
      if (error) throw error;
      await activityReport(supabase, session, { action, entityType: "beat", entityId: id, summary: `${featured ? "Featured" : "Unfeatured"} BeatBay listing: ${beat.beat_code} — ${beat.title}` });
      return json({ beat: data });
    }

    if (action === "create_upload") {
      const id = String(body.id ?? ""), kind = String(body.kind ?? ""), filename = String(body.filename ?? "");
      if (!id || !["preview", "full"].includes(kind)) return json({ error: "Beat and upload type are required" }, 400);
      if (!ownerAccess) {
        const { data: beat, error } = await supabase.from("beatbay_beats").select("status,storefront_enabled").eq("id", id).single();
        if (error) throw error;
        if (beat.status !== "draft" || beat.storefront_enabled) return json({ error: "Published or active beats require owner approval" }, 403);
      }
      const ext = safeExt(filename);
      if (!["mp3", "wav"].includes(ext)) return json({ error: "Audio must be MP3 or WAV" }, 400);
      if (body.intake === "beatbox") {
        if (!isUuid(id)) return json({ error: "Beat id is not valid." }, 400);
        const path = `beatbay/${id}/quarantine/${crypto.randomUUID()}.${ext}`;
        const signed = await signPrivateUpload("release-private", path, QUARANTINE_UPLOAD_TTL_SECONDS);
        const fallback = signed ? null : await signPrivateUpload("release-private", path, null);
        const ticket = signed ?? fallback;
        if (!ticket) return json({ error: "Could not prepare the private upload." }, 500);
        return json({
          bucket: "release-private",
          path,
          token: ticket.token,
          signed_url: ticket.signedUrl,
          public_url: null,
          quarantine: true,
          expires_in: signed ? QUARANTINE_UPLOAD_TTL_SECONDS : null,
        });
      }
      const bucket = kind === "preview" ? "release-public" : "release-private";
      const path = `beatbay/${id}/${kind}/${crypto.randomUUID()}.${ext}`;
      const { data, error } = await supabase.storage.from(bucket).createSignedUploadUrl(path, { upsert: false });
      if (error) throw error;
      const publicUrl = kind === "preview" ? `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/${bucket}/${path}` : null;
      return json({ bucket, path, token: data.token, signed_url: data.signedUrl, public_url: publicUrl });
    }

    if (action === "attach_asset") {
      const id = String(body.id ?? ""), kind = String(body.kind ?? ""), path = String(body.path ?? "");
      if (!id || !path || !["preview", "full"].includes(kind)) return json({ error: "Beat, file path, and valid upload type are required" }, 400);
      if (!ownerAccess) {
        const { data: beat, error } = await supabase.from("beatbay_beats").select("status,storefront_enabled").eq("id", id).single();
        if (error) throw error;
        if (beat.status !== "draft" || beat.storefront_enabled) return json({ error: "Published or active beats require owner approval" }, 403);
      }
      let changes: Record<string, unknown>;
      if (body.intake === "beatbox") {
        const ext = safeExt(path);
        if (!isQuarantinePath(id, path, ext)) return json({ error: "Quarantine path is not allowed." }, 400);
        const { data: blob, error: downloadError } = await supabase.storage.from("release-private").download(path);
        if (downloadError || !blob) return json({ error: "Quarantined audio was not found." }, 400);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (bytes.byteLength === 0 || bytes.byteLength > MAX_AUDIO_BYTES) {
          await supabase.storage.from("release-private").remove([path]);
          return json({ error: "Quarantined audio failed the size check." }, 400);
        }
        const verdict = magicAllowlist(ext, bytes);
        if (!verdict.ok) {
          await supabase.storage.from("release-private").remove([path]);
          return json({ error: verdict.error }, 400);
        }
        const finalPath = `beatbay/${id}/${kind}/${crypto.randomUUID()}.${ext}`;
        const finalBucket = kind === "preview" ? "release-public" : "release-private";
        const { error: uploadError } = await supabase.storage.from(finalBucket).upload(finalPath, bytes, {
          contentType: verdict.mime,
          upsert: false,
        });
        await supabase.storage.from("release-private").remove([path]);
        if (uploadError) return json({ error: "Validated audio could not be stored." }, 500);
        const duration = Number(body.duration_seconds);
        const previewDuration = Number.isFinite(duration) ? Math.max(1, Math.min(600, Math.round(duration))) : 30;
        const publicUrl = kind === "preview"
          ? `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/${finalBucket}/${finalPath}`
          : null;
        changes = kind === "preview"
          ? { preview_url: publicUrl, preview_duration_seconds: previewDuration }
          : { full_audio_bucket: "release-private", full_audio_path: finalPath };
      } else {
        changes = kind === "preview"
          ? { preview_url: String(body.public_url ?? ""), preview_duration_seconds: Number(body.duration_seconds || 30) }
          : { full_audio_bucket: "release-private", full_audio_path: path };
      }
      const { data, error } = await supabase.from("beatbay_beats").update(changes).eq("id", id).select("*").single();
      if (error) throw error;
      await activityReport(supabase, session, { action: "attach_beat_asset", entityType: "beat", entityId: id, summary: `Uploaded ${kind} audio for ${data.beat_code} — ${data.title}`, details: { kind } });
      return json({ beat: data });
    }

    if (action === "download_full_beat") {
      const id = String(body.id ?? "");
      if (!id) return json({ error: "Beat is required" }, 400);
      const { data: beat, error } = await supabase.from("beatbay_beats").select("beat_code,title,full_audio_bucket,full_audio_path").eq("id", id).single();
      if (error) throw error;
      if (!beat.full_audio_bucket || !beat.full_audio_path) return json({ error: "Full master has not been uploaded" }, 404);
      const { data: signed, error: signedError } = await supabase.storage.from(beat.full_audio_bucket).createSignedUrl(beat.full_audio_path, PRIVATE_DOWNLOAD_TTL_SECONDS, { download: true });
      if (signedError) throw signedError;
      await activityReport(supabase, session, { action: "download_full_beat", entityType: "beat", entityId: id, summary: `Downloaded full master: ${beat.beat_code} — ${beat.title}` });
      return json({ download_url: signed.signedUrl, expires_in: PRIVATE_DOWNLOAD_TTL_SECONDS });
    }

    if (action === "save_auction") {
      const id = String(body.id ?? "").trim();
      const beatId = String(body.beat_id ?? "");
      const startsAt = body.starts_at ? new Date(body.starts_at).toISOString() : new Date().toISOString();
      const endsAt = body.ends_at ? new Date(body.ends_at).toISOString() : null;
      if (!beatId || !endsAt) return json({ error: "Beat and auction closing time are required" }, 400);
      if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) return json({ error: "Auction must close after it starts" }, 400);
      if (id && !ownerAccess) {
        const { data: current, error } = await supabase.from("beatbay_auctions").select("status").eq("id", id).single();
        if (error) throw error;
        if (current.status !== "draft") return json({ error: "Only the owner can change a scheduled or live auction" }, 403);
      }
      const values: Record<string, unknown> = { beat_id: beatId, starts_at: startsAt, ends_at: endsAt, payment_window_hours: 24 };
      if (!id || body.starting_bid !== undefined) values.starting_bid_cents = dollars(body.starting_bid) ?? 2500;
      if (!id || body.minimum_increment !== undefined) values.minimum_increment_cents = dollars(body.minimum_increment) ?? 1000;
      if (!id || body.reserve_price !== undefined) values.reserve_price_cents = dollars(body.reserve_price);
      let result;
      if (id) result = await supabase.from("beatbay_auctions").update(values).eq("id", id).select("*").single();
      else result = await supabase.from("beatbay_auctions").insert({ ...values, status: "draft", created_by: session.user.id }).select("*").single();
      if (result.error) throw result.error;
      const { data: beat } = await supabase.from("beatbay_beats").select("beat_code,title").eq("id", beatId).single();
      await activityReport(supabase, session, { action: id ? "update_auction_draft" : "create_auction_draft", entityType: "auction", entityId: result.data.id, summary: `${id ? "Updated" : "Created"} auction draft for ${beat?.beat_code ?? "beat"} — ${beat?.title ?? ""}` });
      return json({ auction: result.data });
    }

    if (action === "set_auction_status") {
      if (!ownerAccess) return json({ error: "Owner approval required" }, 403);
      const id = String(body.id ?? ""), status = String(body.status ?? "");
      if (!["scheduled", "live", "closed", "cancelled"].includes(status)) return json({ error: "Invalid auction status" }, 400);
      const { data: auction, error: readError } = await supabase.from("beatbay_auctions").select("*, beat:beatbay_beats(*)").eq("id", id).single();
      if (readError) throw readError;
      if (status === "live") {
        if (!auction.beat?.storefront_enabled || !auction.beat?.preview_url) return json({ error: "The beat must be published with a preview before the auction can go live" }, 400);
        if (!auction.beat?.exclusive_enabled) return json({ error: "Exclusive licensing must be enabled for an auction" }, 400);
        if (!auction.ends_at || new Date(auction.ends_at).getTime() <= Date.now()) return json({ error: "Choose a future auction closing time" }, 400);
        await supabase.from("beatbay_beats").update({ status: "hold" }).eq("id", auction.beat_id);
      }
      if (status === "cancelled") await supabase.from("beatbay_beats").update({ status: "available" }).eq("id", auction.beat_id);
      const { data, error } = await supabase.from("beatbay_auctions").update({ status }).eq("id", id).select("*").single();
      if (error) throw error;
      await activityReport(supabase, session, { action: "set_auction_status", entityType: "auction", entityId: id, summary: `Changed auction for ${auction.beat?.beat_code ?? "beat"} to ${status}` });
      return json({ auction: data });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    logSafe(error);
    return json({ error: error instanceof Error ? redactLog(error.message) : "Unexpected error" }, 500);
  }
});
