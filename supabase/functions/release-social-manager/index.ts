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

const PROVIDERS = [
  { provider: "instagram", account_label: "Instagram" },
  { provider: "facebook", account_label: "Facebook" },
  { provider: "tiktok", account_label: "TikTok" },
  { provider: "youtube", account_label: "YouTube" },
  { provider: "x", account_label: "X" },
] as const;

const ACCOUNT_SELECT =
  "id,provider,account_label,external_account_id,connection_status,metadata,updated_at";

const TABLE_MISSING_MSG =
  "release_social_accounts table is missing. Apply social-seed-not-connected.sql (or create the table with a unique provider constraint) before using Publish & Promote.";

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

function isMissingTable(error: unknown) {
  const e = error as { code?: string; message?: string; details?: string; hint?: string };
  const blob = `${e?.code || ""} ${e?.message || ""} ${e?.details || ""} ${e?.hint || ""}`;
  return (
    e?.code === "42P01" ||
    e?.code === "PGRST205" ||
    /relation .* does not exist/i.test(blob) ||
    /could not find the table/i.test(blob) ||
    /schema cache/i.test(blob)
  );
}

function isUniqueViolation(error: unknown) {
  const e = error as { code?: string; message?: string };
  const blob = `${e?.code || ""} ${e?.message || ""}`;
  return e?.code === "23505" || /duplicate|unique/i.test(blob);
}

function userIdFromJwt(token: string): { id: string; email?: string | null } | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    let payloadB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = (4 - (payloadB64.length % 4)) % 4;
    if (pad) payloadB64 += "=".repeat(pad);
    const payload = JSON.parse(atob(payloadB64));
    const sub = payload?.sub;
    if (typeof sub !== "string" || !sub) return null;
    return {
      id: sub,
      email: typeof payload.email === "string" ? payload.email : null,
    };
  } catch (_) {
    return null;
  }
}

async function requireOwner(req: Request, supabase: any) {
  const header = req.headers.get("authorization") || "";
  const token = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";
  if (!token) return null;

  // Prefer JWT `sub` + service-role admin lookup — same flake fix as studio-manager.
  let user: { id: string; email?: string | null } | null = userIdFromJwt(token);
  if (!user?.id) {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return null;
    user = data.user;
  }

  const { data: member, error: memberError } = await supabase
    .from("release_admin_users")
    .select("role,is_active")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .maybeSingle();
  if (memberError || !member || member.role !== "owner") {
    return null;
  }
  return { user, member };
}

async function ensureSocialAccounts(supabase: any) {
  const { data: existing, error: selectError } = await supabase
    .from("release_social_accounts")
    .select("provider");
  if (selectError) {
    if (isMissingTable(selectError)) throw new Error(TABLE_MISSING_MSG);
    throw selectError;
  }

  const have = new Set(
    (existing || []).map((row: { provider?: string }) => String(row.provider || "")),
  );

  for (const spec of PROVIDERS) {
    if (have.has(spec.provider)) continue;

    const row = {
      provider: spec.provider,
      account_label: spec.account_label,
      connection_status: "not_connected",
      external_account_id: null,
      metadata: {},
    };

    const { error: upsertError } = await supabase
      .from("release_social_accounts")
      .upsert(row, { onConflict: "provider", ignoreDuplicates: true });

    if (!upsertError) {
      have.add(spec.provider);
      continue;
    }

    if (isMissingTable(upsertError)) throw new Error(TABLE_MISSING_MSG);

    // No unique on provider (or other upsert issue): select-then-insert.
    const { data: again, error: againError } = await supabase
      .from("release_social_accounts")
      .select("id")
      .eq("provider", spec.provider)
      .maybeSingle();
    if (againError) {
      if (isMissingTable(againError)) throw new Error(TABLE_MISSING_MSG);
      throw againError;
    }
    if (again) {
      have.add(spec.provider);
      continue;
    }

    const { error: insertError } = await supabase
      .from("release_social_accounts")
      .insert(row);
    if (insertError) {
      if (isMissingTable(insertError)) throw new Error(TABLE_MISSING_MSG);
      if (isUniqueViolation(insertError)) {
        have.add(spec.provider);
        continue;
      }
      // Upsert may have failed solely for missing ON CONFLICT target; surface that
      // only if insert also failed for a non-race reason.
      throw insertError;
    }
    have.add(spec.provider);
  }
}

async function loadAccountsAndPosts(supabase: any) {
  const { data: accounts, error: accountError } = await supabase
    .from("release_social_accounts")
    .select(ACCOUNT_SELECT)
    .order("provider");
  if (accountError) {
    if (isMissingTable(accountError)) throw new Error(TABLE_MISSING_MSG);
    throw accountError;
  }

  const { data: posts, error: postError } = await supabase
    .from("release_social_posts")
    .select(
      "id,product_id,provider,post_type,caption,media_url,scheduled_for,status,provider_post_id,published_at,error_message,created_at",
    )
    .order("created_at", { ascending: false })
    .limit(100);
  if (postError) throw postError;

  // Never return tokens — ACCOUNT_SELECT excludes them by design.
  return { accounts: accounts || [], posts: posts || [] };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const supabase = adminClient();
    if (!(await requireOwner(req, supabase))) {
      return json({ error: "Owner approval required" }, 403);
    }

    if (req.method === "GET") {
      await ensureSocialAccounts(supabase);
      const payload = await loadAccountsAndPosts(supabase);
      return json(payload);
    }

    if (req.method !== "POST") {
      return json({ error: "Method Not Allowed" }, 405);
    }

    const body = await req.json();
    const action = String(body?.action || "");

    if (action === "ensure_accounts") {
      await ensureSocialAccounts(supabase);
      const payload = await loadAccountsAndPosts(supabase);
      return json({ ok: true, ...payload });
    }

    if (action === "create_draft") {
      const provider = String(body.provider || "");
      if (!PROVIDERS.some((p) => p.provider === provider)) {
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
    const message = error instanceof Error ? error.message : String(error);
    const status = message === TABLE_MISSING_MSG ? 500 : 500;
    return json({ error: message }, status);
  }
});
