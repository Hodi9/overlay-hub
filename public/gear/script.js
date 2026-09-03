const DISPLAY_TIME = 7000, TRANSITION_TIME = 650, BETWEEN_PRODUCTS = 450, CYCLE_INTERVAL = 15 * 60 * 1000;

const scaleWrap = document.querySelector("#scale-wrap");
const card = document.querySelector("#product-card");
const image = document.querySelector("#product-image");
const brand = document.querySelector("#product-brand");
const name = document.querySelector("#product-name");
const price = document.querySelector("#product-price");
const before = document.querySelector("#product-before");
const command = document.querySelector("#product-command");
const outroText = document.querySelector("#outro-text");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchProducts() {
  try {
    const res = await fetch("/gear/api/products");
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

async function fetchConfig() {
  try {
    const res = await fetch("/gear/api/config");
    if (!res.ok) return { outroEnabled: false, outroText: "" };
    return await res.json();
  } catch {
    return { outroEnabled: false, outroText: "" };
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

async function applyScale() {
  const config = await fetchConfig();
  if (config.overlayScale) {
    scaleWrap.style.setProperty("--scale", config.overlayScale);
  }
}

async function runOverlay() {
  while (true) {
    const cycleStarted = Date.now();
    await playSequence();
    await wait(Math.max(0, CYCLE_INTERVAL - (Date.now() - cycleStarted)));
  }
}

applyScale();
setInterval(applyScale, 4000);
runOverlay();
