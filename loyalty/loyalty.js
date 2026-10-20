const FN_BASE = "https://sktgkrcahsxvidzjjxxt.supabase.co/functions/v1";
const API = FN_BASE + "/release-storefront";
const SUPPORT_API = FN_BASE + "/release-support-checkout";
const SUPPORT_MAX_CENTS = 1_000_000;
const SAMPLE_ORIGIN = "https://sktgkrcahsxvidzjjxxt.supabase.co";
const SLUGS = [
  "dj-loyalty-da-goat-love-pain-loyalty-ep",
  "dj-loyalty-da-goat-even-though",
];
const PINNED_CENTS = {
  "dj-loyalty-da-goat-love-pain-loyalty-ep": 799,
  "dj-loyalty-da-goat-even-though": 199,
};
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUsd(currency) {
  return String(currency ?? "").trim().toLowerCase() === "usd";
}
const money = (cents, currency) => {
  if (!isUsd(currency)) return "";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format((Number(cents) || 0) / 100);
};
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (m) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[m],
  );

function isStripeCheckout(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      ["buy.stripe.com", "checkout.stripe.com"].includes(url.hostname) &&
      !/^\/test(?:_|\/|$)/i.test(url.pathname)
    );
  } catch (_) {
    return false;
  }
}

function publicSampleUrl(release, trackNumber) {
  const id = String(release.id || "");
  const n = Number(trackNumber);
  if (!UUID_RE.test(id) || !Number.isInteger(n) || n < 1 || n > 30) return "";
  const nn = String(n).padStart(2, "0");
  const url = new URL(
    `/storage/v1/object/public/release-public/${id}/samples/${nn}-sample.mp3`,
    SAMPLE_ORIGIN,
  );
  return url.origin === SAMPLE_ORIGIN ? url.toString() : "";
}

function publicCoverUrl(value, releaseId) {
  const id = String(releaseId || "");
  if (!UUID_RE.test(id)) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.origin !== SAMPLE_ORIGIN) return "";
    if (url.username || url.password || url.search || url.hash) return "";
    const prefix = `/storage/v1/object/public/release-public/${id}/cover/`;
    if (!url.pathname.startsWith(prefix)) return "";
    const name = url.pathname.slice(prefix.length);
    if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) return "";
    if (!/^[A-Za-z0-9._-]+\.(jpe?g|png|webp)$/i.test(name)) return "";
    return url.toString();
  } catch (_) {
    return "";
  }
}

function supportPresets(floor) {
  const f = Number(floor) || 0;
  if (f === 499) return [499, 799, 999, 1499];
  return [f, f + 300, f + 500, f + 1000].filter((n) => n > 0);
}
function supportBlock(release) {
  if (!isUsd(release.currency)) return "";
  const floor = Number(release.price_cents) || 0;
  if (!(floor > 0)) return "";
  const presets = supportPresets(floor);
  const buttons = presets
    .map(
      (c, i) =>
        `<button type="button" class="support-preset${i === 0 ? " active" : ""}" data-cents="${c}">${money(c, release.currency)}</button>`,
    )
    .join("");
  return `<div class="support" data-support-product="${esc(release.id)}" data-floor="${floor}" data-currency="usd"><div class="support-label">SUPPORT THE ARTIST</div><div class="support-presets">${buttons}</div><div class="support-custom"><label>Custom $</label><input type="number" min="${(floor / 100).toFixed(2)}" max="${(SUPPORT_MAX_CENTS / 100).toFixed(2)}" step="0.01" inputmode="decimal" placeholder="${(floor / 100).toFixed(2)}" aria-label="Custom support amount in dollars" /><button type="button" class="support-go" data-support-go>Support</button></div><div class="support-hint">Minimum ${money(floor, release.currency)}. Maximum ${money(SUPPORT_MAX_CENTS, release.currency)}. Same digital release — pay what you can.</div><div class="support-error hidden" data-support-error></div></div>`;
}

