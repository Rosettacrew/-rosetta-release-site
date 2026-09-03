import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const files = ["admin-dashboard.html", "index.html"];

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
assert.match(admin, /storefront_enabled: false/);
assert.match(admin, /Release \/ EP title/);

const storefront = readFileSync("index.html", "utf8");
assert.match(storefront, /params\.get\("admin_preview"\) === "1"/);
assert.match(
  storefront,
  /sessionStorage\.getItem\("rosetta_customer_preview"\)/,
);
assert.match(storefront, /preview\.id !== params\.get\("product_id"\)/);
assert.match(storefront, /buy\.removeAttribute\("href"\)/);
assert.match(storefront, /if \(previewOnly \|\| !product_id\) return/);
assert.doesNotMatch(
  storefront,
  /noindex/,
  "Fan storefront must remain indexable",
);

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
assert.match(admin, /rel="manifest" href="manifest.webmanifest"/);
assert.match(admin, /apple-mobile-web-app-capable/);
assert.match(admin, /apple-mobile-web-app-title" content="Release Station"/);
assert.match(admin, /id="menuBtn"/);
assert.match(admin, /\.shell\.navOpen \.nav/);

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
assert.match(robots, /Disallow: \/admin-dashboard\.html/);
assert.match(robots, /Allow: \//);

console.log("Static HTML and private-preview checks passed.");
