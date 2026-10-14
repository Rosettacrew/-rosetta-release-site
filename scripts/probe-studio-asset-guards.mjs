/**
 * Live probes for studio attach scope, preview quarantine, and the analytics
 * owner gate. Run this only against a NON-PROD Supabase project.
 *
 * Required environment (never hardcode these):
 *   PROBE_CONFIRM_NON_PROD=yes
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY or SUPABASE_PUBLISHABLE_KEY
 *   MUSIC_UPLOADER_JWT   assigned music_uploader access token
 *   STAFF_JWT            release-manager staff access token
 *   OWNER_JWT            release-manager owner access token
 *   DRAFT_BEAT_ID        assigned to the uploader, status draft, storefront off
 *   PUBLISHED_BEAT_ID    assigned, status other than draft
 *   STOREFRONT_BEAT_ID   assigned, storefront_enabled true
 *   UNASSIGNED_BEAT_ID   not assigned to the uploader
 *
 * The script exits 2 when configuration is missing or the URL is production.
 * It does not print tokens. A passing preview attach updates DRAFT_BEAT_ID.
 */
const PROD_PROJECT_REF = "sktgkrcahsxvidzjjxxt";
const REQUIRED = [
  "SUPABASE_URL",
  "MUSIC_UPLOADER_JWT",
  "STAFF_JWT",
  "OWNER_JWT",
  "DRAFT_BEAT_ID",
  "PUBLISHED_BEAT_ID",
  "STOREFRONT_BEAT_ID",
  "UNASSIGNED_BEAT_ID",
];

function env(name) {
  return String(process.env[name] ?? "").trim();
}

function failConfig(message) {
  console.error(message);
  process.exit(2);
}

const supabaseUrl = env("SUPABASE_URL").replace(/\/+$/, "");
const anonKey = env("SUPABASE_ANON_KEY") || env("SUPABASE_PUBLISHABLE_KEY");
if (env("PROBE_CONFIRM_NON_PROD") !== "yes") {
  failConfig("Set PROBE_CONFIRM_NON_PROD=yes after pointing SUPABASE_URL at a non-prod project.");
}
if (!supabaseUrl || supabaseUrl.toLowerCase().includes(PROD_PROJECT_REF)) {
  failConfig("Refusing to run: SUPABASE_URL is missing or is the production project.");
}
if (!anonKey) failConfig("Set SUPABASE_ANON_KEY or SUPABASE_PUBLISHABLE_KEY.");
for (const name of REQUIRED) {
  if (!env(name)) failConfig(`Missing ${name}.`);
}

const draftBeatId = env("DRAFT_BEAT_ID");
const fileId = crypto.randomUUID();
const foreignBeatId = crypto.randomUUID();
const evilPublicUrl = "https://evil.example/probe-must-ignore";
const id3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
const html = new TextEncoder().encode("<!DOCTYPE html><html><body>not audio</body></html>");
const mz = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
const failures = [];

function note(name, ok, detail) {
  const line = `${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`;
  console.log(line);
  if (!ok) failures.push(line);
}

function errorText(body) {
  if (!body || typeof body !== "object") return "";
  const value = body.error ?? body.message ?? "";
  return String(value).replace(/bearer\s+\S+/gi, "bearer [redacted]").slice(0, 180);
}

