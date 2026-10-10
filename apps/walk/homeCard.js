// "Marcel Walk"-kortet til forsiden. Ligger bevidst IKKE i public/index.html:
// serveren indsætter det kun når WALK_SHOW_ON_HOME=1, så en skjult blok aldrig
// kan ses via "vis kilde". Uden flaget er forsiden byte-for-byte uændret.
const ICON = '<path d="M13 4.5a1.8 1.8 0 1 1-3.6 0 1.8 1.8 0 0 1 3.6 0z"/><path d="M11 7.5l-2 4 3 2.5-1 6M11 7.5l3 3 3 .5M9 11.5l-3 2"/>';

export function walkEntry(base) {
  return {
    id: "marcelwalk", cat: "show", tag: "Event", title: "Marcel Walk", sub: "Walk-overlays samlet — live km, kort og tidslinje, Danmark på verdenskort",
    links: [
      ["Overlay (følger panelet)", `${base}/overlay.html`],
      ["Bundbar", `${base}/overlay.html?v=1`],
      ["Hjørnekort", `${base}/overlay.html?v=2`],
      ["Kort", `${base}/overlay.html?v=3`],
      ["Tidslinje", `${base}/overlay.html?v=4`],
      ["Verdenskort", `${base}/overlay.html?v=5`]
    ],
    control: `${base}/control.html`,
    extra: [["Alle varianter", `${base}/`]],
    info: "Det første link følger det, du vælger i kontrolpanelet (udseende, km, dag, vis/skjul). De andre er låst til én variant."
  };
}

export function injectHomeCard(html, base) {
  const entry = JSON.stringify(walkEntry(base)).replace(/</g, "\\u003c");
  const a = "const OVERLAYS = [";
  const b = "const ICON_COPY =";
  if (!html.includes(a) || !html.includes(b)) return html;
  return html
    .replace(a, () => `${a}\n  ${entry},`)
    .replace(b, () => `ICONS.marcelwalk = svg('${ICON}');\n${b}`);
}
