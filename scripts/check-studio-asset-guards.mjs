import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readAnalytics } from "../supabase/functions/release-manager/analytics-gate.mjs";
import {
  PUBLIC_BUCKET,
  QUARANTINE_BUCKET,
  beatbaySignedUploadTarget,
  commitPromotion,
  evaluateBeatbayAttach,
  evaluateReleaseCoverAttach,
  musicUploaderMayMutateBeat,
  promotionUploadOptions,
  rejectUpload,
  releaseCoverSignedUploadTarget,
} from "../supabase/functions/studio-manager/asset-guard.mjs";

const beatId = "11111111-1111-4111-8111-111111111111";
const otherBeatId = "22222222-2222-4222-8222-222222222222";
const fileId = "33333333-3333-4333-8333-333333333333";
const supabaseUrl = "https://example.supabase.co";
const evilPublicUrl = "https://evil.example/not-a-preview";
const draft = { status: "draft", storefront_enabled: false };
const previewPath = `beatbay/${beatId}/preview/${fileId}.mp3`;
const id3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
const html = new TextEncoder().encode("<!DOCTYPE html><html><body>not audio</body></html>");
const scriptHtml = new TextEncoder().encode("<script>alert(1)</script>");
const mz = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

function attach(overrides = {}) {
  return evaluateBeatbayAttach({
    assigned: true,
    beat: draft,
    beatId,
    kind: "preview",
    path: previewPath,
    bodyPublicUrl: evilPublicUrl,
    bytes: id3,
    supabaseUrl,
    durationSeconds: 30,
    ...overrides,
  });
}

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

const published = attach({ beat: { status: "published", storefront_enabled: false } });
assert.equal(published.status, 403, "assigned music_uploader on a published beat");
assert.equal(published.changes, undefined);

const storefront = attach({ beat: { status: "draft", storefront_enabled: true } });
assert.equal(storefront.status, 403, "assigned music_uploader on a storefront-enabled beat");

assert.equal(musicUploaderMayMutateBeat(true, draft).ok, true);
const unassigned = attach({ assigned: false, beat: draft });
assert.equal(unassigned.status, 403, "after unassign");
assert.equal(attach({ assigned: false, beat: null }).status, 403);

for (const [label, path] of [
  ["dotdot", `beatbay/${beatId}/preview/../${otherBeatId}/preview/${fileId}.mp3`],
  ["encoded dotdot", `beatbay/${beatId}/preview/%2e%2e/${fileId}.mp3`],
  ["encoded slash", `beatbay/%2f${otherBeatId}/preview/${fileId}.mp3`],
  ["leading slash", `/${previewPath}`],
  ["foreign beat", `beatbay/${otherBeatId}/preview/${fileId}.mp3`],
  ["other prefix", `uploads/${beatId}/preview/${fileId}.mp3`],
  ["quarantine prefix", `beatbay/${beatId}/quarantine/${fileId}.mp3`],
  ["backslash", `beatbay\\${beatId}\\preview\\${fileId}.mp3`],
]) {
  const decision = attach({ path });
  assert.equal(decision.status, 400, label);
  assert.equal(decision.promote, undefined, label);
}

const ignored = attach();
assert.equal(ignored.status, 200);
const expectedPreviewUrl = `${supabaseUrl}/storage/v1/object/public/${PUBLIC_BUCKET}/${previewPath}`;
assert.equal(ignored.changes.preview_url, expectedPreviewUrl);
assert.equal(JSON.stringify(ignored).includes("evil.example"), false);
assert.equal(ignored.promote.contentType, "audio/mpeg");
assert.equal(ignored.promote.toBucket, PUBLIC_BUCKET);
assert.equal(ignored.promote.fromBucket, QUARANTINE_BUCKET);
assert.deepEqual(promotionUploadOptions(ignored.promote), {
  contentType: "audio/mpeg",
  upsert: false,
});

const validStore = memoryStorage([[`${QUARANTINE_BUCKET}/${previewPath}`, { bytes: id3 }]]);
await commitPromotion(validStore, ignored.promote);
assert.equal(validStore.objects.get(`${PUBLIC_BUCKET}/${previewPath}`).contentType, "audio/mpeg");
assert.equal(validStore.objects.has(`${QUARANTINE_BUCKET}/${previewPath}`), false);

