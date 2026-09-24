import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const encoder = new TextEncoder();
const DOWNLOAD_MAX = 5;
const DOWNLOAD_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_WEBHOOK_BYTES = 1024 * 1024;

function hex(buffer: ArrayBuffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
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

function timingSafeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index++) result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return result === 0;
}

async function verifyStripeSignature(rawBody: string, header: string, secret: string) {
  const fields = header.split(",");
  const timestamp = fields.find((part) => part.startsWith("t="))?.slice(2);
  const signatures = fields.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
  if (!timestamp || !signatures.length) return false;
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;
  const expected = await hmacSha256(secret, `${timestamp}.${rawBody}`);
  return signatures.some((signature) => timingSafeEqual(signature, expected));
}

async function readRawBody(req: Request) {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) throw new Error("Webhook body too large");
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_WEBHOOK_BYTES) {
      await reader.cancel();
      throw new Error("Webhook body too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return hex(bytes.buffer);
}

async function licenseNumber(sessionId: string) {
  const value = (await sha256(sessionId)).slice(0, 12).toUpperCase();
  return `BB-NX-${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8, 12)}`;
}

async function deliverLicense(opts: {
  supabase: ReturnType<typeof createClient>;
  license: any;
  beatCode: string;
  beatTitle: string;
  amountCents: number;
  currency: string;
}) {
  const { supabase, license, beatCode, beatTitle, amountCents, currency } = opts;
  const { data: existing, error: existingError } = await supabase.from("beatbay_download_tokens")
    .select("id,email_sent_at").eq("license_id", license.id).is("revoked_at", null)
    .gt("expires_at", new Date().toISOString()).limit(1).maybeSingle();
  if (existingError) throw existingError;
  if (existing?.id && existing.email_sent_at) return;
  if (existing?.id) {
    const removed = await supabase.from("beatbay_download_tokens").delete().eq("id", existing.id);
    if (removed.error) throw removed.error;
  }

  const resendKey = Deno.env.get("RESEND_API_KEY")?.trim();
  const from = Deno.env.get("BEATBAY_LICENSE_EMAIL_FROM")?.trim()
    || Deno.env.get("RELEASE_DOWNLOAD_EMAIL_FROM")?.trim();
  if (!resendKey || !from) throw new Error("BeatBay license email is not configured");

  const rawToken = randomToken();
  const expiresAt = new Date(Date.now() + DOWNLOAD_TTL_MS).toISOString();
  const { data: tokenRow, error: tokenError } = await supabase.from("beatbay_download_tokens").insert({
    license_id: license.id,
    token_hash: await sha256(rawToken),
    expires_at: expiresAt,
    max_downloads: DOWNLOAD_MAX,
    download_count: 0,
  }).select("id").single();
  if (tokenError || !tokenRow?.id) throw tokenError ?? new Error("Download token was not created");

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.replace(/\/$/, "") ?? "";
  const downloadUrl = `${supabaseUrl}/functions/v1/beatbay-download?token=${rawToken}`;
  const paid = new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(amountCents / 100);
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${resendKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from,
        to: [license.customer_email],
        subject: `Your BeatBay license — ${beatCode} ${beatTitle}`,
        text: [
          "Thank you for licensing from BeatBay Exchange.",
          "",
          `Beat: ${beatCode} — ${beatTitle}`,
          "License: Standard Non-Exclusive",
          `License number: ${license.license_number}`,
          `Amount paid: ${paid}`,
          `Terms version: ${license.terms_version}`,
          `License terms: ${license.terms_url}`,
          "",
          "Secure master download:",
          downloadUrl,
          "",
          `This personal link expires ${expiresAt} and permits up to ${DOWNLOAD_MAX} downloads.`,
          "Keep this email as your license receipt.",
          "",
          "BeatBay Exchange — Powered by Rosetta Crew Music Group",
        ].join("\n"),
      }),
    });
    if (!response.ok) throw new Error(`Email provider returned ${response.status}`);
    const marked = await supabase.from("beatbay_download_tokens")
      .update({ email_sent_at: new Date().toISOString() }).eq("id", tokenRow.id);
    if (marked.error) throw marked.error;
    await supabase.from("beatbay_delivery_log").insert({
      license_id: license.id,
      delivery_type: "email",
      status: "sent",
      details: { token_id: tokenRow.id },
    });
  } catch (error) {
    await supabase.from("beatbay_download_tokens").delete().eq("id", tokenRow.id);
    throw error;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const webhookSecret = Deno.env.get("BEATBAY_STRIPE_WEBHOOK_SECRET")?.trim();
  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim();
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (!webhookSecret || !supabaseUrl || !serviceRoleKey) return new Response("Server configuration error", { status: 500 });

  let rawBody = "";
  try {
    rawBody = await readRawBody(req);
  } catch {
    return new Response("Payload too large", { status: 413 });
  }
  if (!(await verifyStripeSignature(rawBody, req.headers.get("stripe-signature") ?? "", webhookSecret))) {
    return new Response("Invalid signature", { status: 400 });
  }
  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  if (typeof event?.id !== "string" || !/^evt_[A-Za-z0-9]+$/.test(event.id) || event.id.length > 255
    || typeof event?.type !== "string" || event.type.length > 255) {
    return new Response("Invalid event", { status: 400 });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const eventInsert = await supabase.from("beatbay_stripe_webhook_events").insert({
    stripe_event_id: event.id,
    event_type: event.type,
    processing_status: "received",
  });
  if (eventInsert.error) {
    if ((eventInsert.error as any).code !== "23505") return new Response("Database error", { status: 500 });
    const { data: existing, error } = await supabase.from("beatbay_stripe_webhook_events")
      .select("processing_status,created_at").eq("stripe_event_id", event.id).maybeSingle();
    if (error) return new Response("Database error", { status: 500 });
    if (["processed", "ignored"].includes(existing?.processing_status ?? "")) {
      return new Response(JSON.stringify({ received: true, duplicate: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const staleBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    let reclaim = supabase.from("beatbay_stripe_webhook_events")
      .update({ processing_status: "received", processed_at: null, last_error: null })
      .eq("stripe_event_id", event.id);
    reclaim = existing?.processing_status === "failed"
      ? reclaim.eq("processing_status", "failed")
      : reclaim.eq("processing_status", "received").lt("created_at", staleBefore);
    const { data: reclaimed, error: reclaimError } = await reclaim.select("stripe_event_id").maybeSingle();
    if (reclaimError) return new Response("Database error", { status: 500 });
    if (!reclaimed) return new Response("Event is already processing", { status: 409, headers: { "retry-after": "300" } });
  }

  const mark = async (status: "processed" | "ignored" | "failed", lastError: string | null = null) => {
    await supabase.from("beatbay_stripe_webhook_events").update({
      processing_status: status,
      processed_at: new Date().toISOString(),
      last_error: lastError,
    }).eq("stripe_event_id", event.id);
  };

  try {
    const handled = new Set([
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      "checkout.session.async_payment_failed",
    ]);
    if (!handled.has(event.type)) {
      await mark("ignored");
      return new Response(JSON.stringify({ received: true, ignored: true }), { status: 200, headers: { "content-type": "application/json" } });
    }

    const session = event.data?.object ?? {};
    if (session.metadata?.checkout_source !== "beatbay_nonexclusive") {
      await mark("ignored");
      return new Response(JSON.stringify({ received: true, ignored: "unexpected_checkout_source" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const requestId = String(session.metadata?.checkout_request_id ?? "");
    const beatId = String(session.metadata?.beat_id ?? "");
    const { data: attempt, error: attemptError } = await supabase.from("beatbay_checkout_attempts")
      .select("request_id,beat_id,license_type,beat_code,beat_title,amount_cents,currency,terms_version,terms_url,delivery_bucket,delivery_path,delivery_filename,stripe_checkout_session_id")
      .eq("request_id", requestId).maybeSingle();
    if (attemptError) throw attemptError;
    const actualAmount = Number(session.amount_total);
    const actualCurrency = String(session.currency ?? "").toLowerCase();
    if (!attempt
      || attempt.beat_id !== beatId
      || attempt.license_type !== "nonexclusive"
      || session.metadata?.license_type !== "nonexclusive"
      || session.metadata?.amount_cents !== String(attempt.amount_cents)
      || session.metadata?.currency !== attempt.currency
      || session.metadata?.terms_version !== attempt.terms_version
      || session.client_reference_id !== requestId
      || attempt.stripe_checkout_session_id !== session.id
      || actualAmount !== attempt.amount_cents
      || actualCurrency !== attempt.currency) {
      await mark("ignored");
      return new Response(JSON.stringify({ received: true, ignored: "invalid_beatbay_session" }), { status: 200, headers: { "content-type": "application/json" } });
    }

    const email = String(session.customer_details?.email ?? session.customer_email ?? "").trim().toLowerCase();
    if (!email || email.length > 320) throw new Error("Checkout Session missing customer email");
    const eventFailed = event.type === "checkout.session.async_payment_failed";
    const paid = !eventFailed && session.payment_status === "paid";
    const paymentStatus = eventFailed ? "failed" : paid ? "paid" : "processing";
    const { data: order, error: orderError } = await supabase.from("beatbay_orders").upsert({
      checkout_request_id: attempt.request_id,
      beat_id: attempt.beat_id,
      license_type: "nonexclusive",
      stripe_checkout_session_id: session.id,
      stripe_payment_intent_id: typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null,
      stripe_customer_id: typeof session.customer === "string" ? session.customer : session.customer?.id ?? null,
      customer_email: email,
      amount_total_cents: actualAmount,
      currency: actualCurrency,
      payment_status: paymentStatus,
      paid_at: paid ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "stripe_checkout_session_id" }).select("id").single();
    if (orderError || !order?.id) throw orderError ?? new Error("Order was not created");

    if (paid) {
      const { data: license, error: licenseError } = await supabase.from("beatbay_licenses").upsert({
        order_id: order.id,
        beat_id: attempt.beat_id,
        license_number: await licenseNumber(session.id),
        license_type: "nonexclusive",
        customer_email: email,
        terms_version: attempt.terms_version,
        terms_url: attempt.terms_url,
        delivery_bucket: attempt.delivery_bucket,
        delivery_path: attempt.delivery_path,
        delivery_filename: attempt.delivery_filename,
        status: "active",
        updated_at: new Date().toISOString(),
      }, { onConflict: "order_id" }).select("*").single();
      if (licenseError || !license?.id) throw licenseError ?? new Error("License was not issued");
      await deliverLicense({
        supabase,
        license,
        beatCode: attempt.beat_code,
        beatTitle: attempt.beat_title,
        amountCents: actualAmount,
        currency: actualCurrency,
      });
    }

    await mark("processed");
    return new Response(JSON.stringify({ received: true, processed: true }), { status: 200, headers: { "content-type": "application/json" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook processing failed";
    console.error("stripe-beatbay-webhook failed", { message });
    await mark("failed", message.slice(0, 500));
    return new Response("Webhook processing failed", { status: 500 });
  }
});
