import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type,x-admin-key,x-client-info",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, "content-type": "application/json" } });
}

function adminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const secretJson = Deno.env.get("SUPABASE_SECRET_KEYS");
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const key = secretJson ? JSON.parse(secretJson)?.default : legacy;
  if (!url || !key) throw new Error("Supabase admin credentials unavailable");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function validAdminKey(req: Request) {
  const expected = Deno.env.get("RELEASE_MANAGER_ADMIN_KEY");
  if (!expected) return false;
  const supplied = req.headers.get("x-admin-key") ?? "";
  if (supplied.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

async function authenticatedAdmin(req: Request, supabase: ReturnType<typeof adminClient>) {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!token) return null;
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user) return null;
  const { data: admin, error } = await supabase.from("release_admin_users")
    .select("user_id,role,is_active")
    .eq("user_id", userData.user.id)
    .eq("is_active", true)
    .maybeSingle();
  if (error || !admin || !["owner","admin","staff","music_uploader"].includes(admin.role)) return null;
  return { user: userData.user, admin };
}

const isOwner = (session: any) => ["owner", "admin"].includes(session?.admin?.role);

async function activityReport(
  supabase: ReturnType<typeof adminClient>,
  session: any,
  input: { action: string; entityType: string; entityId?: string | null; summary: string; details?: Record<string, unknown> },
) {
  if (!session?.user) return;
  try {
    const { data: event, error } = await supabase.from("music_activity_log").insert({
      actor_user_id: session.user.id,
      actor_email: session.user.email ?? null,
      actor_role: session.admin.role,
      surface: "release_station",
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
        text: `${session.user.email ?? "Music uploader"} completed this action:\n\n${input.summary}\n\nArea: Release Station\nTime: ${event.created_at}\n\nReview the permanent Activity Report in the owner dashboard.`,
      }),
    });
    await supabase.from("music_activity_log").update(response.ok
      ? { email_status: "sent", email_sent_at: new Date().toISOString(), email_error: null }
      : { email_status: "failed", email_error: (await response.text()).slice(0, 500) }
    ).eq("id", event.id);
  } catch (error) {
    console.error("Activity reporting failed", error);
  }
}

function slugify(input: string) {
  return input.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
}
function safeExt(filename: string) {
  return filename.includes(".") ? filename.split(".").pop()!.toLowerCase().replace(/[^a-z0-9]/g, "") : "bin";
}

function normalizeArtistType(value: unknown) {
  const type = String(value ?? "").trim().toLowerCase();
  return type === "actual" || type === "ai" ? type : null;
}
function cleanContact(value: unknown) {
  return String(value ?? "").trim().slice(0, 500) || null;
}
async function syncArtistContact(supabase: ReturnType<typeof adminClient>, productId: string, type: string | null, input: any) {
  if (type !== "actual") {
    const { error } = await supabase.from("release_artist_contacts").delete().eq("release_product_id", productId);
    if (error) throw error;
    return null;
  }
  const contact = {
    release_product_id: productId,
    contact_name: cleanContact(input?.contact_name),
    contact_email: cleanContact(input?.contact_email),
    contact_phone: cleanContact(input?.contact_phone),
    notes: cleanContact(input?.notes),
    updated_at: new Date().toISOString(),
  };
  if (!contact.contact_name && !contact.contact_email && !contact.contact_phone && !contact.notes) {
    const { error } = await supabase.from("release_artist_contacts").delete().eq("release_product_id", productId);
    if (error) throw error;
    return null;
  }
  const { data, error } = await supabase.from("release_artist_contacts")
    .upsert(contact, { onConflict: "release_product_id" })
    .select("contact_name,contact_email,contact_phone,notes")
    .single();
  if (error) throw error;
  return data;
}

async function stripePost(path: string, params: URLSearchParams) {
  const secret = Deno.env.get("STRIPE_SECRET_KEY");
  if (!secret) throw new Error("STRIPE_SECRET_KEY is not configured");
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "content-type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? "Stripe request failed");
  return body;
}

