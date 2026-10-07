import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const SUMS_PATH = "vendor/SHA384SUMS";
const SOURCE_EXTS = new Set([".html", ".js", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set([".git", "node_modules"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

function rel(path) {
  return relative(ROOT, path).split(sep).join("/");
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

function isRemote(url) {
  return /^https?:\/\//i.test(url) || url.startsWith("//");
}

function attr(attrs, name) {
  const match = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`,
    "i",
  ).exec(attrs);
  if (match) return match[1] ?? match[2] ?? match[3] ?? "";
  if (new RegExp(`\\b${name}\\b`, "i").test(attrs)) return "";
  return null;
}

function hasCrossorigin(attrs) {
  return /\bcrossorigin\b/i.test(attrs);
}

function sha384AttributeOk(value) {
  return typeof value === "string" && /^sha384-[A-Za-z0-9+/]+={0,2}$/.test(value);
}

const problems = [];

function fail(message) {
  problems.push(message);
}

const sumsText = readFileSync(join(ROOT, SUMS_PATH), "utf8");
const listed = new Map();
for (const [index, raw] of sumsText.split("\n").entries()) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const match = /^sha384-(\S+)\s+(\S+)$/.exec(line);
  if (!match) {
    fail(`${SUMS_PATH}:${index + 1} is not 'sha384-<base64>  <path>'`);
    continue;
  }
  const [, digest, file] = match;
  if (listed.has(file)) fail(`${SUMS_PATH} lists ${file} more than once`);
  listed.set(file, digest);
}

const vendored = walk(join(ROOT, "vendor"))
  .map(rel)
  .filter((file) => file !== SUMS_PATH)
  .sort();

for (const file of vendored) {
  const expected = listed.get(file);
  if (!expected) {
    fail(`${file} is under vendor/ but missing from ${SUMS_PATH}`);
    continue;
  }
  const digest = createHash("sha384").update(readFileSync(join(ROOT, file))).digest("base64");
  if (digest !== expected) {
    fail(`${file} sha384-${digest} does not match ${SUMS_PATH} sha384-${expected}`);
  }
}

for (const file of listed.keys()) {
  if (!vendored.includes(file)) fail(`${SUMS_PATH} lists missing file ${file}`);
}

const sources = walk(ROOT).filter((path) => {
  const name = path.slice(path.lastIndexOf(sep) + 1);
  const dot = name.lastIndexOf(".");
  return dot !== -1 && SOURCE_EXTS.has(name.slice(dot).toLowerCase());
});

const importSpecifier =
  /(?:^|[^.\w$])(?:import|export)\s*(?:[^"'`;]*?\sfrom\s*)?["'](https?:\/\/[^"']+|\/\/[^"']+)["']/g;
const dynamicImport =
  /(?:^|[^.\w$])import\s*\(\s*["'](https?:\/\/[^"']+|\/\/[^"']+)["']/g;
const importScriptsCall =
  /(?:^|[^.\w$])importScripts\s*\(\s*["'](https?:\/\/[^"']+|\/\/[^"']+)["']/g;

for (const path of sources) {
  const file = rel(path);
  const text = readFileSync(path, "utf8");

  if (file.endsWith(".html")) {
    for (const match of text.matchAll(/<script\b([^>]*)>/gi)) {
      const src = attr(match[1], "src");
      if (!src || !isRemote(src)) continue;
      const integrity = attr(match[1], "integrity");
      const line = lineOf(text, match.index);
      if (!sha384AttributeOk(integrity) || !hasCrossorigin(match[1])) {
        fail(
          `${file}:${line} remote script ${src} needs integrity="sha384-..." and crossorigin`,
        );
      }
    }

    for (const match of text.matchAll(/<link\b([^>]*)>/gi)) {
      const relValue = attr(match[1], "rel") || "";
      const asValue = (attr(match[1], "as") || "").toLowerCase();
      const href = attr(match[1], "href");
      const loadsScript =
        /\bmodulepreload\b/i.test(relValue) ||
        (/\bpreload\b/i.test(relValue) && asValue === "script");
      if (!loadsScript || !href || !isRemote(href)) continue;
      const integrity = attr(match[1], "integrity");
      const line = lineOf(text, match.index);
      if (!sha384AttributeOk(integrity) || !hasCrossorigin(match[1])) {
        fail(
          `${file}:${line} remote script preload ${href} needs integrity="sha384-..." and crossorigin`,
        );
      }
    }
  }

  for (const pattern of [importSpecifier, dynamicImport, importScriptsCall]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const url = match[1];
      fail(
        `${file}:${lineOf(text, match.index)} remote module import ${url} cannot carry SRI; vendor it`,
      );
    }
  }
}

assert.deepEqual(problems, [], problems.join("\n"));
console.log(
  `Script integrity checks passed (${listed.size} vendored files, ${sources.length} HTML/JS sources).`,
);
