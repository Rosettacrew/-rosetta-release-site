import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
  "access-control-allow-methods": "POST,OPTIONS",
};

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
  if (!url || !key) throw new Error("Support checkout backend unavailable");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function stripePost(path: string, params: URLSearchParams) {
  const secret = Deno.env.get("STRIPE_SECRET_KEY");
  if (!secret) throw new Error("Stripe is not configured");
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message ?? body?.error ?? `Stripe ${path} failed`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return body;
}

function floorPriceCents(product: {
  status: string;
  presale_price_cents: number | null;
  release_price_cents: number | null;
}): number | null {
  if (product.status === "presale" && product.presale_price_cents != null) {
    return product.presale_price_cents;
  }
  return product.release_price_cents ?? product.presale_price_cents;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405);

  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ error: "Invalid JSON body" }, 400);

    const productId = String((body as any).product_id ?? "").trim();
    const amountCents = (body as any).amount_cents;

    if (!productId) return json({ error: "product_id required" }, 400);
    if (!Number.isInteger(amountCents)) {
      return json({ error: "amount_cents must be an integer" }, 400);
    }

    const supabase = adminClient();
    const { data: product, error: productError } = await supabase
      .from("release_products")
      .select(
        "id,slug,artist_name,title,status,presale_price_cents,release_price_cents,currency,storefront_enabled,published_at,stripe_payment_link_url",
      )
      .eq("id", productId)
      .maybeSingle();

    if (productError) throw productError;
    if (!product) return json({ error: "Product not found" }, 404);
    if (
      !product.storefront_enabled ||
      !product.published_at ||
      !["live", "presale"].includes(product.status)
    ) {
      return json({ error: "Product not available for support checkout" }, 400);
    }

    // Same sandbox / test Payment Link filter as release-storefront
    const link = String(product.stripe_payment_link_url ?? "");
    const title = String(product.title ?? "");
    const slug = String(product.slug ?? "");
    if (
      /\/test_/i.test(link) ||
      /buy\.stripe\.com\/test/i.test(link) ||
      /sandbox/i.test(title) ||
      /sandbox/i.test(slug)
    ) {
      return json({ error: "Product not available for support checkout" }, 400);
    }

    const floor = floorPriceCents(product);
    if (floor == null || floor < 1) {
      return json({ error: "Product has no valid floor price" }, 400);
    }
    if (amountCents < floor) {
      return json({
        error: `amount_cents must be at least ${floor}`,
        floor_cents: floor,
      }, 400);
    }

    const currency = String(product.currency ?? "usd").trim().toLowerCase() || "usd";
    const name = `${product.artist_name ?? ""} — ${product.title ?? ""}`
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 250);

    const params = new URLSearchParams();
    params.set("mode", "payment");
    params.set("line_items[0][price_data][currency]", currency);
    params.set("line_items[0][price_data][unit_amount]", String(amountCents));
    params.set("line_items[0][price_data][product_data][name]", name || "Rosetta Crew Release");
    params.set("line_items[0][quantity]", "1");
    params.set("metadata[release_product_id]", product.id);
    params.set("metadata[checkout_source]", "support_the_artist");
    params.set("client_reference_id", product.id);
    params.set("customer_creation", "always");
    params.set(
      "success_url",
      `https://rosettacrew.com/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    );
    params.set("cancel_url", "https://rosettacrew.com/?checkout=cancel");

    const session = await stripePost("checkout/sessions", params);
    if (!session?.url) throw new Error("Stripe did not return a checkout URL");

    return json({ url: session.url });
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
