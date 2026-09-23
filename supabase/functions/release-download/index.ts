import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

/**
 * SoT A (Craig/BoB): GET ?token= — hash token, look up release_download_tokens,
 * gate on entitlement + available_at, then redirect to short-lived private-bucket signed URL.
 * Not POST email/session (that design lives off-main; unpaid POST probe → 405 here).
 */

/** Sliding-window rate limit: ~30 requests / minute / IP (Deno Edge in-memory). */
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

type Bucket = { timestamps: number[] };
const rateBuckets = new Map<string, Bucket>();

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return (
    req.headers.get("cf-connecting-ip")?.trim() ||
    req.headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
}

function rateLimit(key: string): { ok: true } | { ok: false; retryAfterSec: number } {
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket) {
    bucket = { timestamps: [] };
    rateBuckets.set(key, bucket);
  }
  bucket.timestamps = bucket.timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (bucket.timestamps.length >= RATE_LIMIT_MAX) {
    const oldest = bucket.timestamps[0]!;
    const retryAfterSec = Math.max(1, Math.ceil((RATE_LIMIT_WINDOW_MS - (now - oldest)) / 1000));
    return { ok: false, retryAfterSec };
  }
  bucket.timestamps.push(now);
  if (rateBuckets.size > 5000) {
    for (const [k, b] of rateBuckets) {
      b.timestamps = b.timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
      if (b.timestamps.length === 0) rateBuckets.delete(k);
    }
  }
  return { ok: true };
}

const json = (body: unknown, status = 200, extraHeaders: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });


