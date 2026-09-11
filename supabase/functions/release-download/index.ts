import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
  "access-control-allow-methods": "POST,OPTIONS",
};

const SIGNED_URL_TTL = 180;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}

function adminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const secretJson = Deno.env.get("SUPABASE_SECRET_KEYS");
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const key = secretJson ? JSON.parse(secretJson)?.default : legacy;
  if (!url || !key) throw new Error("Download backend unavailable");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function softLog(
  supabase: ReturnType<typeof createClient>,
  row: Record<string, unknown>,
) {
  try {
    const { error } = await supabase.from("release_delivery_log").insert(row);
    if (error) console.error("release_delivery_log soft-fail", error);
  } catch (err) {
    console.error("release_delivery_log soft-fail", err instanceof Error ? err.message : String(err));
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405);

  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ error: "Invalid JSON body" }, 400);

    const email = String((body as any).email ?? "").trim().toLowerCase();
    const sessionId = String((body as any).session_id ?? "").trim();
    const orderId = String((body as any).order_id ?? "").trim();

    if (!email) return json({ error: "email required" }, 400);
    if (!sessionId && !orderId) {
      return json({ error: "session_id or order_id required" }, 400);
    }

    const supabase = adminClient();

    // Prefer stripe_checkout_session_id lookup; require paid + matching email.
    // Never trust a client "paid" flag — only webhook-written release_orders.
    let orderQuery = supabase
      .from("release_orders")
      .select("id,product_id,customer_email,payment_status,stripe_checkout_session_id")
      .eq("customer_email", email)
      .eq("payment_status", "paid");

    if (sessionId) {
      orderQuery = orderQuery.eq("stripe_checkout_session_id", sessionId);
    } else {
      orderQuery = orderQuery.eq("id", orderId);
    }

    const { data: order, error: orderError } = await orderQuery.maybeSingle();
    if (orderError) throw orderError;
    if (!order) return json({ error: "Order not found" }, 404);
    const { data: entitlement, error: entError } = await supabase
      .from("release_entitlements")
      .select("id,order_id,product_id,status,available_at,customer_email")
      .eq("order_id", order.id)
      .maybeSingle();
    if (entError) throw entError;
    if (!entitlement) return json({ error: "Entitlement not found" }, 404);

    const { data: product, error: productError } = await supabase
      .from("release_products")
      .select("id,release_at,storage_object_path,storage_bucket,delivery_filename")
      .eq("id", order.product_id)
      .maybeSingle();
    if (productError) throw productError;
    if (!product) return json({ error: "Product not found" }, 404);

    const unlockAt = product.release_at ? new Date(product.release_at).getTime() : NaN;
    if (!Number.isFinite(unlockAt) || Date.now() < unlockAt) {
      // Optionally keep entitlement locked; never mint a signed URL early.
      if (entitlement.status !== "locked") {
        try {
          await supabase
            .from("release_entitlements")
            .update({ status: "locked", updated_at: new Date().toISOString() })
            .eq("id", entitlement.id);
        } catch (_) { /* soft */ }
      }
      await softLog(supabase, {
        entitlement_id: entitlement.id,
        delivery_type: "download",
        status: "denied",
        details: { reason: "locked_until_release", unlock_at: product.release_at },
      });
      return json({
        error: "Downloads unlock on release day",
        unlock_at: product.release_at,
      }, 403);
    }
    if (!product.storage_object_path) {
      return json({ error: "Package not available yet" }, 404);
    }

    const bucket = product.storage_bucket || "release-private";
    const downloadName = product.delivery_filename || undefined;
    const { data: signed, error: signedError } = await supabase.storage
      .from(bucket)
      .createSignedUrl(product.storage_object_path, SIGNED_URL_TTL, {
        download: downloadName || true,
      });
    if (signedError) throw signedError;
    if (!signed?.signedUrl) throw new Error("Failed to create download URL");

    // Flip locked → available once unlock time has passed
    if (entitlement.status === "locked") {
      try {
        await supabase
          .from("release_entitlements")
          .update({
            status: "available",
            updated_at: new Date().toISOString(),
          })
          .eq("id", entitlement.id);
      } catch (_) { /* soft */ }
    }

    await softLog(supabase, {
      entitlement_id: entitlement.id,
      delivery_type: "download",
      status: "downloaded",
      details: {
        expires_in: SIGNED_URL_TTL,
        bucket,
        path: product.storage_object_path,
      },
    });

    return json({ download_url: signed.signedUrl, expires_in: SIGNED_URL_TTL });
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
