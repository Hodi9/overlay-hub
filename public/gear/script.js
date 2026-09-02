const products = [
  { brand:"CEPTER", name:"Cepter Titan Pro gaming tastatur", price:"1.298 kr.", before:"", command:"!keyboard", image:"assets/keyboard.jpg" },
  { brand:"LOGITECH", name:"Logitech G PRO X2 SUPERSTRIKE gaming mus", price:"1.399 kr.", before:"", command:"!mus", image:"assets/mouse.jpg" },
  { brand:"DJI", name:"DJI Osmo Pocket 3 Creator combo", price:"4.299 kr.", before:"", command:"!kamera", image:"assets/camera.jpg" },
  { brand:"SAMSUNG", name:"Samsung Odyssey OLED G6 27” QHD gamingskærm", price:"3.999 kr.", before:"6.999 kr.", command:"!skærm", image:"assets/monitor.jpg" },
];
const DISPLAY_TIME=7000, TRANSITION_TIME=650, BETWEEN_PRODUCTS=450, CYCLE_INTERVAL=15*60*1000;
const card=document.querySelector("#product-card"), image=document.querySelector("#product-image"), brand=document.querySelector("#product-brand"), name=document.querySelector("#product-name"), price=document.querySelector("#product-price"), before=document.querySelector("#product-before"), command=document.querySelector("#product-command");
const wait=(milliseconds)=>new Promise((resolve)=>setTimeout(resolve,milliseconds));
function setProduct(product){ image.src=product.image; image.alt=product.name; brand.textContent=product.brand; name.textContent=product.name; price.textContent=product.price; before.textContent=product.before; command.textContent=product.command; }
async function showProduct(product){ setProduct(product); card.className="product-card is-entering"; card.setAttribute("aria-hidden","false"); await wait(TRANSITION_TIME); card.className="product-card is-visible"; await wait(DISPLAY_TIME); card.className="product-card is-leaving"; await wait(TRANSITION_TIME); card.className="product-card"; card.setAttribute("aria-hidden","true"); await wait(BETWEEN_PRODUCTS); }
async function playSequence(){ for(const product of products) await showProduct(product); }
async function runOverlay(){ while(true){ const cycleStarted=Date.now(); await playSequence(); await wait(Math.max(0,CYCLE_INTERVAL-(Date.now()-cycleStarted))); } }
runOverlay();
