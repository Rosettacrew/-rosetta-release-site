/**
 * Live probes for studio attach scope, preview quarantine, the analytics
 * owner gate, owner/admin quarantine, and the music_uploader conditional write.
 * Run this only against a NON-PROD Supabase project.
 *
 * Required environment (never hardcode these):
 *   PROBE_CONFIRM_NON_PROD=yes
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY or SUPABASE_PUBLISHABLE_KEY
 *   MUSIC_UPLOADER_JWT   assigned music_uploader access token
 *   STAFF_JWT            release-manager staff access token
 *   OWNER_JWT            owner or admin access token (beatbay-manager and release-manager)
 *   DRAFT_BEAT_ID        assigned to the uploader, status draft, storefront off
 *   PUBLISHED_BEAT_ID    assigned, status other than draft (publish-then-update fixture)
 *   STOREFRONT_BEAT_ID   assigned, storefront_enabled true
 *   UNASSIGNED_BEAT_ID   not assigned to the uploader
 *   DRAFT_PRODUCT_ID     release product the owner may attach a cover to
 *
 * Deployed non-prod SHA expectation: studio-manager, release-manager, and
 * beatbay-manager on the non-prod project must be the git commit that contains
 * this file. That commit's ancestor must include
 * a18aa8df39f358a65c11c135e83a27a7553c90ec (PR #64: partner quarantine, derived
 * preview_url, analytics owner gate). Intended non-prod project ref:
 * cmndxzmumfzdtatjdkte. Do not deploy or probe production
 * sktgkrcahsxvidzjjxxt. Record the deployed SHA next to this probe's stdout.
 *
 * The script exits 2 when configuration is missing or the URL is production.
 * It does not print tokens. A passing preview attach updates DRAFT_BEAT_ID.
 * The valid partner preview PUT must declare audio/mpeg. text/html is only a
 * rejection fixture, except the owner valid-preview PUT, which sends text/html
 * on purpose so the stored public type must still be audio/mpeg.
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
  "DRAFT_PRODUCT_ID",
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

console.log(
  "Deployed non-prod SHA expectation: the commit that contains scripts/probe-studio-asset-guards.mjs. Ancestor a18aa8df39f358a65c11c135e83a27a7553c90ec (PR #64) is required. Intended project ref cmndxzmumfzdtatjdkte. Production ref sktgkrcahsxvidzjjxxt is refused.",
);

const draftBeatId = env("DRAFT_BEAT_ID");
const fileId = crypto.randomUUID();
const foreignBeatId = crypto.randomUUID();
const evilPublicUrl = "https://evil.example/probe-must-ignore";
const id3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
const html = new TextEncoder().encode("<!DOCTYPE html><html><body>not audio</body></html>");
const mz = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
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
  const putStatus = await putBytes(signed.body, id3, "audio/mpeg");
  note("valid preview put", putStatus >= 200 && putStatus < 300, `status ${putStatus}`);
  if (putStatus >= 200 && putStatus < 300) {
    const attached = await attach(signed.body.path, evilPublicUrl);
    const attachOk = attached.status === 200 && !JSON.stringify(attached.body ?? {}).includes("evil.example");
    note("valid draft attach", attachOk, `status ${attached.status} ${errorText(attached.body)}`);
    note("valid partner attach", attachOk, attachOk ? "conditional update accepted the draft assignee" : `status ${attached.status}`);
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

async function ownerSign(filename) {
  return callFunction("beatbay-manager", env("OWNER_JWT"), {
    body: {
      action: "create_upload",
      id: draftBeatId,
      kind: "preview",
      filename,
    },
  });
}

async function ownerAttach(path) {
  return callFunction("beatbay-manager", env("OWNER_JWT"), {
    body: {
      action: "attach_asset",
      id: draftBeatId,
      kind: "preview",
      path,
      public_url: evilPublicUrl,
      content_type: "text/html",
      mime: "text/html",
      duration_seconds: 30,
    },
  });
}

async function ownerReject(label, filename, bytes, contentType) {
  const signedOwner = await ownerSign(filename);
  const signedOk = signedOwner.status === 200
    && signedOwner.body?.bucket === "release-private"
    && signedOwner.body?.public_url == null
    && signedOwner.body?.quarantine === true
    && String(signedOwner.body?.path ?? "").startsWith(`beatbay/${draftBeatId}/preview/`);
  note(`${label} signed into quarantine`, signedOk, `status ${signedOwner.status} ${errorText(signedOwner.body)}`);
  if (!signedOk) return;
  const putStatus = await putBytes(signedOwner.body, bytes, contentType);
  note(`${label} upload put`, putStatus >= 200 && putStatus < 300, `status ${putStatus}`);
  if (putStatus < 200 || putStatus >= 300) return;
  const attached = await ownerAttach(signedOwner.body.path);
  await expectStatus(`${label} attach`, attached, 400);
}

const svgExt = await ownerSign("probe.svg");
await expectStatus("owner svg extension rejected", svgExt, 400);
await ownerReject("owner html named mp3", "owner-probe.mp3", html, "text/html");
await ownerReject("owner mz named mp3", "owner-probe.mp3", mz, "audio/mpeg");
await ownerReject("owner svg named mp3", "owner-probe.mp3", svg, "image/svg+xml");

const ownerSigned = await ownerSign("owner-valid.mp3");
const ownerSignedOk = ownerSigned.status === 200
  && ownerSigned.body?.bucket === "release-private"
  && ownerSigned.body?.public_url == null
  && ownerSigned.body?.quarantine === true;
note("owner valid preview signed into quarantine", ownerSignedOk, `status ${ownerSigned.status} ${errorText(ownerSigned.body)}`);
if (ownerSignedOk) {
  const putStatus = await putBytes(ownerSigned.body, id3, "text/html");
  note("owner valid preview put", putStatus >= 200 && putStatus < 300, `status ${putStatus}`);
  if (putStatus >= 200 && putStatus < 300) {
    const attached = await ownerAttach(ownerSigned.body.path);
    const previewUrl = String(attached.body?.beat?.preview_url ?? "");
    const derived = attached.status === 200
      && previewUrl.includes(`/storage/v1/object/public/release-public/${ownerSigned.body.path}`)
      && !previewUrl.includes("evil.example");
    note("owner valid preview attached", derived, `status ${attached.status} ${errorText(attached.body)}`);
    if (derived) {
      const head = await fetch(previewUrl, { method: "HEAD" });
      const type = String(head.headers.get("content-type") ?? "");
      note(
        "owner valid preview server type",
        head.ok && type.includes("audio/mpeg") && !type.includes("text/html"),
        type || `status ${head.status}`,
      );
    }
  }
}

async function coverSign(filename) {
  return callFunction("release-manager", env("OWNER_JWT"), {
    body: {
      action: "signed_upload",
      product_id: env("DRAFT_PRODUCT_ID"),
      kind: "cover",
      filename,
    },
  });
}

async function coverAttach(path, mime) {
  return callFunction("release-manager", env("OWNER_JWT"), {
    body: {
      action: "attach_asset",
      product_id: env("DRAFT_PRODUCT_ID"),
      kind: "cover",
      path,
      mime,
    },
  });
}

async function coverReject(label, filename, bytes, contentType) {
  const signedCover = await coverSign(filename);
  const signedOk = signedCover.status === 200
    && signedCover.body?.bucket === "release-private"
    && signedCover.body?.public_url == null
    && signedCover.body?.quarantine === true
    && String(signedCover.body?.path ?? "").includes(`/${env("DRAFT_PRODUCT_ID")}/cover/`);
  note(`${label} signed into quarantine`, signedOk, `status ${signedCover.status} ${errorText(signedCover.body)}`);
  if (!signedOk) return;
  const putStatus = await putBytes(signedCover.body, bytes, contentType);
  note(`${label} upload put`, putStatus >= 200 && putStatus < 300, `status ${putStatus}`);
  if (putStatus < 200 || putStatus >= 300) return;
  const attached = await coverAttach(signedCover.body.path, contentType);
  await expectStatus(`${label} attach`, attached, 400);
}

const coverSvgExt = await coverSign("cover.svg");
await expectStatus("owner svg cover extension rejected", coverSvgExt, 400);
await coverReject("owner html named jpg", "cover.jpg", html, "text/html");
await coverReject("owner mz named jpg", "cover.jpg", mz, "image/jpeg");
await coverReject("owner svg named png", "cover.png", svg, "image/svg+xml");

const coverSigned = await coverSign("cover.jpg");
const coverSignedOk = coverSigned.status === 200
  && coverSigned.body?.bucket === "release-private"
  && coverSigned.body?.public_url == null
  && coverSigned.body?.quarantine === true;
note("owner valid cover signed into quarantine", coverSignedOk, `status ${coverSigned.status} ${errorText(coverSigned.body)}`);
if (coverSignedOk) {
  const putStatus = await putBytes(coverSigned.body, jpeg, "text/html");
  note("owner valid cover put", putStatus >= 200 && putStatus < 300, `status ${putStatus}`);
  if (putStatus >= 200 && putStatus < 300) {
    const attached = await coverAttach(coverSigned.body.path, "text/html");
    const mime = attached.body?.release?.metadata?.cover_art?.mime;
    const publicUrl = `${supabaseUrl}/storage/v1/object/public/release-public/${coverSigned.body.path}`;
    note("owner valid cover attached", attached.status === 200 && mime === "image/jpeg", `status ${attached.status} mime ${mime ?? ""}`);
    if (attached.status === 200 && mime === "image/jpeg") {
      const head = await fetch(publicUrl, { method: "HEAD" });
      const type = String(head.headers.get("content-type") ?? "");
      note(
        "owner valid cover server type",
        head.ok && type.includes("image/jpeg") && !type.includes("text/html"),
        type || `status ${head.status}`,
      );
    }
  }
}

// Publish-then-update: PUBLISHED_BEAT_ID is already past draft. The partner
// update must return 403. The in-request race (pre-read still sees draft, then
// publish, then the SQL UPDATE matches zero rows) is covered by
// scripts/check-owner-upload-quarantine.mjs because this probe cannot
// interleave a write inside one edge request.
const race = await callFunction("studio-manager", uploader, {
  body: {
    action: "beatbay_attach_asset",
    beat_id: env("PUBLISHED_BEAT_ID"),
    kind: "preview",
    path: previewPath(env("PUBLISHED_BEAT_ID")),
    public_url: evilPublicUrl,
  },
});
await expectStatus("publish then partner update", race, 403);

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
