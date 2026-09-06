import assert from "node:assert/strict";

function activeCheckoutPrice(product) {
  const raw =
    product?.status === "presale" && product?.presale_price_cents != null
      ? product.presale_price_cents
      : (product?.release_price_cents ?? product?.presale_price_cents);
  const cents = Math.round(Number(raw));
  return Number.isFinite(cents) && cents > 0 ? cents : null;
}

function readableText(value) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return !text || text === "[object Object]" ? "" : text;
}

function formatErrorMessage(error, fallback = "Request failed") {
  if (error == null) return fallback;
  const direct = readableText(error);
  if (direct) return direct;
  if (typeof error !== "object") {
    const text = readableText(String(error));
    return text || fallback;
  }
  const nested = [error.message, error.error, error.msg, error.details, error.hint]
    .map((value) =>
      value && typeof value === "object"
        ? formatErrorMessage(value, "")
        : readableText(value),
    )
    .filter(Boolean);
  const unique = [...new Set(nested)];
  if (unique.length) {
    const code = readableText(error.code);
    const body = unique.join(" — ");
    return code && !body.includes(code) ? `${body} (${code})` : body;
  }
  try {
    const dumped = JSON.stringify(error);
    if (dumped && dumped !== "{}" && dumped !== "null") return dumped.slice(0, 280);
  } catch {
    /* ignore circular objects */
  }
  return readableText(String(error)) || fallback;
}

function artworkReadyForStorefront(product) {
  const path = String(product?.cover_art_path ?? "").trim();
  const bucket = String(product?.cover_art_bucket ?? "").trim() || "release-public";
  return !!path && bucket === "release-public" && /\.(jpe?g|png|webp)$/i.test(path);
}

// Mirrors public.release_artwork_ready_for_storefront (LIKE suffixes, not ~*).
function sqlArtworkReadyForStorefront(path, bucket) {
  const trimmedPath = String(path ?? "").trim();
  const trimmedBucket = String(bucket ?? "").trim() || "release-public";
  const lower = trimmedPath.toLowerCase();
  return (
    trimmedPath !== "" &&
    trimmedBucket === "release-public" &&
    (lower.endsWith(".jpg") ||
      lower.endsWith(".jpeg") ||
      lower.endsWith(".png") ||
      lower.endsWith(".webp"))
  );
}

function storefrontError(error) {
  const text = formatErrorMessage(error, "Storefront update failed.");
  const lower = text.toLowerCase();
  if (lower.includes("invalid input syntax for type uuid")) {
    return "Stripe Payment Link ids cannot be stored on this column type. Apply supabase/migrations/20260905_storefront_publish_followup.sql (converts stripe_payment_link_id to text). Come Here / EP rows are not rewritten.";
  }
  if (/\b23514\b/.test(text) || lower.includes("check constraint")) {
    if (lower.includes("product_type") || lower.includes("digital_product")) {
      return "This product type is blocked by a database check. Apply supabase/migrations/20260905_storefront_publish_followup.sql so digital_product can go live. Come Here / EP are not changed.";
    }
    return `${text} If this mentions product_type or storefront_enabled, apply supabase/migrations/20260905_storefront_publish_followup.sql.`;
  }
  if (/\bp0001\b/.test(lower) || lower.includes("artwork must pass validation")) {
    return "Publish blocked: artwork must pass validation before release. Upload a 3000 × 3000 JPG, PNG, or WebP cover to release-public and save it so cover_art_path is set, then try Storefront On again.";
  }
  return text;
}

function nextStorefrontStatus(product) {
  if (product?.status === "presale" || product?.status === "live")
    return product.status;
  const releaseAt = new Date(product?.release_at).getTime();
  if (
    !Number.isNaN(releaseAt) &&
    releaseAt > Date.now() &&
    product?.presale_price_cents != null
  ) {
    return "presale";
  }
  return "live";
}

const draftDigital = {
  product_type: "digital_product",
  status: "draft",
  release_price_cents: 199,
  presale_price_cents: 99,
  release_at: "2020-01-01T00:00:00.000Z",
};

assert.equal(activeCheckoutPrice(draftDigital), 199);
assert.equal(nextStorefrontStatus(draftDigital), "live");