function cleanTrackTitle(raw, trackNumber) {
  let t = String(raw || "").trim();
  if (!t) return `Track ${trackNumber}`;
  t = t.replace(/^\d{1,2}\s*[-.)]\s*/g, "");
  t = t.replace(/^Rosetta Crew Music\s*-\s*/i, "");
  t = t.replace(/^\d{1,2}\s*[.）)]\s*/g, "");
  t = t.replace(/\s+\d+$/g, "");
  t = t.replace(/^\d{1,2}\s*-\s*/g, "").trim();
  t = t.replace(/^\d{1,2}\.\s*/g, "").trim();
  return t || `Track ${trackNumber}`;
}
function releaseStatus(release) {
  if (release.status !== "presale") return "AVAILABLE NOW";
  if (!release.release_at) return "PRE-ORDER";
  const releaseDate = new Date(release.release_at);
  return Number.isNaN(releaseDate.getTime())
    ? "PRE-ORDER"
    : `PRE-ORDER · RELEASES ${releaseDate.toLocaleDateString()}`;
}
function releaseCard(release) {
  const artist = String(release.artist_name || "").trim();
  const title = String(release.title || "Release").trim();
  const price = money(release.price_cents, release.currency);
  const cover = publicCoverUrl(release.cover_url, release.id);
  if (!price || !cover) return "";
  const description =
    release.description ||
    "Own the official digital release and support the artist directly through Rosetta Crew Music Group.";
  const actionLabel = release.status === "presale" ? "PRE-ORDER" : "BUY NOW";
  const action = `<a class="buy" href="${esc(release.checkout_url)}" data-product="${esc(release.id)}" rel="noopener">${actionLabel} — ${price}</a>`;
  const artistType =
    release.artist_type === "ai" ? "ai" : release.artist_type === "actual" ? "actual" : null;
  const identity = artistType
    ? `<div class="artist-type">${artistType === "ai" ? "AI ARTIST" : "ACTUAL ARTIST"}</div>`
    : "";
  const booking =
    artistType === "actual"
      ? `<a class="booking-banner" href="tel:+16562424777"><strong>BOOK THIS ARTIST</strong><span>Contact Rosetta Crew for booking inquiries · 656-242-4777</span></a>`
      : "";
  const tracks = Array.isArray(release.tracks) ? release.tracks : [];
  const showTracks = release.show_tracklist !== false && tracks.length > 0;
  const tracklist = showTracks
    ? `<div class="tracklist"><div class="tracklist-label">${tracks.length > 1 ? `${tracks.length} songs on this release · tap to preview` : "Track on this release"}</div><ol>${tracks
        .map((t) => {
          const trackTitle = cleanTrackTitle(t.title, t.track_number);
          const nn = String(t.track_number).padStart(2, "0");
          const sampleUrl = publicSampleUrl(release, t.track_number);
          const play = sampleUrl
            ? `<button class="play" type="button" data-sample-url="${esc(sampleUrl)}" aria-label="Play sample: ${esc(trackTitle)}" aria-pressed="false">▶</button>`
            : "";
          return `<li><span class="num">${nn}</span><span class="name">${esc(trackTitle)}</span>${play}</li>`;
        })
        .join("")}</ol></div>`
    : "";
  return `<article class="release" id="${esc(release.slug)}" data-slug="${esc(release.slug)}"><div class="grid"><img class="cover" src="${esc(cover)}" alt="${esc(artist)} — ${esc(title)} cover art" width="800" height="800"><div class="meta"><small>ROSETTA CREW MUSIC GROUP PRESENTS</small><h2 class="title">${esc(title)}</h2><div class="artist">${esc(artist.toUpperCase())}</div>${identity}<div class="status">${esc(releaseStatus(release))}</div><div class="price">${price}</div>${action}<div class="trust"><span>✓ Secure Stripe checkout</span><span>✓ Direct-to-fan</span><span>✓ Digital delivery</span></div><p class="desc">${esc(description)}</p>${tracklist}${booking}<button class="share-release" type="button" data-release-slug="${esc(release.slug)}">Share</button>${supportBlock(release)}</div></div></article>`;
}

let shareToastTimer;
function showShareToast(message) {
  const toast = document.getElementById("share-toast");
  if (!toast) return;
  clearTimeout(shareToastTimer);
  toast.textContent = message;
  toast.classList.remove("hidden");
  shareToastTimer = setTimeout(() => toast.classList.add("hidden"), 2600);
}
async function copyShareUrl(url) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    await navigator.clipboard.writeText(url);
    return;
  }
  const input = document.createElement("textarea");
  input.value = url;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("copy failed");
}
async function shareRelease(release) {
  const slug = String(release.slug || "").trim();
  const url = new URL(location.origin + location.pathname);
  if (slug) url.searchParams.set("release", slug);
  url.searchParams.set("utm_source", "share");
  url.searchParams.set("utm_medium", "web");
  url.searchParams.set("utm_campaign", slug || String(release.id || "loyalty"));
  const title = String(release.title || "Release").trim();
  const artist = String(release.artist_name || "").trim();
  const shareData = {
    title,
    text: `${artist} — ${title}`,
    url: url.toString(),
  };
  if (navigator.share) {
    try {
      await navigator.share(shareData);
    } catch (error) {
      if (error && error.name !== "AbortError") showShareToast("Unable to share this link");
    }
    return;
  }
  try {
    await copyShareUrl(shareData.url);
    showShareToast("Link copied");
  } catch (_) {
    showShareToast("Could not copy the link");
  }
}

