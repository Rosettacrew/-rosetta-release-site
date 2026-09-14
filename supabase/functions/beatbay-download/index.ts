import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, number[]>();

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
});

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
  return { ok: true as const };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  const limited = rateLimit(`beatbay-download:${clientIp(req)}`);
  if (!limited.ok) return json({ error: "too_many_requests", retry_after: limited.retryAfter }, 429, { "retry-after": String(limited.retryAfter) });

  const token = new URL(req.url).searchParams.get("token") ?? "";
  if (!/^[a-f0-9]{64}$/.test(token)) return json({ error: "invalid_token" }, 404);
  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim();
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "service_unavailable" }, 503);
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const tokenHash = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

  const { data: consumed, error: consumeError } = await supabase.rpc("consume_beatbay_download_token", { p_token_hash: tokenHash }).maybeSingle();
  if (consumeError) return json({ error: "service_unavailable" }, 503);
  if (!consumed?.license_id) return json({ error: "invalid_or_unavailable_token" }, 404);

  const { data: license, error: licenseError } = await supabase.from("beatbay_licenses")
    .select("id,status,delivery_bucket,delivery_path,delivery_filename")
    .eq("id", consumed.license_id).maybeSingle();
  if (licenseError || !license || license.status !== "active") return json({ error: "license_unavailable" }, 403);

  const { data: signed, error: signedError } = await supabase.storage.from(license.delivery_bucket)
    .createSignedUrl(license.delivery_path, 60, { download: license.delivery_filename || true });
  if (signedError || !signed?.signedUrl) return json({ error: "file_unavailable" }, 503);
  await supabase.from("beatbay_delivery_log").insert({
    license_id: license.id,
    delivery_type: "download",
    status: "downloaded",
    details: { token_id: consumed.token_id, download_count: consumed.download_count },
  });
  return Response.redirect(signed.signedUrl, 302);
});
