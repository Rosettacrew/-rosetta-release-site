import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LIMITS,
  buildPublishBody,
  buildReviewDraft,
  buildSaveBody,
  canPublishRole,
  canonicalZipPath,
  declaredSizeMatches,
  defaultLicensing,
  filenameHints,
  isZipSymlink,
  nextBeatCode,
  parseSidecar,
  suggestStyle,
  uploadFilename,
  validateReview,
  validateZipEntries,
  viewZipEntry,
  zipRejectedReason,
} from "../beatbox/package-rules.mjs";

function entry(name, extra = {}) {
  return {
    originalName: name,
    zipName: extra.zipName || name.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/{2,}/g, "/"),
    dir: !!extra.dir || String(name).endsWith("/"),
    uncompressedSize: extra.uncompressedSize ?? 128,
    compressedSize: extra.compressedSize ?? 64,
    unixPermissions: extra.unixPermissions ?? null,
  };
}

const happy = validateZipEntries([
  entry("audio/"),
  entry("audio/preview.mp3", { uncompressedSize: 2048, compressedSize: 1800 }),
  entry("audio/full.wav", { uncompressedSize: 4096, compressedSize: 4000 }),
  entry("cover.jpg", { uncompressedSize: 1024, compressedSize: 900 }),
  entry("beat.json", { uncompressedSize: 180, compressedSize: 120 }),
  entry("__MACOSX/._preview.mp3"),
  entry(".DS_Store", { uncompressedSize: 40, compressedSize: 20 }),
]);
assert.equal(happy.ok, true, happy.errors.join("\n"));
assert.equal(happy.preview.path, "audio/preview.mp3");
assert.equal(happy.full.path, "audio/full.wav");
assert.equal(happy.cover.path, "cover.jpg");
assert.equal(happy.sidecar.path, "beat.json");

const dotted = validateZipEntries([
  entry("/", { dir: true, uncompressedSize: 0, compressedSize: 0 }),
  entry("./audio/preview.mp3", { zipName: "audio/preview.mp3" }),
]);
assert.equal(dotted.ok, true, dotted.errors.join("\n"));
assert.equal(dotted.preview.path, "audio/preview.mp3");
assert.equal(dotted.preview.zipName, "audio/preview.mp3");

const rootMp3 = validateZipEntries([entry("Night Drive.mp3")]);
assert.equal(rootMp3.ok, true);
assert.equal(rootMp3.preview.path, "Night Drive.mp3");
assert.equal(rootMp3.full, null);

const traversal = validateZipEntries([
  entry("../evil.mp3"),
  entry("audio/../../x.wav"),
  entry("/tmp/abs.mp3"),
  entry("C:/Windows/note.mp3"),
  entry("audio/preview.mp3"),
]);
assert.equal(traversal.ok, false);
assert.equal(traversal.preview, null);
assert.ok(traversal.errors.some((error) => error.includes("path traversal")));
assert.ok(traversal.errors.some((error) => error.includes("absolute path")));

const rewritten = viewZipEntry({
  name: "evil.mp3",
  unsafeOriginalName: "../evil.mp3",
  dir: false,
  _data: { uncompressedSize: 10, compressedSize: 8 },
  unixPermissions: null,
});
assert.equal(validateZipEntries([rewritten]).ok, false);

const symlink = validateZipEntries([
  entry("audio/preview.mp3", { unixPermissions: 0o120755, uncompressedSize: 20, compressedSize: 10 }),
]);
assert.equal(symlink.ok, false);
assert.match(symlink.errors[0], /symbolic links/);
assert.equal(isZipSymlink(0o100644), false);
assert.equal(isZipSymlink(null), false);

const nested = validateZipEntries([entry("audio/preview.mp3"), entry("stems.zip")]);
assert.equal(nested.ok, false);
assert.match(nested.errors.join("\n"), /nested ZIP/);

const executable = validateZipEntries([entry("preview.mp3"), entry("drop.exe"), entry("run.sh")]);
assert.equal(executable.ok, false);
assert.match(executable.errors.join("\n"), /executable or script/);

const unexpected = validateZipEntries([entry("preview.mp3"), entry("notes.pdf")]);
assert.equal(unexpected.ok, false);
assert.match(unexpected.errors.join("\n"), /unexpected file type/);

