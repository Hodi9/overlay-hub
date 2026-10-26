// "Marcel Walk"-kortet til forsiden. Ligger bevidst IKKE i public/index.html:
// serveren indsætter det kun når WALK_SHOW_ON_HOME=1, så en skjult blok aldrig
// kan ses via "vis kilde". Uden flaget er forsiden byte-for-byte uændret.
export function walkEntry(base) {
  return {
    id: "marcelwalk", cat: "show", tag: "Event", title: "Marcel Walk", sub: "Walk-overlays samlet — live km, kort og tidslinje, Danmark på verdenskort",
    image: { src: "/img/marcelwalk.png", aspect: "904 / 703" },
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
  if (!html.includes(a)) return html;
  return html.replace(a, () => `${a}\n  ${entry},`);
}
