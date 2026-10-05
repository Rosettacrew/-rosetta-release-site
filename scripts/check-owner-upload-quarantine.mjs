import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PUBLIC_BUCKET,
  QUARANTINE_BUCKET,
  commitPromotion,
  evaluateOwnerBeatAttach,
  evaluateOwnerCoverAttach,
  ownerBeatSignedUploadTarget,
  ownerCoverSignedUploadTarget,
  promotionUploadOptions,
  rejectUpload,
} from "../supabase/functions/_shared/owner-upload-guard.mjs";
import {
  MUSIC_UPLOADER_BEAT_UPDATE_RPC,
  commitMusicUploaderBeatUpdate,
  preReadAllowsMusicUploaderBeat,
} from "../supabase/functions/studio-manager/beat-update-guard.mjs";

const beatId = "11111111-1111-4111-8111-111111111111";
const fileId = "33333333-3333-4333-8333-333333333333";
const productId = "44444444-4444-4444-8444-444444444444";
const userId = "55555555-5555-4555-8555-555555555555";
const supabaseUrl = "https://example.supabase.co";
const previewPath = `beatbay/${beatId}/preview/${fileId}.mp3`;
const coverPath = `${productId}/cover/cover-${fileId}.jpg`;
const pngPath = `${productId}/cover/cover-${fileId}.png`;
const id3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
const html = new TextEncoder().encode("<!DOCTYPE html><html><body>not audio</body></html>");
const javascript = new TextEncoder().encode("function exploit(){return 1}\n");
const mz = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");

function memoryStorage(seed = []) {
  const objects = new Map(seed);
  return {
    objects,
    from(bucket) {
      return {
        async upload(path, bytes, options) {
          objects.set(`${bucket}/${path}`, {
            bytes,
            contentType: options.contentType,
            upsert: options.upsert,
          });
          return { error: null };
        },
        async remove(paths) {
          for (const path of paths) objects.delete(`${bucket}/${path}`);
          return { error: null };
        },
      };
    },
  };
}

function beatAttach(overrides = {}) {
  return evaluateOwnerBeatAttach({
    beatId,
    kind: "preview",
    path: previewPath,
    bytes: id3,
    supabaseUrl,
    durationSeconds: 30,
    clientContentType: "text/html",
    bodyPublicUrl: "https://evil.example/public-html",
    ...overrides,
  });
}

const signed = ownerBeatSignedUploadTarget(beatId, "preview", fileId, "mp3");
assert.equal(signed.ok, true);
assert.equal(signed.bucket, QUARANTINE_BUCKET);
assert.equal(signed.public_url, null);
assert.equal(signed.quarantine, true);
assert.equal(signed.path, previewPath);
assert.equal(ownerBeatSignedUploadTarget(beatId, "preview", fileId, "html").ok, false);
assert.equal(ownerBeatSignedUploadTarget(beatId, "preview", fileId, "svg").ok, false);

const validPreview = beatAttach();
assert.equal(validPreview.status, 200);
assert.equal(validPreview.promote.contentType, "audio/mpeg");
assert.equal(validPreview.promote.toBucket, PUBLIC_BUCKET);
assert.equal(validPreview.promote.fromBucket, QUARANTINE_BUCKET);
assert.equal(JSON.stringify(validPreview).includes("text/html"), false);
assert.equal(JSON.stringify(validPreview).includes("evil.example"), false);
assert.equal(
  validPreview.changes.preview_url,
  `${supabaseUrl}/storage/v1/object/public/${PUBLIC_BUCKET}/${previewPath}`,
);
assert.deepEqual(promotionUploadOptions(validPreview.promote), {
  contentType: "audio/mpeg",
  upsert: false,
});

const validStore = memoryStorage([[`${QUARANTINE_BUCKET}/${previewPath}`, { bytes: id3, contentType: "text/html" }]]);
await commitPromotion(validStore, validPreview.promote);
assert.equal(validStore.objects.get(`${PUBLIC_BUCKET}/${previewPath}`).contentType, "audio/mpeg");
assert.equal(validStore.objects.has(`${QUARANTINE_BUCKET}/${previewPath}`), false);