assert.equal(
  activeCheckoutPrice({
    status: "presale",
    presale_price_cents: 150,
    release_price_cents: 300,
  }),
  150,
);

assert.equal(activeCheckoutPrice({ status: "draft" }), null);
assert.equal(activeCheckoutPrice({ status: "draft", release_price_cents: 0 }), null);
assert.equal(
  activeCheckoutPrice({ status: "draft", release_price_cents: "249" }),
  249,
);

assert.equal(
  nextStorefrontStatus({
    status: "draft",
    presale_price_cents: 99,
    release_at: new Date(Date.now() + 86400000).toISOString(),
  }),
  "presale",
);

assert.equal(
  nextStorefrontStatus({ status: "archived", release_at: "2020-01-01T00:00:00.000Z" }),
  "live",
);
assert.equal(nextStorefrontStatus({ status: "live" }), "live");
assert.equal(nextStorefrontStatus({ status: "presale" }), "presale");

assert.equal(
  formatErrorMessage({
    message: "new row violates check constraint release_products_product_type_check",
    code: "23514",
    details: "Failing row contains digital_product",
  }),
  "new row violates check constraint release_products_product_type_check — Failing row contains digital_product (23514)",
);
assert.equal(formatErrorMessage("[object Object]"), "Request failed");
assert.equal(formatErrorMessage({}), "Request failed");
assert.equal(
  formatErrorMessage({ error: { message: "No such price" } }),
  "No such price",
);
assert.equal(formatErrorMessage(new Error("Stripe prices failed")), "Stripe prices failed");
assert.doesNotMatch(formatErrorMessage({ code: "22P02", message: "invalid input syntax for type uuid: \"plink_123\"" }), /\[object Object\]/);
assert.match(
  storefrontError({
    message: 'invalid input syntax for type uuid: "plink_123"',
    code: "22P02",
  }),
  /stripe_payment_link_id to text/,
);
assert.match(
  storefrontError({
    message: 'new row for relation "release_products" violates check constraint "release_products_product_type_check"',
    code: "23514",
  }),
  /digital_product can go live/,
);
assert.match(
  storefrontError({
    message: "Publish blocked: artwork must pass validation before release.",
    code: "P0001",
  }),
  /cover_art_path is set/,
);

const sandboxCover = {
  product_type: "digital_product",
  cover_art_path:
    "11111111-1111-1111-1111-111111111111/cover/cover-aaaa-bbbb.jpeg",
  cover_art_bucket: "release-public",
};
assert.equal(artworkReadyForStorefront(sandboxCover), true);
assert.equal(
  artworkReadyForStorefront({
    ...sandboxCover,
    cover_art_path: null,
  }),
  false,
);
assert.equal(
  artworkReadyForStorefront({
    ...sandboxCover,
    cover_art_bucket: "release-private",
  }),
  false,
);
assert.equal(
  artworkReadyForStorefront({
    ...sandboxCover,
    cover_art_path: "11111111-1111-1111-1111-111111111111/cover/cover.bin",
  }),
  false,
);
assert.equal(
  artworkReadyForStorefront({
    cover_art_path: sandboxCover.cover_art_path,
    cover_art_bucket: null,
  }),
  true,
);

const sandboxPngPath =
  "42e87b92-353b-479f-8b95-0d56799bd6e5/cover/cover-85e71111-eaa5-43a9-99d9-78acb0106cd9.png";
assert.equal(sqlArtworkReadyForStorefront(sandboxPngPath, "release-public"), true);
assert.equal(sqlArtworkReadyForStorefront(`  ${sandboxPngPath}  `, ""), true);
assert.equal(sqlArtworkReadyForStorefront(sandboxPngPath, null), true);
assert.equal(sqlArtworkReadyForStorefront(sandboxPngPath, "release-private"), false);
assert.equal(sqlArtworkReadyForStorefront(null, "release-public"), false);
assert.equal(
  sqlArtworkReadyForStorefront(
    "42e87b92-353b-479f-8b95-0d56799bd6e5/cover/cover.bin",
    "release-public",
  ),
  false,
);
assert.equal(artworkReadyForStorefront({
  cover_art_path: sandboxPngPath,
  cover_art_bucket: "release-public",
}), true);

console.log("Publish helper checks passed.");
