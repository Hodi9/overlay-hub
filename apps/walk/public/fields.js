// Hvilke data hver overlay kan vise/skjule fra kontrolpanelet. Deles af overlay,
// panel og server (validering). Alle felter er tændt som standard.
export const DEFAULT_TITLE = "Rosenholm → Gavnø";
export const TITLE_MAX = 40;

export const VARIANT_NAMES = { 1: "Bundbar", 2: "Hjørnekort", 3: "Kort", 4: "Tidslinje" };

export const FIELDS = {
  1: [["badge", "Dag-mærke (Dag 5/14)"], ["via", "Via-by / tog"], ["todayKm", "Km gået i dag"], ["stay", "Overnatning"], ["todayBar", "Dagens fremdriftsbar"], ["total", "Km i alt"], ["left", "Km til Gavnø"], ["trail", "Etape-striben nederst"]],
  2: [["title", "Titel øverst"], ["badge", "Dag-mærke"], ["via", "Via-by / tog"], ["todayKm", "Km gået i dag"], ["todayBar", "Dagens fremdriftsbar"], ["total", "Km i alt"], ["stay", "Overnatning"]],
  3: [["badge", "Dag-mærke"], ["labels", "Bynavne på kortet"], ["todayKm", "Km i dag"], ["total", "Km i alt"], ["left", "Km tilbage"]],
  4: [["title", "Titel øverst"], ["date", "Dag og dato"], ["kms", "Km pr. etape"], ["total", "Samlet fremdrift"]]
};

export const isField = (variant, key) => (FIELDS[variant] || []).some(([k]) => k === key);