for (const [label, bytes] of [
  ["html payload named mp3", html],
  ["script payload named mp3", scriptHtml],
  ["mz payload named mp3", mz],
]) {
  const decision = attach({ bytes });
  assert.equal(decision.status, 400, label);
  assert.equal(decision.promote, undefined, label);
  const store = memoryStorage([[`${QUARANTINE_BUCKET}/${previewPath}`, { bytes, contentType: "audio/mpeg" }]]);
  await rejectUpload(store, decision.remove);
  assert.equal(store.objects.has(`${QUARANTINE_BUCKET}/${previewPath}`), false, label);
  assert.equal([...store.objects.keys()].some((key) => key.startsWith(`${PUBLIC_BUCKET}/`)), false, label);
}

const signedPreview = beatbaySignedUploadTarget(beatId, "preview", fileId, "mp3");
assert.equal(signedPreview.ok, true);
assert.equal(signedPreview.bucket, QUARANTINE_BUCKET);
assert.equal(signedPreview.public_url, null);
assert.equal(signedPreview.quarantine, true);
assert.equal(signedPreview.path, previewPath);

const productId = "44444444-4444-4444-8444-444444444444";
const coverPath = `${productId}/cover/cover-${fileId}.jpg`;
const signedCover = releaseCoverSignedUploadTarget(productId, fileId, "jpg");
assert.equal(signedCover.bucket, QUARANTINE_BUCKET);
assert.equal(signedCover.public_url, null);
assert.equal(signedCover.path, coverPath);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const coverOk = evaluateReleaseCoverAttach({ productId, path: coverPath, bytes: jpeg });
assert.equal(coverOk.status, 200);
assert.equal(coverOk.mime, "image/jpeg");
assert.equal(coverOk.promote.contentType, "image/jpeg");
assert.equal(coverOk.promote.toBucket, PUBLIC_BUCKET);
const coverHtml = evaluateReleaseCoverAttach({ productId, path: coverPath, bytes: html });
assert.equal(coverHtml.status, 400);

let analyticsQueries = 0;
const staffAnalytics = await readAnalytics({
  role: "staff",
  fallbackKey: false,
  query: async () => {
    analyticsQueries += 1;
    return [{ paid_orders: 3, gross_revenue_cents: 900 }];
  },
});
assert.equal(staffAnalytics.status, 403);
assert.equal(staffAnalytics.queried, false);
assert.equal(analyticsQueries, 0);
assert.equal(JSON.stringify(staffAnalytics.body).includes("gross_revenue_cents"), false);
assert.equal(JSON.stringify(staffAnalytics.body).includes("paid_orders"), false);

const ownerAnalytics = await readAnalytics({
  role: "owner",
  fallbackKey: false,
  query: async () => {
    analyticsQueries += 1;
    return [{ title: "EP" }];
  },
});
assert.equal(ownerAnalytics.status, 200);
assert.equal(ownerAnalytics.queried, true);
assert.equal(analyticsQueries, 1);
assert.deepEqual(ownerAnalytics.body.analytics, [{ title: "EP" }]);

const adminAnalytics = await readAnalytics({
  role: "admin",
  fallbackKey: false,
  query: async () => [{ title: "admin" }],
});
assert.equal(adminAnalytics.status, 200);
const ownerKeyAnalytics = await readAnalytics({
  role: "staff",
  fallbackKey: true,
  query: async () => [{ title: "owner-key" }],
});
assert.equal(ownerKeyAnalytics.status, 200);

const studio = readFileSync("supabase/functions/studio-manager/index.ts", "utf8");
const release = readFileSync("supabase/functions/release-manager/index.ts", "utf8");
const probe = readFileSync("scripts/probe-studio-asset-guards.mjs", "utf8");
assert.match(studio, /musicUploaderMayMutateBeat/);
assert.match(studio, /evaluateBeatbayAttach/);
assert.match(studio, /beatbaySignedUploadTarget/);
assert.match(studio, /evaluateReleaseCoverAttach/);
assert.match(studio, /commitPromotion/);
assert.doesNotMatch(studio, /preview_url:\s*String\(body\.public_url/);
assert.doesNotMatch(studio, /mime:\s*String\(body\.mime/);
assert.match(studio, /mime:\s*decision\.mime/);
assert.match(release, /readAnalytics\(/);
assert.match(release, /view === "analytics"[\s\S]*?readAnalytics\(/);
assert.match(probe, /process\.env\[name\]/);
assert.match(probe, /"SUPABASE_URL"/);
assert.match(probe, /"MUSIC_UPLOADER_JWT"/);
assert.match(probe, /"STAFF_JWT"/);
assert.match(probe, /"OWNER_JWT"/);
assert.doesNotMatch(probe, /eyJ[a-zA-Z0-9_-]{10,}\./);
assert.doesNotMatch(probe, /https:\/\/sktgkrcahsxvidzjjxxt/);
assert.match(probe, /sktgkrcahsxvidzjjxxt/);

console.log("Studio asset guard checks passed.");
