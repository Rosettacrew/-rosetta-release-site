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

console.log("Publish helper checks passed.");