for (const [label, bytes, clientContentType] of [
  ["owner PUT text/html named mp3", html, "text/html"],
  ["owner PUT application/javascript named mp3", javascript, "application/javascript"],
  ["owner PUT MZ/PE named mp3", mz, "audio/mpeg"],
  ["owner PUT SVG named mp3", svg, "image/svg+xml"],
]) {
  const decision = beatAttach({ bytes, clientContentType });
  assert.equal(decision.status, 400, label);
  assert.equal(decision.promote, undefined, label);
  const store = memoryStorage([[`${QUARANTINE_BUCKET}/${previewPath}`, { bytes, contentType: clientContentType }]]);
  await rejectUpload(store, decision.remove);
  assert.equal(store.objects.has(`${QUARANTINE_BUCKET}/${previewPath}`), false, label);
  assert.equal([...store.objects.keys()].some((key) => key.startsWith(`${PUBLIC_BUCKET}/`)), false, label);
}

const wav = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
]);
const fullPath = `beatbay/${beatId}/full/${fileId}.wav`;
const fullAudio = evaluateOwnerBeatAttach({
  beatId,
  kind: "full",
  path: fullPath,
  bytes: wav,
  supabaseUrl,
  clientContentType: "text/html",
  bodyPublicUrl: "https://evil.example/full",
});
assert.equal(fullAudio.status, 200);
assert.equal(fullAudio.promote.contentType, "audio/wav");
assert.equal(fullAudio.promote.toBucket, QUARANTINE_BUCKET);
assert.equal(fullAudio.changes.full_audio_path, fullPath);
assert.equal(JSON.stringify(fullAudio).includes("evil.example"), false);

const htmlJpg = evaluateOwnerCoverAttach({
  productId,
  path: coverPath,
  bytes: html,
  clientContentType: "text/html",
});
assert.equal(htmlJpg.status, 400);
assert.equal(htmlJpg.promote, undefined);
const coverStore = memoryStorage([[`${QUARANTINE_BUCKET}/${coverPath}`, { bytes: html, contentType: "text/html" }]]);
await rejectUpload(coverStore, htmlJpg.remove);
assert.equal([...coverStore.objects.keys()].some((key) => key.startsWith(`${PUBLIC_BUCKET}/`)), false);

const svgPng = evaluateOwnerCoverAttach({
  productId,
  path: pngPath,
  bytes: svg,
  clientContentType: "image/svg+xml",
});
assert.equal(svgPng.status, 400, "owner SVG named png");
assert.equal(svgPng.promote, undefined);
const mzJpg = evaluateOwnerCoverAttach({
  productId,
  path: coverPath,
  bytes: mz,
  clientContentType: "image/jpeg",
});
assert.equal(mzJpg.status, 400, "owner MZ named jpg");

assert.equal(ownerCoverSignedUploadTarget(productId, fileId, "svg").ok, false);

const signedCover = ownerCoverSignedUploadTarget(productId, fileId, "jpg");
assert.equal(signedCover.bucket, QUARANTINE_BUCKET);
assert.equal(signedCover.public_url, null);
assert.equal(signedCover.quarantine, true);
assert.equal(signedCover.path, coverPath);
const coverOk = evaluateOwnerCoverAttach({
  productId,
  path: coverPath,
  bytes: jpeg,
  clientContentType: "text/html",
});
assert.equal(coverOk.status, 200);
assert.equal(coverOk.mime, "image/jpeg");
assert.equal(coverOk.promote.contentType, "image/jpeg");
assert.equal(coverOk.promote.toBucket, PUBLIC_BUCKET);
assert.equal(JSON.stringify(promotionUploadOptions(coverOk.promote)).includes("text/html"), false);
const publicCover = memoryStorage([[`${QUARANTINE_BUCKET}/${coverPath}`, { bytes: jpeg, contentType: "text/html" }]]);
await commitPromotion(publicCover, coverOk.promote);
assert.equal(publicCover.objects.get(`${PUBLIC_BUCKET}/${coverPath}`).contentType, "image/jpeg");

function storefrontOff(value) {
  // NULL is coalesce(storefront_enabled, false): off, so the draft write is eligible.
  return value == null || value === false;
}

