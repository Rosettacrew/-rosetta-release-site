import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = new Set(["https://rosettacrew.com", "https://www.rosettacrew.com"]);
const MAX_BODY_BYTES = 4096;
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const rateBuckets = new Map<string, number[]>();

function cors(req: Request) {
  const origin = req.headers.get("origin") ?? "";
  return {
    ...(ALLOWED_ORIGINS.has(origin) ? { "access-control-allow-origin": origin } : {}),
    "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
    "access-control-allow-methods": "POST,OPTIONS",
    "cache-control": "no-store",
    vary: "Origin",
  };
}

function json(req: Request, body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), "content-type": "application/json", ...extra },
  });
}

function clientIp(req: Request) {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || req.headers.get("cf-connecting-ip")?.trim()
    || req.headers.get("x-real-ip")?.trim()
    || "unknown";
}

function rateLimit(key: string) {
  const now = Date.now();
  const active = (rateBuckets.get(key) ?? []).filter((time) => now - time < RATE_LIMIT_WINDOW_MS);
  if (active.length >= RATE_LIMIT_MAX) {
    const retryAfter = Math.max(1, Math.ceil((RATE_LIMIT_WINDOW_MS - (now - active[0]!)) / 1000));
    rateBuckets.set(key, active);
    return { ok: false as const, retryAfter };
  }
  active.push(now);
  rateBuckets.set(key, active);
  if (rateBuckets.size > 5000) {
    for (const [bucketKey, times] of rateBuckets) {
      const live = times.filter((time) => now - time < RATE_LIMIT_WINDOW_MS);
      if (live.length) rateBuckets.set(bucketKey, live);
      else rateBuckets.delete(bucketKey);
    }
  }
  return { ok: true as const };
}

async function readJson(req: Request) {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error("body_too_large");
  if (!req.body) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("body_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function adminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const secretJson = Deno.env.get("SUPABASE_SECRET_KEYS");
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const key = secretJson ? JSON.parse(secretJson)?.default : legacy;
  if (!url || !key) throw new Error("backend_unavailable");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function stripeKey() {
  const key = Deno.env.get("BEATBAY_STRIPE_RESTRICTED_KEY")?.trim() ?? "";
  if (!/^rk_(test|live)_[A-Za-z0-9]+$/.test(key)) throw new Error("stripe_unavailable");
  return key;
}

async function integrationIdentifier(requestId: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(requestId)));
  return `beatbay_${[...digest.slice(0, 8)].map((byte) => String.fromCharCode(97 + (byte % 26))).join("")}`;
}

function deliveryFilename(beatCode: string, title: string, path: string) {
  const extension = path.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "wav";
  const base = `${beatCode} - ${title}`.replace(/[^a-zA-Z0-9 _-]/g, "").replace(/\s+/g, " ").trim();
  return `${base || "BeatBay Beat"}.${extension}`;
}