assert.equal(validateZipEntries([]).ok, false);
assert.match(validateZipEntries([entry("__MACOSX/junk")]).errors.join("\n"), /empty/);
assert.match(validateZipEntries([entry("cover.jpg")]).errors.join("\n"), /at least one MP3 or WAV/);
assert.equal(validateZipEntries([entry("a.mp3"), entry("b.mp3")]).ok, false);
assert.equal(validateZipEntries([entry("preview.mp3", { uncompressedSize: 0 })]).ok, false);
assert.match(
  validateZipEntries([entry("preview.mp3", { uncompressedSize: LIMITS.audioBytes + 1, compressedSize: LIMITS.audioBytes })]).errors.join("\n"),
  /80 MB/,
);
assert.match(
  validateZipEntries([entry("preview.mp3", { uncompressedSize: 500000, compressedSize: 10 })]).errors.join("\n"),
  /compression ratio/,
);

assert.equal(canonicalZipPath("audio/preview.mp3").path, "audio/preview.mp3");
assert.equal(canonicalZipPath("./audio/preview.mp3").path, "audio/preview.mp3");
assert.equal(canonicalZipPath("../x.mp3").error, "path traversal");

assert.match(zipRejectedReason({ name: "beat.zip", size: LIMITS.zipBytes + 1 }), /100 MB/);
assert.equal(zipRejectedReason({ name: "beat.zip", size: 100 }), null);
assert.match(zipRejectedReason({ name: "beat.rar", size: 100 }), /\.zip/);

const sidecar = parseSidecar(JSON.stringify({
  title: "Night Drive",
  bpm: 140,
  style: "Trap",
  key: "F minor",
  tags: ["Trap", "Dark"],
  description: "Late night keys.",
  beat_code: "beat 0007",
}));
assert.equal(sidecar.ok, true);
assert.equal(sidecar.fields.beat_code, "BEAT 0007");
assert.equal(sidecar.fields.tags, "trap, dark");
assert.equal(sidecar.fields.musical_key, "F minor");
assert.match(parseSidecar("{").error, /not valid JSON/);
assert.equal(parseSidecar("[]").ok, false);
assert.ok(parseSidecar('{"bpm":12}').warnings.some((warning) => warning.includes("BPM")));

const hints = filenameHints("audio/ny-drill-140bpm-Fmin.mp3");
assert.equal(hints.bpm, 140);
assert.equal(hints.style, "NY Drill");
assert.equal(hints.musical_key, "F minor");
assert.match(hints.title, /Ny Drill/i);
assert.equal(suggestStyle("session.wav", 98), "R&B / Hip-Hop");
assert.equal(suggestStyle("gospel-choir.wav", 140), "Gospel");

const draft = buildReviewDraft({
  previewPath: "ny-drill-140bpm.mp3",
  sidecar,
  existingCodes: ["BEAT 0001", "BEAT 0007"],
});
assert.equal(draft.beat_code, "BEAT 0008");
assert.equal(draft.title, "Night Drive");
assert.equal(draft.bpm, 140);
assert.equal(draft.style, "Trap");
assert.equal(draft.suggestions.bpm, null);
assert.equal(draft.nonexclusive_enabled, true);
assert.equal(draft.exclusive_enabled, false);
assert.equal(draft.ownership_enabled, false);
assert.ok(draft.warnings.some((warning) => warning.includes("already in the catalog")));

const filenameDraft = buildReviewDraft({
  previewPath: "ny-drill-140bpm.mp3",
  sidecar: { ok: true, fields: {}, warnings: [] },
  existingCodes: [],
});
assert.equal(filenameDraft.beat_code, "BEAT 0000");
assert.equal(filenameDraft.bpm, "");
assert.equal(filenameDraft.suggestions.bpm, 140);
assert.equal(filenameDraft.suggestions.style, "NY Drill");
assert.equal(filenameDraft.sources.title, "filename");
assert.equal(defaultLicensing().nonexclusive_price, "30.00");
assert.equal(nextBeatCode(["BEAT 0003", "nope"]), "BEAT 0004");

