import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const headers = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,OPTIONS",
  "content-type": "application/json",
  "cache-control": "public, max-age=60, stale-while-revalidate=300",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "GET") return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers });
  try {
    const url = Deno.env.get("SUPABASE_URL")?.trim();
    const secretJson = Deno.env.get("SUPABASE_SECRET_KEYS");
    const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const key = secretJson ? JSON.parse(secretJson)?.default : legacy;
    if (!url || !key) throw new Error("service_unavailable");
    const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: beats, error: beatError } = await supabase.from("beatbay_beats").select(
      "id,beat_code,title,producer,style,bpm,musical_key,description,tags,status,signature_sound,nonexclusive_enabled,nonexclusive_price_cents,exclusive_enabled,exclusive_price_cents,ownership_enabled,ownership_price_cents,preview_url,preview_duration_seconds,preview_pattern,is_featured,published_at,full_audio_bucket,full_audio_path,nonexclusive_terms_version,nonexclusive_terms_url",
    ).eq("storefront_enabled", true).not("published_at", "is", null).in("status", ["available", "hold"]).order("beat_code");
    if (beatError) throw beatError;
    const ids = (beats ?? []).map((beat: any) => beat.id);
    const { data: auctions, error: auctionError } = ids.length
      ? await supabase.from("beatbay_auctions").select(
        "id,beat_id,status,starting_bid_cents,current_bid_cents,minimum_increment_cents,starts_at,ends_at,payment_window_hours",
      ).in("beat_id", ids).in("status", ["scheduled", "live"]).order("created_at", { ascending: false })
      : { data: [], error: null };
    if (auctionError) throw auctionError;
    const auctionByBeat = new Map<string, any>();
    for (const auction of auctions ?? []) if (!auctionByBeat.has(auction.beat_id)) auctionByBeat.set(auction.beat_id, auction);
    const safeBeats = (beats ?? []).map((beat: any) => {
      const checkoutReady = beat.status === "available"
        && beat.nonexclusive_enabled === true
        && Number.isInteger(beat.nonexclusive_price_cents)
        && beat.nonexclusive_price_cents > 0
        && !!beat.full_audio_bucket
        && String(beat.full_audio_path ?? "").startsWith(`beatbay/${beat.id}/full/`)
        && !!beat.nonexclusive_terms_version
        && /^https:\/\/[^\s]+$/.test(String(beat.nonexclusive_terms_url ?? ""));
      const {
        full_audio_bucket: _bucket,
        full_audio_path: _path,
        nonexclusive_terms_version: _termsVersion,
        nonexclusive_terms_url: _termsUrl,
        ...publicBeat
      } = beat;
      return { ...publicBeat, checkout_ready: checkoutReady, auction: auctionByBeat.get(beat.id) ?? null };
    });
    return new Response(JSON.stringify({ beats: safeBeats }), { status: 200, headers });
  } catch (error) {
    console.error("beatbay-storefront failed", error instanceof Error ? error.message : "unknown");
    return new Response(JSON.stringify({ error: "storefront_unavailable" }), { status: 503, headers: { ...headers, "cache-control": "no-store" } });
  }
});