function createBeatTable({ row, assignees }) {
  const state = {
    row: { ...row },
    assignees: [...assignees],
    writes: 0,
  };
  return {
    state,
    publish() {
      state.row = { ...state.row, status: "published", storefront_enabled: true };
    },
    from(table) {
      assert.equal(table, "beatbay_beats");
      return {
        update() {
          const builder = {
            eq(column) {
              if (String(column).includes(".")) {
                throw new Error(`PGRST108: ${column} is an embedded filter and is not a root-table predicate`);
              }
              return builder;
            },
            select() {
              throw new Error("music_uploader beat writes go through commit_music_uploader_beat_update");
            },
          };
          return builder;
        },
      };
    },
    rpc(name, args) {
      assert.equal(name, MUSIC_UPLOADER_BEAT_UPDATE_RPC);
      assert.equal(Object.hasOwn(args, "p_beat_id"), true);
      assert.equal(Object.hasOwn(args, "p_user_id"), true);
      assert.equal(Object.hasOwn(args, "p_changes"), true);
      const matched = args.p_beat_id === state.row.id
        && state.row.status === "draft"
        && storefrontOff(state.row.storefront_enabled)
        && state.assignees.includes(args.p_user_id);
      if (!matched) return Promise.resolve({ data: null, error: null });
      state.writes += 1;
      state.row = { ...state.row, ...args.p_changes };
      return Promise.resolve({
        data: {
          id: state.row.id,
          beat_code: state.row.beat_code,
          title: state.row.title,
          preview_url: state.row.preview_url ?? null,
          full_audio_bucket: state.row.full_audio_bucket ?? null,
          full_audio_path: state.row.full_audio_path ?? null,
          status: state.row.status,
          storefront_enabled: state.row.storefront_enabled,
        },
        error: null,
      });
    },
  };
}

const draftRow = {
  id: beatId,
  status: "draft",
  storefront_enabled: false,
  beat_code: "BEAT 0001",
  title: "Night",
};

const embedded = createBeatTable({ row: draftRow, assignees: [userId] });
assert.throws(
  () => embedded.from("beatbay_beats").update({ preview_url: "x" }).eq("beatbay_beat_assignees.user_id", userId),
  /PGRST108/,
);

const publishedTable = createBeatTable({
  row: { ...draftRow, status: "published" },
  assignees: [userId],
});
const publishedUpdate = await commitMusicUploaderBeatUpdate(publishedTable, {
  beatId,
  userId,
  changes: { preview_url: "https://evil.example/published" },
});
assert.equal(publishedUpdate.status, 403);
assert.equal(publishedTable.state.writes, 0);

const storefrontTable = createBeatTable({
  row: { ...draftRow, storefront_enabled: true },
  assignees: [userId],
});
const storefrontUpdate = await commitMusicUploaderBeatUpdate(storefrontTable, {
  beatId,
  userId,
  changes: { preview_url: "https://evil.example/storefront" },
});
assert.equal(storefrontUpdate.status, 403);
assert.equal(storefrontTable.state.writes, 0);

const nullStorefront = createBeatTable({
  row: { ...draftRow, storefront_enabled: null },
  assignees: [userId],
});
assert.equal(preReadAllowsMusicUploaderBeat(nullStorefront.state.row), true);
const nullUpdate = await commitMusicUploaderBeatUpdate(nullStorefront, {
  beatId,
  userId,
  changes: { preview_url: `${supabaseUrl}/storage/v1/object/public/release-public/${previewPath}` },
});
assert.equal(nullUpdate.status, 200, "NULL storefront_enabled is coalesce to false");
assert.equal(nullStorefront.state.writes, 1);

const raceTable = createBeatTable({ row: draftRow, assignees: [userId] });
const preReadSnapshot = { ...raceTable.state.row };
assert.equal(preReadAllowsMusicUploaderBeat(preReadSnapshot), true);
raceTable.publish();
assert.equal(preReadAllowsMusicUploaderBeat(preReadSnapshot), true);
const raceUpdate = await commitMusicUploaderBeatUpdate(raceTable, {
  beatId,
  userId,
  changes: { preview_url: "https://evil.example/race" },
});
assert.equal(raceUpdate.status, 403);
assert.equal(raceUpdate.row, null);
assert.equal(raceTable.state.writes, 0);
assert.equal(raceTable.state.row.preview_url, undefined);
assert.equal(raceTable.state.row.status, "published");