function wireSamples(root) {
  const sampleAudio = new Audio();
  sampleAudio.preload = "none";
  let playingButton = null;
  function resetSampleButton(button) {
    if (!button) return;
    button.textContent = "▶";
    button.setAttribute("aria-pressed", "false");
    const label = button.getAttribute("aria-label") || "Play sample";
    button.setAttribute("aria-label", label.replace(/^Pause sample:/, "Play sample:"));
  }
  function stopSample(button = playingButton) {
    sampleAudio.pause();
    sampleAudio.removeAttribute("src");
    sampleAudio.load();
    resetSampleButton(button);
    if (button === playingButton) playingButton = null;
  }
  sampleAudio.addEventListener("ended", () => stopSample());
  sampleAudio.addEventListener("timeupdate", () => {
    if (sampleAudio.currentTime >= 45) stopSample();
  });
  sampleAudio.addEventListener("error", () => {
    if (playingButton) playingButton.hidden = true;
    stopSample();
  });
  root.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target && target.closest("button.play[data-sample-url]");
    if (!button || !root.contains(button)) return;
    const sampleUrl = button.dataset.sampleUrl || "";
    let allowed = false;
    try {
      const url = new URL(sampleUrl);
      allowed =
        url.origin === SAMPLE_ORIGIN &&
        /^\/storage\/v1\/object\/public\/release-public\/[0-9a-f-]{36}\/samples\/\d{2}-sample\.mp3$/i.test(
          url.pathname,
        );
    } catch (_) {
      allowed = false;
    }
    if (!allowed) return;
    if (button === playingButton && !sampleAudio.paused) {
      sampleAudio.pause();
      button.textContent = "▶";
      button.setAttribute("aria-pressed", "false");
      const label = button.getAttribute("aria-label") || "Play sample";
      button.setAttribute("aria-label", label.replace(/^Pause sample:/, "Play sample:"));
      return;
    }
    if (playingButton && playingButton !== button) resetSampleButton(playingButton);
    sampleAudio.pause();
    sampleAudio.src = sampleUrl;
    sampleAudio.currentTime = 0;
    playingButton = button;
    button.textContent = "❚❚";
    button.setAttribute("aria-pressed", "true");
    const label = button.getAttribute("aria-label") || "Pause sample";
    button.setAttribute("aria-label", label.replace(/^Play sample:/, "Pause sample:"));
    sampleAudio.play().catch(() => {
      if (playingButton === button) {
        button.hidden = true;
        stopSample(button);
      }
    });
  });
}

async function startSupportCheckout(productId, amountCents, errorEl, goBtn) {
  if (errorEl) {
    errorEl.textContent = "";
    errorEl.classList.add("hidden");
  }
  if (goBtn) goBtn.disabled = true;
  try {
    const r = await fetch(SUPPORT_API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ product_id: productId, amount_cents: amountCents }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !isStripeCheckout(data.url)) {
      throw new Error(data.error || "Checkout unavailable");
    }
    location.href = data.url;
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = err instanceof Error ? err.message : String(err);
      errorEl.classList.remove("hidden");
    }
    if (goBtn) goBtn.disabled = false;
  }
}
function wireSupportUI(root) {
  root.addEventListener("click", (e) => {
    const preset = e.target.closest(".support-preset");
    if (preset) {
      const box = preset.closest(".support");
      if (!box) return;
      box.querySelectorAll(".support-preset").forEach((b) => b.classList.remove("active"));
      preset.classList.add("active");
      const input = box.querySelector("input");
      if (input) input.value = (Number(preset.dataset.cents) / 100).toFixed(2);
      return;
    }
    const go = e.target.closest("[data-support-go]");
    if (!go) return;
    const box = go.closest(".support");
    if (!box) return;
    if (!isUsd(box.dataset.currency)) return;
    const floor = Number(box.dataset.floor) || 0;
    const productId = box.dataset.supportProduct;
    const errorEl = box.querySelector("[data-support-error]");
    const input = box.querySelector("input");
    const active = box.querySelector(".support-preset.active");
    let cents;
    if (input && input.value.trim() !== "") {
      const dollars = Number(input.value);
      if (!Number.isFinite(dollars)) {
        if (errorEl) {
          errorEl.textContent = "Enter a valid amount";
          errorEl.classList.remove("hidden");
        }
        return;
      }
      cents = Math.round(dollars * 100);
    } else if (active) {
      cents = Number(active.dataset.cents);
    } else {
      cents = floor;
    }
    if (!Number.isInteger(cents) || cents < floor) {
      if (errorEl) {
        errorEl.textContent = "Minimum is " + money(floor, box.dataset.currency);
        errorEl.classList.remove("hidden");
      }
      return;
    }
    if (cents > SUPPORT_MAX_CENTS) {
      if (errorEl) {
        errorEl.textContent = "Maximum is " + money(SUPPORT_MAX_CENTS, box.dataset.currency);
        errorEl.classList.remove("hidden");
      }
      return;
    }
    if (!UUID_RE.test(String(productId || ""))) return;
    startSupportCheckout(productId, cents, errorEl, go);
  });
}