async function createCheckout(product: any) {
  const p = new URLSearchParams();
  p.set("name", `${product.artist_name} — ${product.title}`);
  if (product.description) p.set("description", product.description);
  p.set("metadata[release_product_id]", product.id);
  p.set("metadata[release_slug]", product.slug);
  const stripeProduct = await stripePost("products", p);
  const activePrice = product.status === "presale" && product.presale_price_cents != null ? product.presale_price_cents : product.release_price_cents ?? product.presale_price_cents;
  if (activePrice == null) throw new Error("Release price is required");
  const pp = new URLSearchParams(); pp.set("currency", product.currency ?? "usd"); pp.set("unit_amount", String(activePrice)); pp.set("product", stripeProduct.id);
  const stripePrice = await stripePost("prices", pp);
  const lp = new URLSearchParams();
  lp.set("line_items[0][price]", stripePrice.id); lp.set("line_items[0][quantity]", "1"); lp.set("customer_creation", "always");
  lp.set("metadata[release_product_id]", product.id); lp.set("metadata[release_slug]", product.slug);
  lp.set("after_completion[type]", "hosted_confirmation");
  lp.set("after_completion[hosted_confirmation][custom_message]", product.status === "presale" ? `Pre-order confirmed. Your digital release unlocks ${new Date(product.release_at).toLocaleDateString("en-US")}.` : "Thank you for your purchase. Your digital release is ready through your secure delivery link.");
  const link = await stripePost("payment_links", lp);
  return { stripeProduct, stripePrice, link };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const supabase = adminClient();
    let body: any = null;
    if (req.method === "POST") body = await req.json();

    if (req.method === "POST" && body?.action === "claim_owner") {
      if (!validAdminKey(req)) return json({ error: "Current owner key required" }, 401);
      const auth = req.headers.get("authorization") ?? "";
      const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
      if (!token) return json({ error: "Authenticated account required" }, 401);
      const { data: userData, error: userError } = await supabase.auth.getUser(token);
      if (userError || !userData.user) return json({ error: "Invalid account session" }, 401);
      const { count, error: countError } = await supabase.from("release_admin_users").select("user_id", { count: "exact", head: true }).eq("role", "owner").eq("is_active", true);
      if (countError) throw countError;
      if ((count ?? 0) > 0) return json({ error: "Owner already configured" }, 409);
      const { error: insertError } = await supabase.from("release_admin_users").insert({ user_id: userData.user.id, role: "owner", is_active: true });
      if (insertError) throw insertError;
      return json({ ok: true, owner_user_id: userData.user.id });
    }

    const sessionAdmin = await authenticatedAdmin(req, supabase);
    const fallbackKey = validAdminKey(req);
    if (!sessionAdmin && !fallbackKey) return json({ error: "Unauthorized" }, 401);
    const ownerAccess = fallbackKey || isOwner(sessionAdmin);

    if (req.method === "GET") {
      const url = new URL(req.url);
      const view = url.searchParams.get("view") ?? "releases";
      if (view === "whoami") return json({ auth_mode: sessionAdmin ? "account" : "key", role: sessionAdmin?.admin?.role ?? "owner-key" });
      if (view === "analytics") {
        if (!ownerAccess) return json({ error: "Owner approval required" }, 403);
        const { data, error } = await supabase.from("release_analytics_summary").select("*").order("title");
        if (error) throw error; return json({ analytics: data });
      }
      if (view === "activity") {
        if (!ownerAccess) return json({ error: "Owner approval required" }, 403);
        const { data, error } = await supabase.from("music_activity_log")
          .select("id,actor_email,actor_role,surface,action,entity_type,entity_id,summary,details,email_status,email_sent_at,created_at")
          .order("created_at", { ascending: false })
          .limit(200);
        if (error) throw error;
        return json({ activity: data ?? [] });
      }
      const selection = ownerAccess
        ? "*, tracks:release_tracks(*)"
        : "id,slug,artist_name,artist_type,title,product_type,description,release_at,status,storefront_enabled,cover_art_bucket,cover_art_path,preview_bucket,preview_path,created_at,updated_at,tracks:release_tracks(id,product_id,track_number,title,version,explicit,duration_seconds,is_downloadable,created_at,updated_at)";
      const { data, error } = await supabase.from("release_products").select(selection).order("created_at", { ascending: false });
      if (error) throw error;
      if (!ownerAccess) return json({ releases: data ?? [], auth_mode: "account", role: sessionAdmin?.admin?.role });
      const ids = (data ?? []).map((release: any) => release.id);
      let contacts: any[] = [];
      if (ids.length) {
        const result = await supabase.from("release_artist_contacts")
          .select("release_product_id,contact_name,contact_email,contact_phone,notes")
          .in("release_product_id", ids);
        if (result.error) throw result.error;
        contacts = result.data ?? [];
      }
      const contactByRelease = new Map(contacts.map((contact: any) => [contact.release_product_id, contact]));
      return json({
        releases: (data ?? []).map((release: any) => ({ ...release, artist_contact: contactByRelease.get(release.id) ?? null })),
        auth_mode: sessionAdmin ? "account" : "key",
      });
    }

    if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
    const action = body?.action;

    if (action === "create_release") {
      const artist = String(body.artist_name ?? "").trim(), title = String(body.title ?? "").trim();
      if (!artist || !title) return json({ error: "artist_name and title are required" }, 400);
      const releaseAt = new Date(body.release_at); if (Number.isNaN(releaseAt.getTime())) return json({ error: "Valid release_at is required" }, 400);
      const presale = ownerAccess && body.presale_price_cents != null ? Number(body.presale_price_cents) : null;
      const regular = ownerAccess && body.release_price_cents != null ? Number(body.release_price_cents) : null;
      if (ownerAccess && presale == null && regular == null) return json({ error: "A price is required" }, 400);
      const payload = { slug: slugify(String(body.slug || `${artist}-${title}`)), artist_name: artist, title, product_type: body.product_type ?? "single", description: body.description ?? null, presale_price_cents: ownerAccess ? (presale ?? regular) : 0, release_price_cents: ownerAccess ? regular : null, currency: "usd", release_at: releaseAt.toISOString(), preorder_starts_at: ownerAccess && body.preorder_starts_at ? new Date(body.preorder_starts_at).toISOString() : new Date().toISOString(), preorder_ends_at: releaseAt.toISOString(), status: ownerAccess ? (body.status ?? "draft") : "draft", storefront_enabled: ownerAccess ? body.storefront_enabled !== false : false, cover_art_bucket: "release-public", storage_bucket: "release-private", artist_type: normalizeArtistType(body.artist_type), metadata: ownerAccess ? (body.metadata ?? {}) : { ...(body.metadata ?? {}), pricing_pending: true } };
      const { data, error } = await supabase.from("release_products").insert(payload).select("*").single();
      if (error) throw error;
      const artistContact = ownerAccess ? await syncArtistContact(supabase, data.id, data.artist_type, body.artist_contact) : null;
      if (sessionAdmin) await activityReport(supabase, sessionAdmin, { action: "create_release_draft", entityType: "release", entityId: data.id, summary: `Created release draft: ${artist} — ${title}` });
      return json({ release: { ...data, artist_contact: artistContact } }, 201);
    }

    if (action === "update_release") {
      const id = String(body.id ?? ""); if (!id) return json({ error: "id is required" }, 400);
      if (!ownerAccess) {
        const { data: current, error: currentError } = await supabase.from("release_products").select("published_at,storefront_enabled").eq("id", id).single();
        if (currentError) throw currentError;
        if (current.published_at || current.storefront_enabled) return json({ error: "Published releases require owner approval" }, 403);
      }
      const allowed = ownerAccess
        ? ["artist_name","title","product_type","description","presale_price_cents","release_price_cents","currency","release_at","preorder_starts_at","preorder_ends_at","status","storefront_enabled","cover_art_path","cover_art_bucket","preview_path","is_featured","featured_at","artist_type","metadata"]
        : ["artist_name","title","product_type","description","release_at","artist_type","metadata"];
      const changes: Record<string, unknown> = { updated_at: new Date().toISOString() }; for (const k of allowed) if (body[k] !== undefined) changes[k] = body[k];
      if (body.artist_type !== undefined) changes.artist_type = normalizeArtistType(body.artist_type);
      if (!ownerAccess) { changes.status = "draft"; changes.storefront_enabled = false; }
      const { data, error } = await supabase.from("release_products").update(changes).eq("id", id).select("*").single();
      if (error) throw error;
      let artistContact = null;
      if (ownerAccess && (body.artist_type !== undefined || body.artist_contact !== undefined)) {
        artistContact = await syncArtistContact(supabase, data.id, data.artist_type, body.artist_contact);
      } else if (ownerAccess) {
        const result = await supabase.from("release_artist_contacts")
          .select("contact_name,contact_email,contact_phone,notes")
          .eq("release_product_id", data.id)
          .maybeSingle();
        if (result.error) throw result.error;
        artistContact = result.data;
      }
      if (sessionAdmin) await activityReport(supabase, sessionAdmin, { action: "update_release_draft", entityType: "release", entityId: data.id, summary: `Updated release draft: ${data.artist_name} — ${data.title}` });
      return json({ release: { ...data, artist_contact: artistContact } });
    }

    if (action === "set_featured") {
      if (!ownerAccess) return json({ error: "Owner approval required" }, 403);
      const id = String(body.id ?? "");
      if (!id) return json({ error: "id is required" }, 400);
      const featured = body.featured === true;
      if (featured) {
        const { data: current, error: currentError } = await supabase.from("release_products")
          .select("status,storefront_enabled,published_at")
          .eq("id", id)
          .single();
        if (currentError) throw currentError;
        if (!current.storefront_enabled || !current.published_at || !["live", "presale"].includes(current.status)) {
          return json({ error: "Publish this release to the storefront before featuring it." }, 409);
        }
      }
      const now = new Date().toISOString();
      const { data, error } = await supabase.from("release_products")
        .update({ is_featured: featured, featured_at: featured ? now : null, updated_at: now })
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw error;
      if (sessionAdmin) await activityReport(supabase, sessionAdmin, { action: "set_featured", entityType: "release", entityId: data.id, summary: `${featured ? "Featured" : "Unfeatured"} release: ${data.artist_name} — ${data.title}` });
      return json({ release: data });
    }

    if (action === "add_track") {
      const productId = String(body.product_id ?? ""), title = String(body.title ?? "").trim(), trackNumber = Number(body.track_number);
      if (!productId || !title || !Number.isInteger(trackNumber) || trackNumber < 1) return json({ error: "product_id, title and track_number are required" }, 400);
      if (!ownerAccess) {
        const { data: release, error } = await supabase.from("release_products").select("published_at,storefront_enabled").eq("id", productId).single();
        if (error) throw error;
        if (release.published_at || release.storefront_enabled) return json({ error: "Published releases require owner approval" }, 403);
      }
      const ext = safeExt(body.filename ?? "audio.mp3"), safeName = slugify(String(body.filename ?? `${trackNumber}-${title}`).replace(/\.[^.]+$/, "")) || `track-${trackNumber}`;
      const path = `${productId}/tracks/${String(trackNumber).padStart(2,"0")}-${safeName}.${ext}`;
      const payload = { product_id: productId, track_number: trackNumber, title, version: body.version ?? null, explicit: !!body.explicit, audio_bucket: "release-private", audio_object_path: path, is_downloadable: body.is_downloadable !== false, metadata: body.metadata ?? {} };
      const { data, error } = await supabase.from("release_tracks").upsert(payload, { onConflict: "product_id,track_number" }).select("*").single(); if (error) throw error;
      if (sessionAdmin) await activityReport(supabase, sessionAdmin, { action: "save_release_track", entityType: "track", entityId: data.id, summary: `Saved release track ${trackNumber}: ${title}`, details: { product_id: productId } });
      return json({ track: data });
    }

    if (action === "signed_upload") {
      const productId = String(body.product_id ?? ""), kind = String(body.kind ?? ""), filename = String(body.filename ?? "").trim();
      if (!productId || !filename || !["cover","track","preview","package"].includes(kind)) return json({ error: "product_id, filename and valid kind are required" }, 400);
      if (!ownerAccess) {
        const { data: release, error } = await supabase.from("release_products").select("published_at,storefront_enabled").eq("id", productId).single();
        if (error) throw error;
        if (release.published_at || release.storefront_enabled) return json({ error: "Published releases require owner approval" }, 403);
      }
      const ext = safeExt(filename); if (kind === "cover" && !["jpg","jpeg","png","webp"].includes(ext)) return json({ error: "Cover art must be JPG, PNG, or WebP" }, 400);
      if ((kind === "track" || kind === "preview") && !["mp3","wav"].includes(ext)) return json({ error: "Audio must be MP3 or WAV" }, 400); if (kind === "package" && ext !== "zip") return json({ error: "Release package must be ZIP" }, 400);
      let path: string, bucket = "release-private";
      if (kind === "cover") { bucket = "release-public"; path = `${productId}/cover/cover-${crypto.randomUUID()}.${ext}`; }
      else if (kind === "preview") path = `${productId}/preview/preview-${crypto.randomUUID()}.${ext}`;
      else if (kind === "package") path = `${productId}/package/release-${crypto.randomUUID()}.${ext}`;
      else path = String(body.object_path ?? `${productId}/tracks/${crypto.randomUUID()}.${ext}`);
      const { data, error } = await supabase.storage.from(bucket).createSignedUploadUrl(path, { upsert: false }); if (error) throw error;
      return json({ bucket, path, token: data.token, signed_url: data.signedUrl, public_url: bucket === "release-public" ? `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/${bucket}/${path}` : null });
    }

    if (action === "download_track") {
      const trackId = String(body.track_id ?? "");
      if (!trackId) return json({ error: "Track is required" }, 400);
      const { data: track, error } = await supabase.from("release_tracks")
        .select("id,title,audio_bucket,audio_object_path,release:release_products(artist_name,title)")
        .eq("id", trackId)
        .single();
      if (error) throw error;
      const { data: signed, error: signedError } = await supabase.storage.from(track.audio_bucket).createSignedUrl(track.audio_object_path, 300, { download: true });
      if (signedError) throw signedError;
      if (sessionAdmin) await activityReport(supabase, sessionAdmin, { action: "download_release_track", entityType: "track", entityId: track.id, summary: `Downloaded release track: ${(track.release as any)?.artist_name ?? ""} — ${track.title}` });
      return json({ download_url: signed.signedUrl, expires_in: 300 });
    }

    if (action === "attach_asset") {
      const productId = String(body.product_id ?? ""), kind = String(body.kind ?? ""), path = String(body.path ?? ""); if (!productId || !path) return json({ error: "product_id and path are required" }, 400);
      if (!ownerAccess) {
        const { data: release, error } = await supabase.from("release_products").select("published_at,storefront_enabled").eq("id", productId).single();
        if (error) throw error;
        if (release.published_at || release.storefront_enabled) return json({ error: "Published releases require owner approval" }, 403);
      }
      const changes: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (kind === "cover") { changes.cover_art_path = path; changes.cover_art_bucket = "release-public"; }
      else if (kind === "preview") changes.preview_path = path;
      else if (kind === "package") { changes.storage_object_path = path; changes.delivery_filename = body.delivery_filename ?? path.split("/").pop(); }
      else return json({ error: "Invalid asset kind" }, 400);
      const { data, error } = await supabase.from("release_products").update(changes).eq("id", productId).select("*").single(); if (error) throw error;
      if (sessionAdmin) await activityReport(supabase, sessionAdmin, { action: "attach_release_asset", entityType: "release", entityId: productId, summary: `Uploaded ${kind} for ${data.artist_name} — ${data.title}`, details: { kind } });
      return json({ release: data });
    }

    if (action === "publish") {
      if (!ownerAccess) return json({ error: "Owner approval required" }, 403);
      const productId = String(body.product_id ?? ""); const { data: product, error } = await supabase.from("release_products").select("*").eq("id", productId).single(); if (error) throw error;
      let stripe = null;
      if (!product.stripe_payment_link_url || body.force_new_checkout === true) {
        stripe = await createCheckout(product);
        const { error: ue } = await supabase.from("release_products").update({ stripe_payment_link_id: stripe.link.id, stripe_payment_link_url: stripe.link.url, status: product.status === "draft" ? (new Date(product.release_at).getTime() > Date.now() && product.presale_price_cents != null ? "presale" : "live") : product.status, storefront_enabled: true, published_at: new Date().toISOString(), updated_at: new Date().toISOString(), metadata: { ...(product.metadata ?? {}), stripe_product_id: stripe.stripeProduct.id, stripe_price_id: stripe.stripePrice.id } }).eq("id", productId); if (ue) throw ue;
      } else await supabase.from("release_products").update({ storefront_enabled: true, published_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", productId);
      const { data: current } = await supabase.from("release_products").select("*").eq("id", productId).single();
      if (sessionAdmin) await activityReport(supabase, sessionAdmin, { action: "publish_release", entityType: "release", entityId: productId, summary: `Published release: ${current?.artist_name ?? ""} — ${current?.title ?? ""}` });
      return json({ release: current, checkout_created: !!stripe });
    }

    if (action === "unpublish") {
      if (!ownerAccess) return json({ error: "Owner approval required" }, 403);
      const productId = String(body.product_id ?? ""); const { data, error } = await supabase.from("release_products").update({ storefront_enabled: false, status: "archived", updated_at: new Date().toISOString() }).eq("id", productId).select("*").single(); if (error) throw error;
      if (sessionAdmin) await activityReport(supabase, sessionAdmin, { action: "unpublish_release", entityType: "release", entityId: productId, summary: `Unpublished release: ${data.artist_name} — ${data.title}` });
      return json({ release: data });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    console.error(error); return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