const unassigned = createBeatTable({ row: draftRow, assignees: [] });
const unassignedUpdate = await commitMusicUploaderBeatUpdate(unassigned, {
  beatId,
  userId,
  changes: { preview_url: "https://evil.example/unassigned" },
});
assert.equal(unassignedUpdate.status, 403);
assert.equal(unassigned.state.writes, 0);

const happy = createBeatTable({ row: draftRow, assignees: [userId] });
const happyUpdate = await commitMusicUploaderBeatUpdate(happy, {
  beatId,
  userId,
  changes: { preview_url: `${supabaseUrl}/storage/v1/object/public/release-public/${previewPath}` },
});
assert.equal(happyUpdate.status, 200);
assert.equal(happy.state.writes, 1);
assert.equal(happyUpdate.row.beat_code, "BEAT 0001");
assert.match(happyUpdate.row.preview_url, /release-public/);

const manager = readFileSync("supabase/functions/beatbay-manager/index.ts", "utf8");
const release = readFileSync("supabase/functions/release-manager/index.ts", "utf8");
const studio = readFileSync("supabase/functions/studio-manager/index.ts", "utf8");
const beatGuard = readFileSync("supabase/functions/studio-manager/beat-update-guard.mjs", "utf8");
const assetGuard = readFileSync("supabase/functions/studio-manager/asset-guard.mjs", "utf8");
const config = readFileSync("supabase/config.toml", "utf8");
const probe = readFileSync("scripts/probe-studio-asset-guards.mjs", "utf8");
const migration = readFileSync("supabase/migrations/20261005_music_uploader_beat_update.sql", "utf8");

