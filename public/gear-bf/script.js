const DISPLAY_TIME = 7000, TRANSITION_TIME = 650, BETWEEN_PRODUCTS = 450, CYCLE_INTERVAL = 15 * 60 * 1000;

const scaleWrap = document.querySelector("#scale-wrap");
const card = document.querySelector("#product-card");
const image = document.querySelector("#product-image");
const brand = document.querySelector("#product-brand");
const name = document.querySelector("#product-name");
const price = document.querySelector("#product-price");
const before = document.querySelector("#product-before");
const discountPill = document.querySelector("#discount-pill");
const command = document.querySelector("#product-command");
const outroText = document.querySelector("#outro-text");
const ribbon = document.querySelector("#ribbon span");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseKr(text) {
  const digits = String(text || "").replace(/[^\d]/g, "");
  return digits ? Number(digits) : null;
}

async function fetchProducts() {
  try {
    const res = await fetch("/gear-bf/api/products");
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

async function fetchConfig() {
  try {
    const res = await fetch("/gear-bf/api/config");
    if (!res.ok) return { outroEnabled: false, outroText: "", campaignLabel: "" };
    return await res.json();
  } catch {
    return { outroEnabled: false, outroText: "", campaignLabel: "" };
  }
}

function setProduct(product) {
  image.src = product.image;
  image.alt = product.name;
  brand.textContent = product.brand;
  name.textContent = product.name;
  price.textContent = product.price;
  before.textContent = product.before || "";
  command.textContent = product.command;

  const now = parseKr(product.price);
  const was = parseKr(product.before);
  if (now && was && was > now) {
    const pct = Math.round((1 - now / was) * 100);
    discountPill.textContent = "-" + pct + "%";
    discountPill.hidden = false;
  } else {
    discountPill.hidden = true;
  }
}

function setOutro(text) {
  outroText.textContent = text;
}

function setPhase(phase) {
  const outroClass = card.dataset.outro === "1" ? " is-outro" : "";
  card.className = phase ? `product-card ${phase}${outroClass}` : `product-card${outroClass}`;
}

async function showCard() {
  setPhase("is-entering");
  card.setAttribute("aria-hidden", "false");
  await wait(TRANSITION_TIME);
  setPhase("is-visible");
  await wait(DISPLAY_TIME);
  setPhase("is-leaving");
  await wait(TRANSITION_TIME);
  setPhase("");
  card.setAttribute("aria-hidden", "true");
  await wait(BETWEEN_PRODUCTS);
}

async function showProduct(product) {
  card.dataset.outro = "0";
  setProduct(product);
  await showCard();
}

async function showOutro(text) {
  card.dataset.outro = "1";
  setOutro(text);
  await showCard();
}

async function playSequence() {
  const [products, config] = await Promise.all([fetchProducts(), fetchConfig()]);
  for (const product of products) await showProduct(product);
  if (config.outroEnabled && config.outroText) await showOutro(config.outroText);
}

async function applyGlobalConfig() {
  const config = await fetchConfig();
  if (config.overlayScale) {
    scaleWrap.style.setProperty("--scale", config.overlayScale);
  }
  if (config.campaignLabel && ribbon) {
    ribbon.textContent = config.campaignLabel;
  }
}

async function runOverlay() {
  while (true) {
    const cycleStarted = Date.now();
    await playSequence();
    await wait(Math.max(0, CYCLE_INTERVAL - (Date.now() - cycleStarted)));
  }
}

applyGlobalConfig();
setInterval(applyGlobalConfig, 4000);
runOverlay();