const save = buildSaveBody(filenameDraft, { publish: false });
assert.equal(save.action, "save_beat");
assert.equal(save.intake, "beatbox");
assert.equal(save.status, "draft");
assert.equal(save.metadata_source, "beatbox");
assert.equal(save.exclusive_enabled, false);
assert.equal(save.ownership_enabled, false);
assert.equal(save.nonexclusive_enabled, true);
assert.equal(save.nonexclusive_price, "30.00");
assert.equal(save.signature_sound, false);
assert.equal("storefront_enabled" in save, false);
assert.equal("enabled" in save, false);

const opted = buildSaveBody({ ...filenameDraft, exclusive_enabled: true, exclusive_price: "250.00" }, { id: "abc", publish: true });
assert.equal(opted.status, "available");
assert.equal(opted.exclusive_enabled, true);
assert.equal(opted.exclusive_price, "250.00");
assert.equal(opted.ownership_enabled, false);
assert.deepEqual(buildPublishBody("abc"), { action: "set_storefront", id: "abc", enabled: true });
assert.deepEqual(validateReview({ ...filenameDraft, title: "" }), ["Title is required."]);
assert.equal(canPublishRole("owner"), true);
assert.equal(canPublishRole("admin"), true);
assert.equal(canPublishRole("staff"), false);
assert.equal(canPublishRole("music_uploader"), false);
assert.equal(uploadFilename("preview", "mp3"), "preview.mp3");
assert.equal(uploadFilename("full", "wav"), "full.wav");
assert.equal(declaredSizeMatches(12, 12), true);
assert.equal(declaredSizeMatches(12, 13), false);
assert.throws(() => uploadFilename("preview", "exe"));

const html = readFileSync("beatbox.html", "utf8");
assert.match(html, /<meta name="robots" content="noindex,nofollow"\s*\/?>/);
assert.match(html, /from "\.\/beatbox\/package-rules\.mjs"/);
assert.match(html, /https:\/\/esm\.sh\/jszip@3\.10\.1/);
assert.match(html, /shouldCreateUser:\s*false/);
assert.match(html, /id="drop"/);
assert.match(html, /id="confirmPublish"/);
assert.match(html, /async function approvePublish/);
assert.match(html, /async function saveDraft/);
const beforeApprove = html.slice(0, html.indexOf("async function approvePublish"));
assert.doesNotMatch(beforeApprove, /buildPublishBody\(/);
assert.match(html.slice(html.indexOf("async function approvePublish")), /buildPublishBody\(/);
assert.match(html, /if \(!canPublishRole\(role\)\) throw Error\("Owner or admin approval is required to publish\."\)/);
assert.match(html, /unsafeOriginalName/);
assert.doesNotMatch(html, /service_role|SUPABASE_SERVICE_ROLE|SUPABASE_SECRET/);
assert.doesNotMatch(html, /storefront_enabled:\s*true/);

const manager = readFileSync("supabase/functions/beatbay-manager/index.ts", "utf8");
assert.match(manager, /function beatboxLicenseChanges/);
assert.match(manager, /Beatbox intake records a draft/);
assert.match(manager, /body\.intake === "beatbox"/);
assert.match(manager, /Beatbox cannot publish from save/);
const licenseFn = manager.slice(manager.indexOf("function beatboxLicenseChanges"), manager.indexOf("async function activityReport"));
assert.doesNotMatch(licenseFn, /storefront_enabled/);
const saveAction = manager.slice(manager.indexOf('if (action === "save_beat")'), manager.indexOf('if (["set_storefront"'));
assert.match(saveAction, /beatboxIntake \? \{ storefront_enabled: false, is_featured: false \}/);
assert.doesNotMatch(saveAction, /storefront_enabled:\s*true/);
assert.match(manager, /action === "set_storefront"/);
assert.match(manager, /if \(!ownerAccess\) return json\(\{ error: "Owner approval required" \}, 403\)/);
assert.match(saveAction, /status: ownerAccess \? status : "draft"/);

const admin = readFileSync("beatbay-admin.html", "utf8");
assert.match(admin, /href="beatbox\.html"/);
const robots = readFileSync("robots.txt", "utf8");
assert.match(robots, /Disallow: \/beatbox\.html/);
assert.match(robots, /Disallow: \/beatbox\//);
const customer = readFileSync("beatbay/index.html", "utf8");
assert.doesNotMatch(customer, /beatbox\.html/);

console.log("Beatbox package rules passed.");
