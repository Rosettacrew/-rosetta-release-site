import assert from "node:assert/strict";

function activeCheckoutPrice(product) {
  const raw =
    product?.status === "presale" && product?.presale_price_cents != null
      ? product.presale_price_cents
      : (product?.release_price_cents ?? product?.presale_price_cents);
  const cents = Math.round(Number(raw));
  return Number.isFinite(cents) && cents > 0 ? cents : null;
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

console.log("Publish helper checks passed.");
