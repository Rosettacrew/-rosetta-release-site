import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, "content-type": "application/json" } });
}

function adminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const secretJson = Deno.env.get("SUPABASE_SECRET_KEYS");
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const key = secretJson ? JSON.parse(secretJson)?.default : legacy;
  if (!url || !key) throw new Error("Supabase admin credentials unavailable");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function authenticatedPartner(req: Request, supabase: ReturnType<typeof adminClient>) {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!token) return null;

  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user) return null;

  // CRITICAL: Enforce business_partner role ONLY - no shortcuts to admin access
  const { data: partner, error } = await supabase.from("business_partners")
    .select("user_id,role,is_active,created_at")
    .eq("user_id", userData.user.id)
    .eq("is_active", true)
    .maybeSingle();

  if (error || !partner || partner.role !== "business_partner") return null;

  return { user: userData.user, partner };
}

async function activityLog(
  supabase: ReturnType<typeof adminClient>,
  session: { user?: { id: string; email?: string | null }; partner?: { role?: string } } | null,
  input: { action: string; entityType: string; entityId?: string | null; summary: string; details?: Record<string, unknown> },
) {
  if (!session?.user) return;
  try {
    await supabase.from("partner_activity_log").insert({
      partner_user_id: session.user.id,
      partner_email: session.user.email ?? null,
      action: input.action,
      entity_type: input.entityType,
      entity_id: input.entityId ?? null,
      summary: input.summary,
      details: input.details ?? {},
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Activity logging failed", error);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const supabase = adminClient();
    let body: any = null;
    if (req.method === "POST") body = await req.json();

    const url = new URL(req.url);
    const view = url.searchParams.get("view");
    const action = body?.action;

    // ============================================================================
    // PUBLIC: Partner account creation (no auth required, but email must be approved)
    // ============================================================================
    if (req.method === "POST" && action === "request_partner_access") {
      const email = String(body.email ?? "").trim().toLowerCase();
      const company = String(body.company ?? "").trim();
      if (!email || !email.includes("@")) return json({ error: "Valid email required" }, 400);

      // Check if already exists
      const { data: existing } = await supabase.from("business_partners")
        .select("user_id")
        .eq("email", email)
        .maybeSingle();

      if (existing) return json({ error: "This email is already registered" }, 409);

      // Log the request
      const { error: logError } = await supabase.from("partner_access_requests").insert({
        email,
        company,
        status: "pending",
        created_at: new Date().toISOString(),
      });

      if (logError) throw logError;

      return json(
        { ok: true, message: "Access request submitted. Owner will review and approve." },
        201,
      );
    }

    // ============================================================================
    // PROTECTED: All routes below require authenticated business_partner role
    // ============================================================================
    const sessionPartner = await authenticatedPartner(req, supabase);
    if (!sessionPartner) return json({ error: "Unauthorized" }, 401);

    // ============================================================================
    // GET /view=whoami - Verify partner role (enforced at backend)
    // ============================================================================
    if (view === "whoami") {
      return json({
        role: "business_partner",
        email: sessionPartner.user.email,
        user_id: sessionPartner.user.id,
        created_at: sessionPartner.partner.created_at,
      });
    }

    // ============================================================================
    // GET /view=dashboard - Partner dashboard metrics
    // ============================================================================
    if (view === "dashboard") {
      const { data: uploads, error: uploadsError } = await supabase
        .from("partner_uploads")
        .select("id,status")
        .eq("partner_user_id", sessionPartner.user.id);

      if (uploadsError) throw uploadsError;

      const total = uploads?.length ?? 0;
      const published = uploads?.filter((u) => u.status === "published").length ?? 0;
      const pending = uploads?.filter((u) => u.status === "pending").length ?? 0;

      return json({
        total_uploads: total,
        published,
        pending,
        total_downloads: 0, // Implement when order tracking added
      });
    }

    // ============================================================================
    // GET /view=library - Partner's personal uploads only
    // ============================================================================
    if (view === "library") {
      // CRITICAL: Only fetch uploads owned by this specific partner
      const { data: uploads, error } = await supabase
        .from("partner_uploads")
        .select("id,title,artist,genre,bpm,price,status,created_at,license_type")
        .eq("partner_user_id", sessionPartner.user.id)
        .order("created_at", { ascending: false });

      if (error) throw error;

      return json({ uploads: uploads ?? [] });
    }

    // ============================================================================
    // POST /action=upload - Upload music with full metadata
    // ============================================================================
    if (req.method === "POST" && action === "upload") {
      const formData = await req.formData();
      const title = String(formData.get("title") ?? "").trim();
      const artist = String(formData.get("artist") ?? "").trim();
      const genre = String(formData.get("genre") ?? "").trim();
      const style = String(formData.get("style") ?? "").trim();
      const bpm = Number(formData.get("bpm"));
      const key = String(formData.get("key") ?? "").trim();
      const tags = String(formData.get("tags") ?? "").trim();
      const price = parseFloat(String(formData.get("price") ?? "0"));
      const licenseType = String(formData.get("licenseType") ?? "").trim();
      const description = String(formData.get("description") ?? "").trim();

      const audioFile = formData.get("audio") as File;
      const coverFile = formData.get("cover") as File;

      // Validation
      if (!title || !artist || !genre || !style || !bpm || !key || !tags || !price || !licenseType) {
        return json({ error: "All required fields must be provided" }, 400);
      }

      if (!audioFile || !["audio/mpeg", "audio/wav"].includes(audioFile.type)) {
        return json({ error: "Audio must be MP3 or WAV" }, 400);
      }

      if (!coverFile || !["image/jpeg", "image/png"].includes(coverFile.type)) {
        return json({ error: "Cover must be JPG or PNG" }, 400);
      }

      if (audioFile.size > 100 * 1024 * 1024) {
        return json({ error: "Audio file too large (max 100MB)" }, 400);
      }

      if (coverFile.size > 5 * 1024 * 1024) {
        return json({ error: "Cover image too large (max 5MB)" }, 400);
      }

      // Validate cover dimensions
      const coverDimensions = await validateCoverDimensions(coverFile);
      if (coverDimensions.error) {
        return json({ error: coverDimensions.error }, 400);
      }

      // Upload files to storage
      const uploadId = crypto.randomUUID();
      const audioExt = audioFile.type === "audio/mpeg" ? "mp3" : "wav";
      const audioPath = `partner/${sessionPartner.user.id}/${uploadId}/audio.${audioExt}`;
      const coverPath = `partner/${sessionPartner.user.id}/${uploadId}/cover.${coverFile.type === "image/jpeg" ? "jpg" : "png"}`;

      // Upload audio
      const audioBuffer = await audioFile.arrayBuffer();
      const { error: audioError } = await supabase.storage
        .from("partner-uploads")
        .upload(audioPath, audioBuffer, { upsert: false });

      if (audioError) throw audioError;

      // Upload cover
      const coverBuffer = await coverFile.arrayBuffer();
      const { error: coverError } = await supabase.storage
        .from("partner-uploads")
        .upload(coverPath, coverBuffer, { upsert: false });

      if (coverError) throw coverError;

      // Create upload record in database (CRITICAL: owned by this partner only)
      const { data: uploadRecord, error: dbError } = await supabase
        .from("partner_uploads")
        .insert({
          partner_user_id: sessionPartner.user.id,
          title,
          artist,
          genre,
          style,
          bpm,
          key,
          tags: tags.split(",").map((t) => t.trim()),
          description,
          price,
          license_type: licenseType,
          audio_path: audioPath,
          cover_path: coverPath,
          status: "pending",
          created_at: new Date().toISOString(),
        })
        .select("id")
        .single();

      if (dbError) throw dbError;

      await activityLog(supabase, sessionPartner, {
        action: "upload_music",
        entityType: "upload",
        entityId: uploadRecord.id,
        summary: `Uploaded: ${title} by ${artist}`,
      });

      return json({ ok: true, upload_id: uploadRecord.id }, 201);
    }

    // ============================================================================
    // POST /action=update_upload - Edit own uploads only
    // ============================================================================
    if (req.method === "POST" && action === "update_upload") {
      const uploadId = String(body.upload_id ?? "");
      if (!uploadId) return json({ error: "upload_id required" }, 400);

      // CRITICAL: Verify ownership - partner can only edit their own uploads
      const { data: upload, error: fetchError } = await supabase
        .from("partner_uploads")
        .select("partner_user_id,status")
        .eq("id", uploadId)
        .maybeSingle();

      if (fetchError || !upload) return json({ error: "Upload not found" }, 404);

      if (upload.partner_user_id !== sessionPartner.user.id) {
        await activityLog(supabase, sessionPartner, {
          action: "unauthorized_edit_attempt",
          entityType: "upload",
          entityId: uploadId,
          summary: `Attempted to edit upload not owned by partner`,
        });
        return json({ error: "You do not own this upload" }, 403);
      }

      // Only allow editing metadata if status is pending
      if (upload.status !== "pending") {
        return json({ error: "Cannot edit published uploads" }, 409);
      }

      const updates: Record<string, unknown> = {};
      if (body.title !== undefined) updates.title = body.title;
      if (body.artist !== undefined) updates.artist = body.artist;
      if (body.genre !== undefined) updates.genre = body.genre;
      if (body.style !== undefined) updates.style = body.style;
      if (body.bpm !== undefined) updates.bpm = body.bpm;
      if (body.key !== undefined) updates.key = body.key;
      if (body.tags !== undefined) updates.tags = body.tags;
      if (body.price !== undefined) updates.price = body.price;
      if (body.license_type !== undefined) updates.license_type = body.license_type;

      const { error: updateError } = await supabase
        .from("partner_uploads")
        .update(updates)
        .eq("id", uploadId);

      if (updateError) throw updateError;

      await activityLog(supabase, sessionPartner, {
        action: "update_upload",
        entityType: "upload",
        entityId: uploadId,
        summary: `Updated upload metadata`,
      });

      return json({ ok: true });
    }

    // ============================================================================
    // POST /action=update_settings - Partner profile settings
    // ============================================================================
    if (req.method === "POST" && action === "update_settings") {
      const name = String(body.name ?? "").trim();
      const company = String(body.company ?? "").trim();
      const website = String(body.website ?? "").trim();

      const { error } = await supabase
        .from("business_partners")
        .update({
          full_name: name,
          company,
          website,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", sessionPartner.user.id);

      if (error) throw error;

      await activityLog(supabase, sessionPartner, {
        action: "update_settings",
        entityType: "account",
        summary: `Updated partner profile`,
      });

      return json({ ok: true });
    }

    // ============================================================================
    // POST /action=delete_account - Account deletion
    // ============================================================================
    if (req.method === "POST" && action === "delete_account") {
      const partnerId = sessionPartner.user.id;

      // Soft delete - mark as inactive
      const { error: deactivateError } = await supabase
        .from("business_partners")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("user_id", partnerId);

      if (deactivateError) throw deactivateError;

      // Remove all uploads
      const { error: deleteError } = await supabase
        .from("partner_uploads")
        .delete()
        .eq("partner_user_id", partnerId);

      if (deleteError) throw deleteError;

      // Delete auth account
      const adminSupabase = adminClient();
      const { error: authError } = await adminSupabase.auth.admin.deleteUser(partnerId);
      if (authError) throw authError;

      return json({ ok: true, message: "Account deleted" });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    console.error(error);
    return json({ error: String(error?.message ?? "Server error") }, 500);
  }
});

async function validateCoverDimensions(file: File): Promise<{ error?: string }> {
  try {
    const buffer = await file.arrayBuffer();
    const blob = new Blob([buffer], { type: file.type });
    const url = URL.createObjectURL(blob);

    return await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        if (img.width !== 3000 || img.height !== 3000) {
          resolve({ error: `Cover must be exactly 3000×3000px (current: ${img.width}×${img.height})` });
        } else {
          resolve({});
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve({ error: "Could not read cover image" });
      };
      img.src = url;
    });
  } catch {
    return { error: "Cover validation failed" };
  }
}