async function callFunction(name, jwt, { method = "POST", body, view } = {}) {
  const url = new URL(`${supabaseUrl}/functions/v1/${name}`);
  if (view) url.searchParams.set("view", view);
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${jwt}`,
      apikey: anonKey,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed, raw: text.slice(0, 180) };
}

async function expectStatus(name, response, status) {
  note(name, response.status === status, `status ${response.status} ${errorText(response.body)}`);
  return response.status === status;
}

function previewPath(beat, id = fileId) {
  return `beatbay/${beat}/preview/${id}.mp3`;
}

async function signedPreview(filename) {
  return callFunction("studio-manager", env("MUSIC_UPLOADER_JWT"), {
    body: {
      action: "beatbay_signed_upload",
      beat_id: draftBeatId,
      kind: "preview",
      filename,
    },
  });
}

async function putBytes(signed, bytes, contentType) {
  const response = await fetch(signed.signed_url, {
    method: "PUT",
    headers: { "content-type": contentType },
    body: bytes,
  });
  return response.status;
}

async function attach(path, publicUrl = evilPublicUrl) {
  return callFunction("studio-manager", env("MUSIC_UPLOADER_JWT"), {
    body: {
      action: "beatbay_attach_asset",
      beat_id: draftBeatId,
      kind: "preview",
      path,
      public_url: publicUrl,
      duration_seconds: 30,
    },
  });
}

const uploader = env("MUSIC_UPLOADER_JWT");
const publishedAttach = await callFunction("studio-manager", uploader, {
  body: {
    action: "beatbay_attach_asset",
    beat_id: env("PUBLISHED_BEAT_ID"),
    kind: "preview",
    path: previewPath(env("PUBLISHED_BEAT_ID")),
    public_url: evilPublicUrl,
  },
});
await expectStatus("published beat attach", publishedAttach, 403);

const storefrontAttach = await callFunction("studio-manager", uploader, {
  body: {
    action: "beatbay_attach_asset",
    beat_id: env("STOREFRONT_BEAT_ID"),
    kind: "preview",
    path: previewPath(env("STOREFRONT_BEAT_ID")),
    public_url: evilPublicUrl,
  },
});
await expectStatus("storefront-enabled beat attach", storefrontAttach, 403);

const unassignedAttach = await callFunction("studio-manager", uploader, {
  body: {
    action: "beatbay_attach_asset",
    beat_id: env("UNASSIGNED_BEAT_ID"),
    kind: "preview",
    path: previewPath(env("UNASSIGNED_BEAT_ID")),
    public_url: evilPublicUrl,
  },
});
await expectStatus("unassigned beat attach", unassignedAttach, 403);

for (const [label, path] of [
  ["dotdot path", `beatbay/${draftBeatId}/preview/../${foreignBeatId}/preview/${fileId}.mp3`],
  ["foreign beat path", previewPath(foreignBeatId)],
  ["other prefix", `uploads/${draftBeatId}/preview/${fileId}.mp3`],
]) {
  const response = await attach(path);
  await expectStatus(label, response, 400);
}

async function rejectPayload(label, filename, bytes, contentType) {
  const signed = await signedPreview(filename);
  const signedOk = signed.status === 200
    && signed.body?.bucket === "release-private"
    && signed.body?.public_url == null
    && String(signed.body?.path ?? "").startsWith(`beatbay/${draftBeatId}/preview/`);
  note(`${label} signed into quarantine`, signedOk, `status ${signed.status} ${errorText(signed.body)}`);
  if (!signedOk) return;
  const putStatus = await putBytes(signed.body, bytes, contentType);
  note(`${label} upload put`, putStatus >= 200 && putStatus < 300, `status ${putStatus}`);
  if (putStatus < 200 || putStatus >= 300) return;
  const attached = await attach(signed.body.path);
  await expectStatus(`${label} attach`, attached, 400);
}

await rejectPayload("html named mp3", "probe.html.mp3", html, "text/html");
await rejectPayload("mz named mp3", "probe.mp3", mz, "audio/mpeg");

const signed = await signedPreview("probe.mp3");
const signedOk = signed.status === 200
  && signed.body?.bucket === "release-private"
  && signed.body?.public_url == null
  && signed.body?.quarantine === true;
note("valid preview signed into quarantine", signedOk, `status ${signed.status} ${errorText(signed.body)}`);
if (signedOk) {
  const putStatus = await putBytes(signed.body, id3, "text/html");
  note("valid preview put", putStatus >= 200 && putStatus < 300, `status ${putStatus}`);
  if (putStatus >= 200 && putStatus < 300) {
    const attached = await attach(signed.body.path, evilPublicUrl);
    const attachOk = attached.status === 200 && !JSON.stringify(attached.body ?? {}).includes("evil.example");
    note("valid draft attach", attachOk, `status ${attached.status} ${errorText(attached.body)}`);
    if (attachOk) {
      const listed = await callFunction("beatbay-manager", env("OWNER_JWT"), { method: "GET" });
      const beat = Array.isArray(listed.body?.beats)
        ? listed.body.beats.find((row) => row.id === draftBeatId)
        : null;
      const previewUrl = String(beat?.preview_url ?? "");
      const derived = previewUrl.includes(`/storage/v1/object/public/release-public/${signed.body.path}`)
        && !previewUrl.includes("evil.example");
      note("public_url ignored", listed.status === 200 && derived, listed.status === 200 ? "owner read preview_url" : `status ${listed.status}`);
    }
  }
}

const staff = await callFunction("release-manager", env("STAFF_JWT"), { method: "GET", view: "analytics" });
const staffBody = JSON.stringify(staff.body ?? {});
const staffOk = staff.status === 403 && !staffBody.includes("gross_revenue_cents") && !staffBody.includes("paid_orders");
note("staff analytics denied", staffOk, `status ${staff.status}`);

const owner = await callFunction("release-manager", env("OWNER_JWT"), { method: "GET", view: "analytics" });
const ownerOk = owner.status === 200 && Array.isArray(owner.body?.analytics);
note("owner analytics allowed", ownerOk, ownerOk ? `rows ${owner.body.analytics.length}` : `status ${owner.status}`);

if (failures.length) {
  console.error(`${failures.length} probe(s) failed.`);
  process.exit(1);
}
console.log("Non-prod studio asset probes passed.");