async function createStripeSession(key: string, params: URLSearchParams, requestId: string) {
  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/x-www-form-urlencoded",
      "idempotency-key": `beatbay-nonexclusive-${requestId}`,
      "stripe-version": "2026-07-29.dahlia",
    },
    body: params,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data?.id !== "string" || typeof data?.url !== "string") {
    console.error("beatbay-checkout provider failure", { status: response.status, type: data?.error?.type ?? "unknown" });
    throw new Error("stripe_unavailable");
  }
  const url = new URL(data.url);
  if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com") throw new Error("invalid_checkout_url");
  return { id: data.id as string, url: data.url as string };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);
  const origin = req.headers.get("origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) return json(req, { error: "origin_not_allowed" }, 403);

  const limited = rateLimit(`beatbay-checkout:${clientIp(req)}`);
  if (!limited.ok) {
    return json(req, { error: "too_many_requests", retry_after: limited.retryAfter }, 429, {
      "retry-after": String(limited.retryAfter),
    });
  }

  try {
    const body = await readJson(req);
    if (!body || typeof body !== "object") return json(req, { error: "invalid_request" }, 400);
    const beatId = String((body as any).beat_id ?? "").trim();
    const requestId = String((body as any).request_id ?? "").trim();
    const licenseType = String((body as any).license_type ?? "").trim();
    if (!UUID.test(beatId) || !UUID.test(requestId) || licenseType !== "nonexclusive") {
      return json(req, { error: "invalid_request" }, 400);
    }

    const supabase = adminClient();
    const { data: beat, error: beatError } = await supabase.from("beatbay_beats").select(
      "id,beat_code,title,status,storefront_enabled,published_at,nonexclusive_enabled,nonexclusive_price_cents,nonexclusive_terms_version,nonexclusive_terms_url,full_audio_bucket,full_audio_path",
    ).eq("id", beatId).maybeSingle();
    if (beatError) throw beatError;
    if (!beat) return json(req, { error: "beat_not_found" }, 404);

    const amount = Number(beat.nonexclusive_price_cents);
    const termsVersion = String(beat.nonexclusive_terms_version ?? "").trim();
    const termsUrl = String(beat.nonexclusive_terms_url ?? "").trim();
    const bucket = String(beat.full_audio_bucket ?? "").trim();
    const path = String(beat.full_audio_path ?? "").trim();
    const ready = beat.status === "available"
      && beat.storefront_enabled === true
      && !!beat.published_at
      && beat.nonexclusive_enabled === true
      && Number.isInteger(amount)
      && amount > 0
      && /^[a-zA-Z0-9._-]+$/.test(bucket)
      && path.startsWith(`beatbay/${beat.id}/full/`)
      && termsVersion.length > 0
      && termsVersion.length <= 80
      && /^https:\/\/[^\s]+$/.test(termsUrl);
    if (!ready) return json(req, { error: "checkout_not_available" }, 409);

    const filename = deliveryFilename(String(beat.beat_code), String(beat.title), path);
    const attempt = {
      request_id: requestId,
      beat_id: beat.id,
      license_type: "nonexclusive",
      beat_code: String(beat.beat_code).slice(0, 80),
      beat_title: String(beat.title).slice(0, 180),
      amount_cents: amount,
      currency: "usd",
      terms_version: termsVersion,
      terms_url: termsUrl,
      delivery_bucket: bucket,
      delivery_path: path,
      delivery_filename: filename,
      updated_at: new Date().toISOString(),
    };
    const inserted = await supabase.from("beatbay_checkout_attempts").insert(attempt);
    if (inserted.error && (inserted.error as any).code !== "23505") throw inserted.error;
    if (inserted.error) {
      const { data: existing, error } = await supabase.from("beatbay_checkout_attempts")
        .select("beat_id,license_type,amount_cents,currency,terms_version,delivery_path")
        .eq("request_id", requestId).maybeSingle();
      if (error) throw error;
      if (!existing || existing.beat_id !== beat.id || existing.license_type !== "nonexclusive"
        || existing.amount_cents !== amount || existing.currency !== "usd"
        || existing.terms_version !== termsVersion || existing.delivery_path !== path) {
        return json(req, { error: "request_conflict" }, 409);
      }
    }

    const params = new URLSearchParams();
    params.set("mode", "payment");
    params.set("line_items[0][price_data][currency]", "usd");
    params.set("line_items[0][price_data][unit_amount]", String(amount));
    params.set("line_items[0][price_data][product_data][name]", `${beat.beat_code} — ${beat.title}`.slice(0, 250));
    params.set("line_items[0][price_data][product_data][description]", `BeatBay standard non-exclusive license · Terms ${termsVersion}`.slice(0, 250));
    params.set("line_items[0][quantity]", "1");
    params.set("metadata[checkout_source]", "beatbay_nonexclusive");
    params.set("metadata[beat_id]", beat.id);
    params.set("metadata[license_type]", "nonexclusive");
    params.set("metadata[checkout_request_id]", requestId);
    params.set("metadata[amount_cents]", String(amount));
    params.set("metadata[currency]", "usd");
    params.set("metadata[terms_version]", termsVersion);
    params.set("client_reference_id", requestId);
    params.set("customer_creation", "always");
    params.set("integration_identifier", await integrationIdentifier(requestId));
    params.set("success_url", `https://rosettacrew.com/beatbay/?checkout=success&beat=${encodeURIComponent(beat.id)}&session_id={CHECKOUT_SESSION_ID}`);
    params.set("cancel_url", `https://rosettacrew.com/beatbay/?checkout=cancel&beat=${encodeURIComponent(beat.id)}`);

    const session = await createStripeSession(stripeKey(), params, requestId);
    const updated = await supabase.from("beatbay_checkout_attempts").update({
      stripe_checkout_session_id: session.id,
      checkout_created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("request_id", requestId);
    if (updated.error) throw updated.error;
    return json(req, { url: session.url });
  } catch (error) {
    const code = error instanceof Error ? error.message : "checkout_unavailable";
    if (code === "body_too_large") return json(req, { error: code }, 413);
    if (error instanceof SyntaxError) return json(req, { error: "invalid_request" }, 400);
    console.error("beatbay-checkout failed", { code });
    return json(req, { error: "checkout_unavailable" }, 500);
  }
});
