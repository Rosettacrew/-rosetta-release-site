import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });

function adminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const modern = Deno.env.get("SUPABASE_SECRET_KEYS");
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const key = modern ? JSON.parse(modern)?.default : legacy;
  if (!url || !key) throw new Error("Backend unavailable");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function requireOwner(req: Request, supabase: any) {
  const header = req.headers.get("authorization") || "";
  const token = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";
  if (!token) return null;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;

  const { data: member, error: memberError } = await supabase
    .from("release_admin_users")
    .select("role,is_active")
    .eq("user_id", data.user.id)
    .eq("is_active", true)
    .maybeSingle();
  if (memberError || !member || member.role !== "owner") {
    return null;
  }
  return { user: data.user, member };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const supabase = adminClient();
    if (!(await requireOwner(req, supabase))) {
      return json({ error: "Owner approval required" }, 403);
    }

    if (req.method === "GET") {
      const { data: accounts, error: accountError } = await supabase
        .from("release_social_accounts")
        .select(
          "id,provider,account_label,external_account_id,connection_status,metadata,updated_at",
        )
        .order("provider");
      if (accountError) throw accountError;

      const { data: posts, error: postError } = await supabase
        .from("release_social_posts")
        .select(
          "id,product_id,provider,post_type,caption,media_url,scheduled_for,status,provider_post_id,published_at,error_message,created_at",
        )
        .order("created_at", { ascending: false })
        .limit(100);
      if (postError) throw postError;
      return json({ accounts, posts });
    }

    if (req.method !== "POST") {
      return json({ error: "Method Not Allowed" }, 405);
    }

    const body = await req.json();
    const action = String(body?.action || "");

    if (action === "create_draft") {
      const provider = String(body.provider || "");
      if (!["instagram", "facebook", "tiktok", "youtube", "x"].includes(provider)) {
        return json({ error: "Unsupported provider" }, 400);
      }
      const { data, error } = await supabase
        .from("release_social_posts")
        .insert({
          product_id: body.product_id || null,
          provider,
          post_type: body.post_type || "promo",
          caption: String(body.caption || "").slice(0, 10000),
          media_url: body.media_url || null,
          scheduled_for: body.scheduled_for || null,
          status: body.scheduled_for ? "scheduled" : "draft",
          metadata: body.metadata || {},
        })
        .select("*")
        .single();
      if (error) throw error;
      return json({ post: data }, 201);
    }

    if (action === "update_draft") {
      const id = String(body.id || "");
      if (!id) return json({ error: "id required" }, 400);
      const changes: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };
      for (const key of ["caption", "media_url", "scheduled_for", "post_type", "status"]) {
        if (body[key] !== undefined) changes[key] = body[key];
      }
      const { data, error } = await supabase
        .from("release_social_posts")
        .update(changes)
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw error;
      return json({ post: data });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
