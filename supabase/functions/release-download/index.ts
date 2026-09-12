import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);

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
    .select("storage_bucket, storage_object_path, delivery_filename")
    .eq("id", entitlement.product_id)
    .single();

  if (productError || !product?.storage_bucket || !product?.storage_object_path) return json({ error: "release_file_not_configured" }, 503);

  const { data: signed, error: signedError } = await supabase.storage
    .from(product.storage_bucket)
    .createSignedUrl(product.storage_object_path, 60, { download: product.delivery_filename || true });

  if (signedError || !signed?.signedUrl) return json({ error: "release_file_unavailable" }, 503);

  await supabase.from("release_download_tokens").update({ download_count: tokenRow.download_count + 1 }).eq("id", tokenRow.id);
  await supabase.from("release_delivery_log").insert({ entitlement_id: entitlement.id, delivery_type: "download", status: "downloaded", details: { token_id: tokenRow.id } });

  return Response.redirect(signed.signedUrl, 302);
});