function showCheckoutToast() {
  const q = new URLSearchParams(location.search);
  const flag = q.get("checkout");
  if (flag !== "success" && flag !== "cancel") return;
  const el = document.getElementById("checkout-toast");
  if (!el) return;
  if (flag === "success") {
    el.innerHTML =
      "<strong>ORDER CONFIRMED</strong>Thanks — your order is recorded. Check the email you used at checkout.";
  } else {
    el.innerHTML =
      "<strong>CHECKOUT CANCELED</strong>No charge was made. You can buy from this page anytime.";
  }
  el.classList.remove("hidden");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Dismiss";
  btn.addEventListener("click", () => {
    el.classList.add("hidden");
    const url = new URL(location.href);
    url.searchParams.delete("checkout");
    url.searchParams.delete("session_id");
    history.replaceState({}, "", url.pathname + url.search + url.hash);
  });
  el.appendChild(btn);
}

function usableRelease(release) {
  if (!release) return false;
  const slug = String(release.slug || "");
  const pinnedCents = PINNED_CENTS[slug];
  if (!Number.isInteger(pinnedCents) || Number(release.price_cents) !== pinnedCents) return false;
  if (!isUsd(release.currency)) return false;
  if (!isStripeCheckout(release.checkout_url)) return false;
  return Boolean(publicCoverUrl(release.cover_url, release.id));
}

async function load() {
  const loading = document.getElementById("loading");
  const error = document.getElementById("error");
  try {
    const r = await fetch(API, { cache: "no-store" });
    if (!r.ok) throw new Error("storefront");
    const j = await r.json();
    const bySlug = new Map(
      (j.releases || []).filter(usableRelease).map((release) => [release.slug, release]),
    );
    const releases = SLUGS.map((slug) => bySlug.get(slug)).filter(Boolean);
    SLUGS.forEach((slug) => {
      const jump = document
        .querySelector(`[data-jump-price="${CSS.escape(slug)}"]`)
        ?.closest("a");
      if (jump) jump.hidden = !bySlug.has(slug);
    });
    loading.classList.add("hidden");
    if (!releases.length) {
      error.textContent = "These releases are not available right now.";
      error.classList.remove("hidden");
      return;
    }
    const root = document.getElementById("releases");
    root.innerHTML = releases.map(releaseCard).join("");
    releases.forEach((release) => {
      const priceEl = document.querySelector(
        `[data-jump-price="${CSS.escape(release.slug)}"]`,
      );
      if (priceEl) priceEl.textContent = money(release.price_cents, release.currency);
    });
    const catalog = new Map(releases.map((release) => [release.slug, release]));
    root.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const shareButton = target && target.closest("button.share-release[data-release-slug]");
      if (!shareButton || !root.contains(shareButton)) return;
      const release = catalog.get(shareButton.dataset.releaseSlug);
      if (release) shareRelease(release);
    });
    wireSamples(root);
    wireSupportUI(root);
    const params = new URLSearchParams(location.search);
    const focus = params.get("release") || location.hash.replace(/^#/, "");
    if (SLUGS.includes(focus)) {
      const card = document.getElementById(focus);
      if (card) card.scrollIntoView({ block: "start" });
    }
  } catch (_) {
    loading.classList.add("hidden");
    error.classList.remove("hidden");
  }
}

showCheckoutToast();
load();

