import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { Zip, ZipPassThrough } from "npm:fflate@0.8.2";

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
    .select("storage_bucket, storage_object_path, delivery_filename, release_at, title, artist_name, product_type, cover_art_bucket, cover_art_path")
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

  const { data: tracks, error: tracksError } = await supabase
    .from("release_tracks")
    .select("id, track_number, title, audio_bucket, audio_object_path, is_downloadable")
    .eq("product_id", entitlement.product_id)
    .eq("is_downloadable", true)
    .order("track_number", { ascending: true });

  if (tracksError) return json({ error: "database_error" }, 503);
  const downloadableTracks = (tracks ?? []).filter((track) =>
    track.audio_bucket && track.audio_object_path
  );

  const markDownloaded = async (mode: string, extra: Record<string, unknown> = {}) => {
    await supabase.from("release_download_tokens")
      .update({ download_count: tokenRow.download_count + 1 })
      .eq("id", tokenRow.id);
    await supabase.from("release_delivery_log").insert({
      entitlement_id: entitlement.id,
      delivery_type: "download",
      status: "downloaded",
      details: { token_id: tokenRow.id, mode, ...extra },
    });
  };

  const cleanName = (value: unknown, fallback: string) => {
    const out = String(value ?? "").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim();
    return out || fallback;
  };
  const extensionOf = (path: string, fallback = "wav") => {
    const m = String(path).match(/\.([A-Za-z0-9]+)$/);
    return (m?.[1] || fallback).toLowerCase();
  };

  // One uploaded master: deliver the track directly, no manual ZIP required.
  if (downloadableTracks.length === 1) {
    const track = downloadableTracks[0];
    const filename = `01 - ${cleanName(track.title, "Track 1")}.${extensionOf(track.audio_object_path)}`;
    const { data: signed, error: signedError } = await supabase.storage
      .from(track.audio_bucket)
      .createSignedUrl(track.audio_object_path, 60, { download: filename });
    if (signedError || !signed?.signedUrl) return json({ error: "release_file_unavailable" }, 503);
    await markDownloaded("single_track", { track_id: track.id });
    return Response.redirect(signed.signedUrl, 302);
  }

  // Multi-track releases are packaged on demand in the exact saved track_number order.
  // ZipPassThrough avoids re-compressing already-compressed audio and streams each master
  // so the Edge Function does not need to hold the entire album in memory.
  if (downloadableTracks.length > 1) {
    const packageBase = cleanName(
      [product.artist_name, product.title].filter(Boolean).join(" - "),
      "Rosetta Crew Release",
    );
    const zipFilename = `${packageBase}.zip`;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let finished = false;
        const zip = new Zip((err, data, final) => {
          if (finished) return;
          if (err) {
            finished = true;
            controller.error(err);
            return;
          }
          if (data?.length) controller.enqueue(data);
          if (final) {
            finished = true;
            controller.close();
          }
        });

        (async () => {
          try {
            for (let i = 0; i < downloadableTracks.length; i++) {
              const track = downloadableTracks[i];
              const number = Number(track.track_number) || i + 1;
              const filename = `${String(number).padStart(2, "0")} - ${cleanName(track.title, `Track ${number}`)}.${extensionOf(track.audio_object_path)}`;
              const entry = new ZipPassThrough(filename);
              zip.add(entry);

              const { data: signed, error: signedError } = await supabase.storage
                .from(track.audio_bucket)
                .createSignedUrl(track.audio_object_path, 300);
              if (signedError || !signed?.signedUrl) throw new Error("track_sign_failed");

              const response = await fetch(signed.signedUrl);
              if (!response.ok || !response.body) throw new Error("track_fetch_failed");
              const reader = response.body.getReader();
              while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                if (value?.length) entry.push(value, false);
              }
              entry.push(new Uint8Array(0), true);
            }

            if (product.cover_art_bucket && product.cover_art_path) {
              const ext = extensionOf(product.cover_art_path, "jpg");
              const coverEntry = new ZipPassThrough(`Cover.${ext}`);
              zip.add(coverEntry);
              const coverBucket = String(product.cover_art_bucket);
              let coverUrl = "";
              if (coverBucket === "release-public") {
                coverUrl = `${supabaseUrl}/storage/v1/object/public/${coverBucket}/${String(product.cover_art_path).split("/").map(encodeURIComponent).join("/")}`;
              } else {
                const { data: signedCover, error: signedCoverError } = await supabase.storage
                  .from(coverBucket)
                  .createSignedUrl(product.cover_art_path, 300);
                if (signedCoverError || !signedCover?.signedUrl) throw new Error("cover_sign_failed");
                coverUrl = signedCover.signedUrl;
              }
              const coverResponse = await fetch(coverUrl);
              if (coverResponse.ok && coverResponse.body) {
                const reader = coverResponse.body.getReader();
                while (true) {
                  const { value, done } = await reader.read();
                  if (done) break;
                  if (value?.length) coverEntry.push(value, false);
                }
                coverEntry.push(new Uint8Array(0), true);
              } else {
                coverEntry.push(new Uint8Array(0), true);
              }
            }

            zip.end();
          } catch (error) {
            try { zip.terminate(); } catch {}
            if (!finished) {
              finished = true;
              controller.error(error);
            }
          }
        })();
      },
    });

    await markDownloaded("auto_zip", { track_count: downloadableTracks.length });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${zipFilename.replace(/"/g, "")}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }

  // Backward compatibility: custom/manual packages and older one-file releases still work.
  if (!product.storage_bucket || !product.storage_object_path) {
    return json({ error: "release_file_not_configured" }, 503);
  }

  const { data: signed, error: signedError } = await supabase.storage
    .from(product.storage_bucket)
    .createSignedUrl(product.storage_object_path, 60, { download: product.delivery_filename || true });

  if (signedError || !signed?.signedUrl) return json({ error: "release_file_unavailable" }, 503);
  await markDownloaded("legacy_package");
  return Response.redirect(signed.signedUrl, 302);
});
