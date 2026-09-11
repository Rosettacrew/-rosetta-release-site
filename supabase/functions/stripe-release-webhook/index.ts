import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256(secret: string, payload: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
async function verifyStripeSignature(rawBody: string, signatureHeader: string, secret: string) {
  const parts = signatureHeader.split(",");
  const timestamp = parts.find((p) => p.startsWith("t="))?.slice(2);
  const signatures = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!timestamp || signatures.length === 0) return false;

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;

  const expected = await hmacSha256(secret, timestamp + "." + rawBody);
  return signatures.some((sig) => timingSafeEqual(sig, expected));
}


function normalizeCountry(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  const c = code.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) ? c : null;
}

function normalizeRegion(state: unknown): string | null {
  if (typeof state !== 'string') return null;
  const s = state.trim();
  return s.length > 0 ? s : null;
}
/**
 * Resolve coarse geo for order_geo. Preference: shipping country → card country → skip.
 * Do NOT use ip_coarse / store IP. Do NOT map customer_details.address (billing) as shipping.
 * Retention: order_geo rows live with parent release_orders (ON DELETE CASCADE);
 * target retention ≤24 months or match order retention — no separate PII archive.
 */
async function resolveOrderGeo(
  session: any,
  stripeSecretKey: string | undefined,
): Promise<{ country_code: string; region_code: string | null; geo_source: 'stripe_shipping' | 'stripe_card' } | null> {
  const shippingCountry = normalizeCountry(
    session?.shipping_details?.address?.country ??
      session?.collected_information?.shipping_details?.address?.country,
  );
  if (shippingCountry) {
    const region_code = normalizeRegion(
      session?.shipping_details?.address?.state ??
        session?.collected_information?.shipping_details?.address?.state,
    );
    return { country_code: shippingCountry, region_code, geo_source: 'stripe_shipping' };
  }

  if (!stripeSecretKey) return null;

  const piId =
    typeof session?.payment_intent === 'string'
      ? session.payment_intent
      : session?.payment_intent?.id ?? null;
  if (!piId) return null;
  try {
    const url = "https://api.stripe.com/v1/payment_intents/" + encodeURIComponent(piId) + "?expand[]=payment_method";
    const res = await fetch(url, {
      headers: { Authorization: "Bearer " + stripeSecretKey },
    });
    if (!res.ok) {
      console.error("order_geo: PaymentIntent retrieve failed status=" + res.status);
      return null;
    }
    const pi = await res.json();
    const cardCountry = normalizeCountry(pi?.payment_method?.card?.country);
    if (cardCountry) {
      return { country_code: cardCountry, region_code: null, geo_source: 'stripe_card' };
    }
  } catch (err) {
    console.error('order_geo: PaymentIntent retrieve error', err instanceof Error ? err.message : String(err));
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const stripeSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!stripeSecret || !supabaseUrl || !serviceRoleKey) {
    console.error("Missing required environment secrets");
    return new Response("Server configuration error", { status: 500 });
  }

  const rawBody = await req.text();
  const signature = req.headers.get("stripe-signature") ?? "";
  if (!(await verifyStripeSignature(rawBody, signature, stripeSecret))) {
    return new Response("Invalid signature", { status: 400 });
  }
  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const eventInsert = await supabase.from("stripe_webhook_events").insert({
    stripe_event_id: event.id,
    event_type: event.type,
    processing_status: "received",
  });

  if (eventInsert.error) {
    if ((eventInsert.error as any).code === "23505") {
      return new Response(JSON.stringify({ received: true, duplicate: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    console.error(eventInsert.error);
    return new Response("Database error", { status: 500 });
  }

  const markEvent = async (status: "processed" | "ignored" | "failed", lastError: string | null = null) => {
    await supabase
      .from("stripe_webhook_events")
      .update({ processing_status: status, processed_at: new Date().toISOString(), last_error: lastError })
      .eq("stripe_event_id", event.id);
  };

  try {
    const handled = new Set([
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      "checkout.session.async_payment_failed",
    ]);

    if (!handled.has(event.type)) {
      await markEvent("ignored");
      return new Response(JSON.stringify({ received: true, ignored: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const session = event.data?.object ?? {};
    const paymentLinkId = typeof session.payment_link === "string" ? session.payment_link : session.payment_link?.id;

    let product: { id: string; release_at: string } | null = null;

    if (paymentLinkId) {
      const { data, error: productError } = await supabase
        .from("release_products")
        .select("id, release_at")
        .eq("stripe_payment_link_id", paymentLinkId)
        .maybeSingle();
      if (productError) throw productError;
      product = data;
      if (!product) {
        await markEvent("ignored");
        return new Response(JSON.stringify({ received: true, ignored: "unknown_payment_link" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    } else {
      const productId =
        session.metadata?.release_product_id ||
        session.client_reference_id ||
        null;
      if (!productId) {
        await markEvent("ignored");
        return new Response(JSON.stringify({ received: true, ignored: "no_product" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const { data, error: productError } = await supabase
        .from("release_products")
        .select("id, release_at")
        .eq("id", productId)
        .maybeSingle();
      if (productError) throw productError;
      product = data;
      if (!product) {
        await markEvent("ignored");
        return new Response(JSON.stringify({ received: true, ignored: "unknown_product" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }

    const email = session.customer_details?.email ?? session.customer_email ?? null;
    if (!email) throw new Error("Checkout Session missing customer email");

    const eventFailed = event.type === "checkout.session.async_payment_failed";
    const paid = !eventFailed && (session.payment_status === "paid" || session.payment_status === "no_payment_required" || event.type === "checkout.session.async_payment_succeeded");
    const paymentStatus = eventFailed ? "failed" : paid ? "paid" : "processing";

    const orderPayload = {
      product_id: product.id,
      stripe_checkout_session_id: session.id,
      stripe_payment_intent_id: typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null,
      stripe_customer_id: typeof session.customer === "string" ? session.customer : session.customer?.id ?? null,
      customer_email: email.toLowerCase(),
      amount_total_cents: session.amount_total ?? 0,
      currency: session.currency ?? "usd",
      payment_status: paymentStatus,
      paid_at: paid ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    };

    const { data: order, error: orderError } = await supabase
      .from("release_orders")
      .upsert(orderPayload, { onConflict: "stripe_checkout_session_id" })
      .select("id")
      .single();

    if (orderError) throw orderError;
    if (paid) {
      const now = Date.now();
      const availableAt = new Date(product.release_at).getTime();
      const entitlementStatus = now >= availableAt ? "available" : "locked";

      const { error: entitlementError } = await supabase
        .from("release_entitlements")
        .upsert({
          product_id: product.id,
          order_id: order.id,
          customer_email: email.toLowerCase(),
          status: entitlementStatus,
          available_at: product.release_at,
          updated_at: new Date().toISOString(),
        }, { onConflict: "order_id" });

      if (entitlementError) throw entitlementError;

      // Soft-fail order_geo: never fail webhook / entitlement if geo write fails.
      // Retention: geo rows cascade with parent order (ON DELETE CASCADE); keep ≤24 months or match order retention.
      try {
        const geo = await resolveOrderGeo(session, Deno.env.get("STRIPE_SECRET_KEY"));
        if (geo) {
          const { error: geoError } = await supabase.from("order_geo").upsert({
            order_id: order.id,
            country_code: geo.country_code,
            region_code: geo.region_code,
            geo_source: geo.geo_source,
          }, { onConflict: "order_id" });
          if (geoError) console.error("order_geo upsert error", geoError);
        }
      } catch (geoErr) {
        console.error("order_geo soft-fail", geoErr instanceof Error ? geoErr.message : String(geoErr));
      }
    }
    await markEvent("processed");
    return new Response(JSON.stringify({ received: true, processed: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    await markEvent("failed", message.slice(0, 1000));
    return new Response("Webhook processing failed", { status: 500 });
  }
});
