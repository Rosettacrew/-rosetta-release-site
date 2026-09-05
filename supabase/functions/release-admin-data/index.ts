import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,apikey,content-type", "access-control-allow-methods": "GET,OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });
function adminClient() { const url = Deno.env.get("SUPABASE_URL"); const modern = Deno.env.get("SUPABASE_SECRET_KEYS"); const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"); const key = modern ? JSON.parse(modern)?.default : legacy; if (!url || !key) throw new Error("Backend unavailable"); return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }); }
async function isOwner(req: Request, supabase: any) { const header = req.headers.get("authorization") || ""; const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : ""; if (!token) return false; const { data, error } = await supabase.auth.getUser(token); if (error || !data.user) return false; const { data: member } = await supabase.from("release_admin_users").select("role,is_active").eq("user_id", data.user.id).eq("is_active", true).maybeSingle(); return !!member && ["owner", "admin"].includes(member.role); }

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "GET") return json({ error: "Method Not Allowed" }, 405);
  try {
    const supabase = adminClient();
    if (!(await isOwner(req, supabase))) return json({ error: "Owner approval required" }, 403);
    const view = new URL(req.url).searchParams.get("view") || "overview";
    if (view === "orders") { const { data, error } = await supabase.from("release_orders").select("id,customer_email,amount_total_cents,currency,payment_status,paid_at,created_at,release_products(title,artist_name)").order("created_at", { ascending: false }).limit(250); if (error) throw error; return json({ orders: data }); }
    if (view === "deliveries") { const { data, error } = await supabase.from("release_entitlements").select("id,customer_email,status,available_at,delivered_at,created_at,release_products(title,artist_name),release_orders(payment_status,amount_total_cents,currency)").order("created_at", { ascending: false }).limit(250); if (error) throw error; return json({ deliveries: data }); }
    if (view === "downloads") { const { data, error } = await supabase.from("release_delivery_log").select("id,delivery_type,status,provider_message_id,details,created_at,release_entitlements(customer_email,release_products(title,artist_name))").order("created_at", { ascending: false }).limit(250); if (error) throw error; return json({ activity: data }); }
    const [{ count: paid }, { count: orders }, { count: delivered }, { count: downloads }] = await Promise.all([
      supabase.from("release_orders").select("id", { count: "exact", head: true }).eq("payment_status", "paid"),
      supabase.from("release_orders").select("id", { count: "exact", head: true }),
      supabase.from("release_entitlements").select("id", { count: "exact", head: true }).not("delivered_at", "is", null),
      supabase.from("release_delivery_log").select("id", { count: "exact", head: true }).eq("delivery_type", "download").eq("status", "downloaded"),
    ]);
    const { data: revenue, error } = await supabase.from("release_orders").select("amount_total_cents,currency").eq("payment_status", "paid");
    if (error) throw error;
    const revenueCents = (revenue || []).filter((row: any) => row.currency === "usd").reduce((sum: number, row: any) => sum + (row.amount_total_cents || 0), 0);
    return json({ overview: { paid_orders: paid || 0, total_orders: orders || 0, delivered: delivered || 0, downloads: downloads || 0, revenue_usd_cents: revenueCents } });
  } catch (error) { console.error(error); return json({ error: error instanceof Error ? error.message : String(error) }, 500); }
});
