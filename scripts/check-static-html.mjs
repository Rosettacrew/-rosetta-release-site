import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

console.log("Static HTML and private-preview checks passed.");
