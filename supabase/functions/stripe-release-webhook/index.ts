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


const DOWNLOAD_TOKEN_BYTES = 32;
const DOWNLOAD_MAX = 5;
const DOWNLOAD_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days from max(release_at, now)

function randomTokenHex(byteLength = DOWNLOAD_TOKEN_BYTES) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return hex(bytes.buffer);
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return hex(digest);
}

function downloadExpiresAt(releaseAtIso: string) {
  const releaseMs = new Date(releaseAtIso).getTime();
  const base = Number.isFinite(releaseMs) ? Math.max(releaseMs, Date.now()) : Date.now();
  return new Date(base + DOWNLOAD_TTL_MS).toISOString();
}

/**
 * Idempotent mint of release_download_tokens + soft-fail Resend email.
 * Never logs raw token. Never mutates release_products.release_at.
 */
async function mintDownloadTokenAndEmail(opts: {
  supabase: ReturnType<typeof createClient>;
  entitlementId: string;
  customerEmail: string;
  releaseAt: string;
  productTitle?: string | null;
}) {
  const { supabase, entitlementId, customerEmail, releaseAt, productTitle } = opts;

  const { data: existing, error: existingError } = await supabase
    .from("release_download_tokens")
    .select("id")
    .eq("entitlement_id", entitlementId)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .limit(1)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing?.id) {
    console.log("download_token: skip mint, active token exists", { token_id: existing.id, entitlement_id: entitlementId });
    return { tokenId: existing.id as string, minted: false };
  }

  const rawToken = randomTokenHex();
  const tokenHash = await sha256Hex(rawToken);
  const expiresAt = downloadExpiresAt(releaseAt);

  const { data: tokenRow, error: insertError } = await supabase
    .from("release_download_tokens")
    .insert({
      token_hash: tokenHash,
      entitlement_id: entitlementId,
      expires_at: expiresAt,
      max_downloads: DOWNLOAD_MAX,
      download_count: 0,
    })
    .select("id")
    .single();
  if (insertError) throw insertError;
  if (!tokenRow?.id) throw new Error("download_token insert returned no id");

  const tokenId = tokenRow.id as string;
  console.log("download_token: minted", { token_id: tokenId, entitlement_id: entitlementId, expires_at: expiresAt });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.replace(/\/$/, "") ?? "";
  const downloadUrl = `${supabaseUrl}/functions/v1/release-download?token=${rawToken}`;
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from =
    Deno.env.get("RELEASE_DOWNLOAD_EMAIL_FROM")?.trim() ||
    Deno.env.get("ACTIVITY_EMAIL_FROM")?.trim() ||
    "";

  if (!apiKey || !from) {
    console.log("download_token: email soft-fail not_configured", { token_id: tokenId });
    return { tokenId, minted: true };
  }

  try {
    const title = productTitle?.trim() || "your release";
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [customerEmail],
        subject: `Your Rosetta Crew download link — ${title}`,
        text: [
          `Thanks for supporting the artist.`,
          ``,
          `Use this secure link to download when the release unlocks:`,
          downloadUrl,
          ``,
          `This link is personal, expires on ${expiresAt}, and allows up to ${DOWNLOAD_MAX} downloads.`,
          `If the release is not unlocked yet, the link will respond with release_locked until the unlock time.`,
          ``,
          `— Rosetta Crew`,
        ].join("\n"),
      }),
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 300);
      console.error("download_token: email soft-fail", { token_id: tokenId, status: response.status, body });
    } else {
      console.log("download_token: email sent", { token_id: tokenId });
    }
  } catch (emailErr) {
    console.error(
      "download_token: email soft-fail",
      { token_id: tokenId },
      emailErr instanceof Error ? emailErr.message : String(emailErr),
    );
  }

  return { tokenId, minted: true };
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
    if ((eventInsert.error as any).code !== "23505") {
      console.error(eventInsert.error);
      return new Response("Database error", { status: 500 });
    }

    const { data: existingEvent, error: existingEventError } = await supabase
      .from("stripe_webhook_events")
      .select("processing_status")
      .eq("stripe_event_id", event.id)
      .maybeSingle();
    if (existingEventError) {
      console.error(existingEventError);
      return new Response("Database error", { status: 500 });
    }
    if (existingEvent?.processing_status !== "failed") {
      return new Response(JSON.stringify({ received: true, duplicate: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    const { data: reclaimedEvent, error: reclaimError } = await supabase
      .from("stripe_webhook_events")
      .update({ processing_status: "received", processed_at: null, last_error: null })
      .eq("stripe_event_id", event.id)
      .eq("processing_status", "failed")
      .select("stripe_event_id")
      .maybeSingle();
    if (reclaimError) {
      console.error(reclaimError);
      return new Response("Database error", { status: 500 });
    }
    if (!reclaimedEvent) {
      return new Response(JSON.stringify({ received: true, duplicate: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
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

    let product: {
      id: string;
      release_at: string;
      currency: string;
      storefront_enabled: boolean;
      published_at: string | null;
      status: string;
    } | null = null;

    if (paymentLinkId) {
      const { data, error: productError } = await supabase
        .from("release_products")
        .select("id, release_at, currency, storefront_enabled, published_at, status")
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
      if (session.metadata?.checkout_source !== "support_the_artist") {
        await markEvent("ignored");
        return new Response(JSON.stringify({ received: true, ignored: "unexpected_checkout_source" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      const productId = session.metadata?.release_product_id ?? null;
      if (
        !productId ||
        (session.client_reference_id && session.client_reference_id !== productId)
      ) {
        await markEvent("ignored");
        return new Response(JSON.stringify({ received: true, ignored: "invalid_product_reference" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const { data, error: productError } = await supabase
        .from("release_products")
        .select("id, release_at, currency, storefront_enabled, published_at, status")
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

      const expectedAmount = Number(session.metadata?.checkout_amount_cents);
      const recordedFloor = Number(session.metadata?.checkout_floor_cents);
      const actualAmount = Number(session.amount_total);
      const actualCurrency = String(session.currency ?? "").toLowerCase();
      const productCurrency = String(product.currency ?? "usd").toLowerCase();
      if (
        !product.storefront_enabled ||
        !product.published_at ||
        !["live", "presale"].includes(product.status) ||
        !Number.isInteger(expectedAmount) ||
        !Number.isInteger(recordedFloor) ||
        !Number.isInteger(actualAmount) ||
        expectedAmount < recordedFloor ||
        actualAmount !== expectedAmount ||
        actualCurrency !== productCurrency
      ) {
        await markEvent("ignored");
        return new Response(JSON.stringify({ received: true, ignored: "invalid_support_session" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }

    const email = session.customer_details?.email ?? session.customer_email ?? null;
    if (!email) throw new Error("Checkout Session missing customer email");

    const eventFailed = event.type === "checkout.session.async_payment_failed";
    const paid = !eventFailed && session.payment_status === "paid";
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

      const { data: entitlement, error: entitlementError } = await supabase
        .from("release_entitlements")
        .upsert({
          product_id: product.id,
          order_id: order.id,
          customer_email: email.toLowerCase(),
          status: entitlementStatus,
          available_at: product.release_at,
          updated_at: new Date().toISOString(),
        }, { onConflict: "order_id" })
        .select("id")
        .single();

      if (entitlementError) throw entitlementError;
      if (!entitlement?.id) throw new Error("entitlement upsert returned no id");

      // Mint opaque download token + soft-fail Resend (both payment_link and STA Session).
      // Idempotent: skip if active non-revoked non-expired token exists for entitlement.
      await mintDownloadTokenAndEmail({
        supabase,
        entitlementId: entitlement.id,
        customerEmail: email.toLowerCase(),
        releaseAt: product.release_at,
      });

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
