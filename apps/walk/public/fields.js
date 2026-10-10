// Hvilke data hver overlay kan vise/skjule fra kontrolpanelet. Deles af overlay,
// panel og server (validering). Alle felter er tændt som standard.
export const DEFAULT_TITLE = "Rosenholm → Gavnø";
export const TITLE_MAX = 40;

export const VARIANT_NAMES = { 1: "Bundbar", 2: "Hjørnekort", 3: "Kort", 4: "Tidslinje", 5: "Verdenskort" };
export const SCALE_MIN = 0.3;
export const SCALE_MAX = 1.5;

export const FIELDS = {
  1: [["badge", "Dag-mærke (Dag 5/14)"], ["via", "Via-by / tog"], ["todayKm", "Km gået i dag"], ["stay", "Overnatning"], ["todayBar", "Dagens fremdriftsbar"], ["total", "Km i alt"], ["left", "Km til Gavnø"], ["pace", "Ø-tempo"], ["time", "Gå-tid"], ["pause", "Pause-mærke"], ["trail", "Etape-striben nederst"]],
  2: [["title", "Titel øverst"], ["badge", "Dag-mærke"], ["via", "Via-by / tog"], ["todayBar", "Dagens fremdriftsbar"], ["todayKm", "Km i dag"], ["total", "Km i alt"], ["left", "Km tilbage"], ["pace", "Ø-tempo"], ["time", "Gå-tid"], ["pause", "Pause-mærke"], ["stay", "Overnatning"]],
  3: [["badge", "Dag-mærke"], ["labels", "Bynavne på kortet"], ["todayKm", "Km i dag"], ["total", "Km i alt"], ["left", "Km tilbage"], ["pace", "Ø-tempo"], ["pause", "Pause-mærke"]],
  4: [["title", "Titel øverst"], ["date", "Dag og dato"], ["kms", "Km pr. etape"], ["pace", "Ø-tempo"], ["pause", "Pause-mærke"], ["total", "Samlet fremdrift"]],
  5: [["world", "Verdenskort"], ["labels", "Bynavne på kortet"], ["title", "Titel"], ["badge", "Dag-mærke"], ["via", "Via-by / tog"], ["todayKm", "Km gået i dag + bar"], ["total", "Km i alt"], ["left", "Km tilbage"], ["next", "Næste dags etape"], ["pace", "Ø-tempo"], ["time", "Gå-tid"], ["pause", "Pause-mærke"], ["stay", "Overnatning"]]
};

export const isField = (variant, key) => (FIELDS[variant] || []).some(([k]) => k === key);