const createUpload = manager.slice(
  manager.indexOf('if (action === "create_upload")'),
  manager.indexOf('if (action === "attach_asset")'),
);
const ownerSign = createUpload.slice(createUpload.lastIndexOf("ownerBeatSignedUploadTarget"));
assert.match(ownerSign, /ownerBeatSignedUploadTarget/);
assert.match(ownerSign, /public_url: null/);
assert.doesNotMatch(ownerSign, /object\/public\/release-public/);
assert.match(manager, /evaluateOwnerBeatAttach/);
assert.match(manager, /commitPromotion/);
assert.doesNotMatch(manager, /preview_url: String\(body\.public_url/);
assert.match(manager, /from\s+["']\.\.\/_shared\/owner-upload-guard\.mjs["']/);
assert.doesNotMatch(manager, /from\s+["']\.\.\/studio-manager\//);
assert.doesNotMatch(manager, /from\s+["']\.\.\/release-manager\//);

const signedUpload = release.slice(
  release.indexOf('if (action === "signed_upload")'),
  release.indexOf('if (action === "delete_track")'),
);
assert.match(signedUpload, /ownerCoverSignedUploadTarget/);
assert.doesNotMatch(signedUpload, /bucket = "release-public"/);
assert.match(signedUpload, /public_url: null/);
assert.match(release, /evaluateOwnerCoverAttach/);
assert.match(release, /mime: decision\.mime/);
assert.doesNotMatch(release, /mime: readableText\(body\.mime\)/);
assert.match(release, /from\s+["']\.\.\/_shared\/owner-upload-guard\.mjs["']/);
assert.doesNotMatch(release, /from\s+["']\.\.\/beatbay-manager\//);
assert.match(release, /readAnalytics\(/);
assert.match(readFileSync("supabase/functions/release-manager/analytics-gate.mjs", "utf8"), /gross_revenue_cents|paid_orders|ownerFinanceAccess/);

assert.match(studio, /preReadAllowsMusicUploaderBeat/);
assert.match(studio, /commitMusicUploaderBeatUpdate/);
assert.match(studio, /evaluateBeatbayAttach/);
assert.match(studio, /musicUploaderMayMutateBeat/);
assert.doesNotMatch(studio, /from\("beatbay_beats"\)[\s\S]{0,120}\.update\(/);
assert.doesNotMatch(studio, /beatbay_beat_assignees\.user_id/);
assert.doesNotMatch(studio, /preview_url:\s*String\(body\.public_url/);
assert.match(assetGuard, /_shared\/beatbox-guard\.mjs/);
assert.doesNotMatch(assetGuard, /beatbay-manager\//);
assert.match(readFileSync("supabase/functions/studio-manager/asset-guard.mjs", "utf8"), /derivedPublicObjectUrl/);

assert.match(beatGuard, /supabase\.rpc\(MUSIC_UPLOADER_BEAT_UPDATE_RPC/);
assert.match(beatGuard, /commit_music_uploader_beat_update/);
assert.doesNotMatch(beatGuard, /beatbay_beat_assignees/);
assert.doesNotMatch(beatGuard, /\.eq\("storefront_enabled"/);
assert.match(beatGuard, /storefront_enabled !== true/);
assert.match(beatGuard, /status: 403/);

assert.match(migration, /security definer/i);
assert.match(migration, /set search_path = ''/);
assert.match(migration, /b\.status = 'draft'/);
assert.match(migration, /duration_type not in \('int2', 'int4', 'int8', 'numeric', 'float4', 'float8'\)/);
assert.match(migration, /coalesce\(b\.storefront_enabled, false\) = false/);
assert.match(migration, /from public\.beatbay_beat_assignees a/);
assert.match(migration, /a\.beat_id = \$2/);
assert.match(migration, /a\.user_id = \$3/);
assert.match(migration, /using p_changes, p_beat_id, p_user_id/);
assert.match(migration, /revoke all on function public\.commit_music_uploader_beat_update\(uuid, uuid, jsonb\) from public, anon, authenticated/i);
assert.match(migration, /grant execute on function public\.commit_music_uploader_beat_update\(uuid, uuid, jsonb\) to service_role/i);
assert.doesNotMatch(migration, /grant execute on function public\.commit_music_uploader_beat_update[\s\S]*to (anon|authenticated|public)/i);

for (const name of [
  "studio-manager",
  "release-manager",
  "beatbay-manager",
  "stripe-release-webhook",
  "release-download",
  "release-storefront",
  "release-support-checkout",
]) {
  assert.match(
    config,
    new RegExp(`\\[functions\\.${name}\\]\\s*verify_jwt\\s*=\\s*false`),
    name,
  );
}
assert.doesNotMatch(config, /\[functions\.release-email-worker\]/);
assert.doesNotMatch(config, /\[functions\.release-admin-data\]/);
assert.doesNotMatch(config, /\[functions\.release-admin-preview\]/);
assert.doesNotMatch(config, /\[functions\.release-social-manager\]/);
assert.match(config, /release-email-worker is not pinned/);
assert.match(config, /docs\/RELEASE-DELIVERY-READINESS\.md/);

assert.match(probe, /rejectPayload\("html named mp3", "probe\.html\.mp3", html, "text\/html"\)/);
assert.match(probe, /putBytes\(signed\.body, id3, "audio\/mpeg"\)/);
assert.doesNotMatch(probe, /putBytes\(signed\.body, id3, "text\/html"\)/);
assert.match(probe, /owner html named mp3/);
assert.match(probe, /owner mz named mp3/);
assert.match(probe, /owner svg/);
assert.match(probe, /valid partner attach/);
assert.match(probe, /publish then partner update/);
assert.match(probe, /a18aa8df39f358a65c11c135e83a27a7553c90ec/);
assert.match(probe, /cmndxzmumfzdtatjdkte/);
assert.match(probe, /process\.env\[name\]/);
assert.doesNotMatch(probe, /eyJ[a-zA-Z0-9_-]{10,}\./);
assert.doesNotMatch(probe, /https:\/\/sktgkrcahsxvidzjjxxt/);
assert.match(probe, /sktgkrcahsxvidzjjxxt/);

const workflow = readFileSync(".github/workflows/validate.yml", "utf8");
assert.match(workflow, /node scripts\/check-owner-upload-quarantine\.mjs/);
assert.match(workflow, /node scripts\/check-studio-asset-guards\.mjs/);

console.log("Owner upload quarantine and beat update checks passed.");
