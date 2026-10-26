import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const sums = readFileSync("vendor/SHA384SUMS", "utf8")
  .split(/\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));

assert.ok(sums.length >= 3, "SHA384SUMS must list the vendored libraries");

for (const line of sums) {
  const match = /^sha384-(\S+)\s+(\S+)$/.exec(line);
  assert.ok(match, `Bad SHA384SUMS line: ${line}`);
  const [, b64, file] = match;
  const digest = createHash("sha384").update(readFileSync(file)).digest("base64");
  assert.equal(digest, b64, `${file} does not match its vendored SRI`);
}

const joined = sums.join("\n");
assert.match(joined, /hash-wasm-4\.12\.0\/sha256\.umd\.min\.js/);
assert.match(joined, /zipjs-2\.18\.2\/zip\.min\.js/);
assert.match(joined, /client-zip-2\.5\.1\/index\.js/);
assert.doesNotMatch(joined, /esm\.sh/);

console.log("Vendored library checksums passed.");
