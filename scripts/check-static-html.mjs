import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const files = [
  "admin-dashboard.html",
  "index.html",
  "beatbay-admin.html",
  "beatbay/index.html",
  "studio/index.html",
  "music-studio.html",
  "password-login.html",
  "owner-recovery.html",
];

for (const file of files) {
  const html = readFileSync(file, "utf8");
  const scripts = [
    ...html.matchAll(/<script(?<attrs>[^>]*)>(?<code>[\s\S]*?)<\/script>/gi),
  ];
  assert.ok(scripts.length, `${file} must contain JavaScript`);

  for (const [index, script] of scripts.entries()) {
    const moduleScript = /type=["']module["']/i.test(script.groups.attrs);
    const checked = spawnSync(
      process.execPath,
      ["--check", `--input-type=${moduleScript ? "module" : "commonjs"}`],
      { input: script.groups.code, encoding: "utf8" },
    );
    assert.equal(
      checked.status,
      0,
      `${file} script ${index + 1} has invalid syntax:\n${checked.stderr}`,
    );
  }
}

const admin = readFileSync("admin-dashboard.html", "utf8");
assert.match(admin, /id="previewRelease"/);
assert.match(
  admin,
  /id="eCover"[^>]*accept="image\/jpeg,image\/png,image\/webp"/s,
);
assert.match(
  admin,
  /dimensions\.width !== 3000 \|\| dimensions\.height !== 3000/,
);
assert.match(admin, /"rosetta_customer_preview"/);
assert.match(admin, /title: release\.title/);
assert.match(admin, /checkout_url: null/);
assert.match(admin, /preview_only: true/);
assert.match(admin, /storefront_enabled: false/);
assert.match(admin, /Release \/ EP title/);
assert.match(admin, /name="psArtistType" value="actual"/);
assert.match(admin, /name="psArtistType" value="ai"/);
assert.match(admin, /name="eArtistType" value="actual"/);
assert.match(admin, /name="eArtistType" value="ai"/);
assert.match(admin, /artist_contact: artistContact\("ps"\)/);
assert.match(admin, /artist_contact: artistContact\("e"\)/);
assert.match(admin, /artist_type: release\.artist_type \|\| null/);

const storefront = readFileSync("index.html", "utf8");
assert.match(storefront, /params\.get\("admin_preview"\) === "1"/);
assert.match(
  storefront,
  /sessionStorage\.getItem\("rosetta_customer_preview"\)/,
);
assert.match(storefront, /preview\.id !== params\.get\("product_id"\)/);
assert.match(storefront, /preview\.preview_only !== true/);
assert.match(
  storefront,
  /previewOnly\s*\?\s*`<span class="buy disabled" aria-disabled="true">PREVIEW ONLY/,
);
assert.match(storefront, /if \(previewOnly \|\| !product_id\) return/);
assert.match(
  storefront,
  /if \(!previewOnly\)\s*document\.addEventListener\(/,
);
assert.doesNotMatch(
  storefront,
  /noindex/,
  "Fan storefront must remain indexable",
);
assert.match(storefront, /release\.artist_type === "actual"/);
assert.match(storefront, /Contact Rosetta Crew for booking inquiries/);
assert.match(storefront, /preview link disabled/);
assert.doesNotMatch(
  storefront,
  /Contact (name|email|phone)/i,
  "Private artist contact fields must not appear on the storefront",
);

const beatbayAdmin = readFileSync("beatbay-admin.html", "utf8");
assert.match(beatbayAdmin, /id="coverCanvas"/);
assert.match(beatbayAdmin, /Download branded PNG/);
assert.match(beatbayAdmin, /www\.RosettaCrew\.com\/BeatBay/);
assert.match(beatbayAdmin, /drawBeatBayCover\(\)/);

const beatbay = readFileSync("beatbay/index.html", "utf8");
assert.match(beatbay, /function beatArt\(b\)/);
assert.match(beatbay, /www\.RosettaCrew\.com\/BeatBay/);
assert.match(beatbay, /BEATBAY  ·  BEATBAY  ·  BEATBAY/);
assert.match(beatbay, /classList\.add\("is-playing"\)/);
assert.match(beatbay, /role="tablist" aria-label="BeatBay sales options"/);
assert.match(beatbay, /data-channel="lease"/);
assert.match(beatbay, /data-channel="auction"/);
assert.match(
  beatbay,
  /channel==="auction"\?hasAuction\(b\):!hasAuction\(b\)/,
  "Auction beats must be separated from lease beats",
);
assert.match(beatbay, /function commerceMarkup\(b\)/);
assert.match(beatbay, /hasAuction\(b\).*Place bid/s);
assert.match(beatbay, /hasAuction\(b\).*License beat/s);
assert.doesNotMatch(
  storefront,
  /www\.RosettaCrew\.com\/BeatBay/,
  "BeatBay watermarking must remain isolated from music releases",
);

const releaseManager = readFileSync(
  "supabase/functions/release-manager/index.ts",
  "utf8",
);
const releaseStorefront = readFileSync(
  "supabase/functions/release-storefront/index.ts",
  "utf8",
);
const studioManager = readFileSync(
  "supabase/functions/studio-manager/index.ts",
  "utf8",
);
assert.match(releaseManager, /release_artist_contacts/);
assert.match(releaseManager, /normalizeArtistType/);
assert.match(releaseManager, /function activeCheckoutPrice/);
assert.match(releaseManager, /function nextStorefrontStatus/);
assert.match(releaseManager, /function formatErrorMessage/);
assert.match(releaseManager, /function storefrontError/);
assert.match(releaseManager, /digital_product/);
assert.match(releaseManager, /description\.slice\(0, 400\)/);
assert.match(
  releaseManager,
  /Set a regular or pre-sale price greater than \$0\.00/,
);
assert.match(releaseManager, /return json\(\{ error: storefrontError\(ue\) \}, 400\)/);
assert.match(releaseManager, /formatErrorMessage\(error\)/);
assert.doesNotMatch(
  releaseManager,
  /error instanceof Error \? error\.message : String\(error\)/,
  "Publish errors must never stringify as [object Object]",
);
assert.match(
  readFileSync("supabase/migrations/20260905_storefront_publish_followup.sql", "utf8"),
  /stripe_payment_link_id type text/,
);
assert.match(releaseStorefront, /artist_type:r\.artist_type\?\?null/);
assert.doesNotMatch(releaseStorefront, /contact_(name|email|phone)/);
assert.match(
  releaseManager,
  /music_uploader is intentionally excluded/,
);
assert.doesNotMatch(
  releaseManager,
  /\["owner","admin","staff","music_uploader"\]/,
);
assert.match(releaseManager, /action === "grant_uploader"/);
assert.match(releaseManager, /action === "assign_uploader"/);
assert.match(studioManager, /admin.role !== "music_uploader"/);
assert.match(studioManager, /FINANCE_OR_OWNER_ACTIONS/);
assert.match(studioManager, /release_product_assignees/);
assert.match(studioManager, /return json\(\{ error: "Forbidden" \}, 403\)/);
assert.doesNotMatch(studioManager, /release_analytics_summary/);
assert.doesNotMatch(studioManager, /release_orders/);
assert.doesNotMatch(studioManager, /STRIPE_SECRET_KEY/);
assert.doesNotMatch(studioManager, /createCheckout/);

const studio = readFileSync("studio/index.html", "utf8");
assert.match(studio, /<title>Rosetta Crew Music Studio Portal<\/title>/);
assert.match(studio, /<meta name="robots" content="noindex,nofollow"\s*\/?>/);
assert.match(studio, /MUSIC STUDIO PORTAL/);
assert.match(studio, /functions\/v1\/studio-manager/);
assert.match(studio, /shouldCreateUser: false/);
assert.doesNotMatch(studio, /id="email"[^>]*value=/s);
assert.doesNotMatch(studio, /admin-dashboard\.html/);
assert.doesNotMatch(studio, /data-tab="analytics"/);
assert.doesNotMatch(studio, /data-tab="orders"/);
assert.doesNotMatch(studio, /data-tab="delivery"/);
assert.doesNotMatch(studio, /data-tab="promote"/);
assert.doesNotMatch(studio, /release-admin-data/);
assert.doesNotMatch(studio, /release-manager/);

const musicStudio = readFileSync("music-studio.html", "utf8");
const beatbayManager = readFileSync("supabase/functions/beatbay-manager/index.ts", "utf8");
const adminPreview = readFileSync("supabase/functions/release-admin-preview/index.ts", "utf8");
const adminData = readFileSync("supabase/functions/release-admin-data/index.ts", "utf8");
const socialManager = readFileSync("supabase/functions/release-social-manager/index.ts", "utf8");
assert.match(musicStudio, /location\.replace\("\/studio\/"\)/);
assert.match(musicStudio, /<meta http-equiv="refresh" content="0; url=\/studio\/">/);
assert.doesNotMatch(musicStudio, /release-manager|beatbay-manager|release-admin-data/i);
assert.doesNotMatch(musicStudio, /data-tab="analytics"|data-tab="orders"|STRIPE|checkout/i);
assert.match(releaseManager, /view === "activity"/);
assert.match(releaseManager, /hasOwnerAccess\(sessionAdmin, fallbackKey\)/);
assert.match(beatbayManager, /music_uploader is intentionally excluded/);
assert.doesNotMatch(beatbayManager, /\["owner", "admin", "staff", "music_uploader"\]/);
assert.match(beatbayManager, /action === "save_auction"/);
assert.doesNotMatch(adminPreview, /music_uploader/);
assert.match(adminData, /\["owner", "admin"\]\.includes\(member\.role\)/);
assert.match(socialManager, /member\.role !== "owner"/);
assert.doesNotMatch(socialManager, /\["owner", "admin"\]/);
assert.doesNotMatch(socialManager, /music_uploader/);
assert.match(socialManager, /Owner approval required/);
assert.match(admin, /Music Team Activity Report/);
assert.match(admin, /href="studio\/"/);

const publicFiles = [
  "admin-dashboard.html",
  "owner-login.html",
  "admin.html",
  "admin-v2.html",
  "index.html",
  "live.html",
  "storefront-v2.html",
  "admin-sw.js",
  "manifest.webmanifest",
  "admin.webmanifest",
  "beatbay-admin.html",
  "beatbay/index.html",
  "studio/index.html",
  "music-studio.html",
  "password-login.html",
  "owner-recovery.html",
];
const publicBundle = publicFiles
  .filter((file) => existsSync(file))
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");
assert.doesNotMatch(
  publicBundle,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  "No hardcoded email addresses in public client assets",
);
assert.doesNotMatch(publicBundle, /signUp\s*\(/);
assert.doesNotMatch(publicBundle, /shouldCreateUser\s*:\s*true/);

assert.match(admin, /<meta name="robots" content="noindex,nofollow"\s*\/?>/);
assert.match(admin, /shouldCreateUser:\s*false/);
assert.match(admin, /id="email"[^>]*placeholder="Owner email"/s);
assert.doesNotMatch(admin, /id="email"[^>]*value=/s);
assert.match(admin, /id="password"/);
assert.match(admin, /id="signin"/);
assert.match(admin, /Sign in/);
assert.match(admin, /signInWithPassword/);
assert.match(admin, /getAuthenticatorAssuranceLevel/);
assert.match(admin, /currentLevel !== "aal2"/);
assert.match(admin, /challengeAndVerify/);
assert.match(admin, /mfa\.enroll/);
assert.match(admin, /Emergency email link/);
assert.match(admin, /Send emergency sign-in link/);
assert.doesNotMatch(admin, /Send secure sign-in link/);
assert.match(admin, /resetPasswordForEmail/);
assert.match(admin, /owner-recovery\.html/);
assert.doesNotMatch(
  admin,
  /console\.(log|debug|info)\([^)]*(access_token|refresh_token|totp\.secret|session)/,
);
assert.match(admin, /rel="manifest" href="manifest.webmanifest"/);
assert.match(admin, /apple-mobile-web-app-capable/);
assert.match(admin, /apple-mobile-web-app-title" content="Release Station"/);
assert.match(admin, /id="menuBtn"/);
assert.match(admin, /\.shell\.navOpen \.nav/);
assert.match(admin, /id="toast"/);
assert.match(admin, /function toast\(/);
assert.match(admin, /function formatErrorMessage/);
assert.match(admin, /throw Error\(formatErrorMessage\(j\.error \|\| j/);
assert.match(admin, /toast\(err \|\| "Storefront update failed\."/);
assert.doesNotMatch(admin, /textContent = String\(message/);
assert.match(admin, /Turning On…/);
assert.doesNotMatch(
  admin,
  /storefrontToggle[\s\S]*alert\(err\.message\)/,
  "Storefront toggle must surface publish errors with a toast, not alert()",
);

const ownerLogin = readFileSync("owner-login.html", "utf8");
assert.match(
  ownerLogin,
  /<meta name="robots" content="noindex,nofollow"\s*\/?>/,
);
assert.match(ownerLogin, /admin-dashboard\.html/);
assert.doesNotMatch(ownerLogin, /id="email"/);

const manifest = JSON.parse(readFileSync("manifest.webmanifest", "utf8"));
assert.equal(manifest.name, "Release Station");
assert.equal(manifest.short_name, "Release Station");
assert.equal(manifest.theme_color, "#080808");
assert.equal(manifest.background_color, "#080808");
assert.equal(manifest.display, "standalone");
assert.equal(manifest.start_url, "/admin-dashboard.html");
assert.match(admin, /rel="apple-touch-icon" href="apple-touch-icon\.png"/);
assert.ok(
  existsSync("apple-touch-icon.png"),
  "apple-touch-icon.png 180x180 is required",
);
assert.ok(
  existsSync("assets/release-station-180.png"),
  "assets/release-station-180.png is required",
);
assert.ok(existsSync("assets/release-station-192.png"));
assert.ok(existsSync("assets/release-station-512.png"));

function pngSize(path) {
  const buf = readFileSync(path);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
assert.deepEqual(pngSize("apple-touch-icon.png"), { width: 180, height: 180 });
assert.deepEqual(pngSize("assets/release-station-180.png"), {
  width: 180,
  height: 180,
});
assert.deepEqual(pngSize("assets/release-station-192.png"), {
  width: 192,
  height: 192,
});
assert.deepEqual(pngSize("assets/release-station-512.png"), {
  width: 512,
  height: 512,
});
assert.equal(
  manifest.icons[0].src,
  "/assets/release-station-192.png",
);
assert.equal(
  manifest.icons[1].src,
  "/assets/release-station-512.png",
);

const robots = readFileSync("robots.txt", "utf8");
const passwordLogin = readFileSync("password-login.html", "utf8");
assert.match(passwordLogin, /signInWithPassword/);
assert.doesNotMatch(passwordLogin, /id="email"[^>]*value=/s);
assert.match(passwordLogin, /admin-dashboard\.html/);
assert.match(
  passwordLogin,
  /authenticator verification \(AAL2\)/,
);

const ownerRecovery = readFileSync("owner-recovery.html", "utf8");
assert.match(ownerRecovery, /<meta name="robots" content="noindex,nofollow"\s*\/?>/);
assert.match(ownerRecovery, /updateUser\(\{ password \}\)/);
assert.match(ownerRecovery, /PASSWORD_RECOVERY/);
assert.doesNotMatch(ownerRecovery, /release-admin-data/);
assert.doesNotMatch(ownerRecovery, /data-tab="overview"/);

assert.match(robots, /Disallow: \/admin-dashboard\.html/);
assert.match(robots, /Disallow: \/studio\//);
assert.match(robots, /Disallow: \/music-studio\.html/);
assert.match(robots, /Disallow: \/password-login\.html/);
assert.match(robots, /Disallow: \/owner-recovery\.html/);
assert.match(robots, /Allow: \//);

const helpers = spawnSync(process.execPath, ["scripts/check-publish-helpers.mjs"], {
  encoding: "utf8",
});
assert.equal(
  helpers.status,
  0,
  `Publish helper checks failed:\n${helpers.stderr || helpers.stdout}`,
);

console.log("Static HTML and private-preview checks passed.");