function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function downloadName(title: string, objectPath: string, trackNumber?: number | null): string {
  const ext = objectPath.includes(".") ? "." + objectPath.split(".").pop()!.toLowerCase().replace(/[^a-z0-9]/g, "") : "";
  const safeTitle = String(title || "track").replace(/[^a-zA-Z0-9 _().-]+/g, "").trim() || "track";
  const prefix = Number.isInteger(trackNumber) && Number(trackNumber) > 0 ? String(trackNumber).padStart(2, "0") + " - " : "";
  return `${prefix}${safeTitle}${ext}`;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  const rl = rateLimit("release-download:" + clientIp(req));
  if (!rl.ok) {
    return json(
      { error: "too_many_requests", retry_after: (rl as any).retryAfterSec },
      429,
      { "Retry-After": String((rl as any).retryAfterSec) },
    );
  }

  const token = new URL(req.url).searchParams.get("token");
  if (!token) return json({ error: "missing_token" }, 400);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const tokenHashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const tokenHash = [...new Uint8Array(tokenHashBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

  const { data: tokenRow, error: tokenError } = await supabase
    .from("release_download_tokens")
    .select("id, entitlement_id, expires_at, max_downloads, download_count, revoked_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (tokenError) return json({ error: "database_error" }, 500);
  if (!tokenRow) return json({ error: "invalid_token" }, 404);
  if (tokenRow.revoked_at) return json({ error: "revoked_token" }, 403);
  if (new Date(tokenRow.expires_at).getTime() <= Date.now()) return json({ error: "expired_token" }, 410);
  if (tokenRow.download_count >= tokenRow.max_downloads) return json({ error: "download_limit_reached" }, 403);

  const { data: entitlement, error: entitlementError } = await supabase
    .from("release_entitlements")
    .select("id, status, available_at, product_id, order_id")
    .eq("id", tokenRow.entitlement_id)
    .maybeSingle();

  if (entitlementError || !entitlement) return json({ error: "entitlement_not_found" }, 404);
  if (entitlement.status !== "available" || new Date(entitlement.available_at).getTime() > Date.now()) {
    return json({ error: "release_locked", available_at: entitlement.available_at }, 403);
  }

  const { data: product, error: productError } = await supabase
    .from("release_products")
    .select("storage_bucket, storage_object_path, delivery_filename, release_at, artist_name, title, product_type")
    .eq("id", entitlement.product_id)
    .single();

  if (productError || !product) return json({ error: "release_not_found" }, 503);
  const releaseTime = new Date(product.release_at).getTime();
  if (!Number.isFinite(releaseTime) || releaseTime > Date.now()) {
    return json({ error: "release_locked", available_at: product.release_at }, 403);
  }
  // Recheck payment at redemption, including orders changed after token issuance.
  const { data: order, error: orderError } = await supabase.from("release_orders")
    .select("payment_status")
    .eq("id", entitlement.order_id)
    .eq("product_id", entitlement.product_id)
    .maybeSingle();
  if (orderError) return json({ error: "database_error" }, 503);
  if (order?.payment_status !== "paid") return json({ error: "payment_not_confirmed" }, 403);

  // Preserve legacy/bundled ZIP delivery when a package is configured.
  if (product.storage_bucket && product.storage_object_path) {
    const { data: signed, error: signedError } = await supabase.storage
      .from(product.storage_bucket)
      .createSignedUrl(product.storage_object_path, 60, { download: product.delivery_filename || true });

    if (signedError || !signed?.signedUrl) return json({ error: "release_file_unavailable" }, 503);

    await supabase.from("release_download_tokens").update({ download_count: tokenRow.download_count + 1 }).eq("id", tokenRow.id);
    await supabase.from("release_delivery_log").insert({
      entitlement_id: entitlement.id,
      delivery_type: "download",
      status: "downloaded",
      details: { token_id: tokenRow.id, mode: "package" },
    });

    return Response.redirect(signed.signedUrl, 302);
  }

  // Direct-audio fulfillment: if no ZIP/package exists, securely deliver the
  // uploaded downloadable tracks from the private release_tracks collection.
  const { data: tracks, error: tracksError } = await supabase
    .from("release_tracks")
    .select("id, title, track_number, audio_bucket, audio_object_path, is_downloadable")
    .eq("product_id", entitlement.product_id)
    .eq("is_downloadable", true)
    .order("track_number", { ascending: true });

  if (tracksError) return json({ error: "database_error" }, 503);
  const deliverable = (tracks ?? []).filter((track) => track.audio_bucket && track.audio_object_path);
  if (!deliverable.length) return json({ error: "release_file_not_configured" }, 503);

  const signedTracks: Array<{ title: string; track_number: number | null; url: string; filename: string }> = [];
  for (const track of deliverable) {
    const filename = downloadName(track.title, track.audio_object_path, track.track_number);
    const { data: signed, error: signedError } = await supabase.storage
      .from(track.audio_bucket)
      .createSignedUrl(track.audio_object_path, 300, { download: filename });
    if (signedError || !signed?.signedUrl) return json({ error: "release_file_unavailable" }, 503);
    signedTracks.push({
      title: track.title,
      track_number: track.track_number,
      url: signed.signedUrl,
      filename,
    });
  }

  await supabase.from("release_download_tokens").update({ download_count: tokenRow.download_count + 1 }).eq("id", tokenRow.id);
  await supabase.from("release_delivery_log").insert({
    entitlement_id: entitlement.id,
    delivery_type: "download",
    status: "downloaded",
    details: { token_id: tokenRow.id, mode: "tracks", track_count: signedTracks.length },
  });

  // Singles and beats stay one-tap: go straight to the master download.
  if (signedTracks.length === 1) {
    return Response.redirect(signedTracks[0].url, 302);
  }

  // EPs/albums receive a secure, short-lived track download page. No ZIP is required.
  const rows = signedTracks.map((track) => {
    const number = track.track_number ? `${track.track_number}. ` : "";
    return `<li><span>${escapeHtml(number + track.title)}</span><a href="${escapeHtml(track.url)}" download="${escapeHtml(track.filename)}">Download</a></li>`;
  }).join("");

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>${escapeHtml(product.artist_name)} — ${escapeHtml(product.title)}</title>
  <style>
    body{margin:0;background:#090909;color:#f7f0dc;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{max-width:760px;margin:0 auto;padding:40px 20px}
    h1{color:#d4af37;margin-bottom:6px}.muted{color:#b8ad91}
    ul{list-style:none;padding:0;margin:28px 0;display:grid;gap:12px}
    li{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:16px;border:1px solid #3b321d;border-radius:12px;background:#12100b}
    a{display:inline-block;padding:10px 14px;border-radius:9px;background:#d4af37;color:#090909;text-decoration:none;font-weight:700}
    footer{margin-top:28px;font-size:13px;color:#8f876f}
  </style>
</head>
<body><main>
  <p class="muted">Rosetta Crew secure delivery</p>
  <h1>${escapeHtml(product.title)}</h1>
  <p>${escapeHtml(product.artist_name)}</p>
  <p class="muted">Download links are temporary. Save each track to your device.</p>
  <ul>${rows}</ul>
  <footer>Purchased release · secure direct-audio fulfillment</footer>
</main></body></html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
});
