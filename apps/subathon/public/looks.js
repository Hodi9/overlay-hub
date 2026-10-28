// Overlayets farvetemaer. Deles af overlay, panel og server (validering), som Marcel Walks temaer.
// Første tema er standard. a1 og a2 er de to accentfarver (tal, bjælke, markeringer), tint og base er
// kortenes to bundfarver som "r, g, b", line er kantens farve, ink/muted er tekstfarverne, og on er teksten
// oven på en accentfarve (fx når et mål er nået).
export const LOOKS = [
  { key: "dg", name: "Dreamglow", a1: "#c9f36b", a2: "#72c99b", tint: "25, 41, 35", base: "8, 11, 10", line: "114, 201, 155", ink: "#f3f5f1", muted: "#aab4ae", on: "#0b0b0d" },
  { key: "nu", name: "Lilla glas", a1: "#c7b6ff", a2: "#ff9ac4", tint: "42, 34, 64", base: "17, 13, 25", line: "199, 182, 255", ink: "#fff8ec", muted: "#b3a9c9", on: "#17131f" },
  { key: "nl", name: "Nordlys", a1: "#5cf2b5", a2: "#4aa8ff", tint: "9, 38, 56", base: "6, 16, 30", line: "92, 242, 181", ink: "#eafff7", muted: "#86b4ad", on: "#04201a" },
  { key: "bp", name: "Blåtryk", a1: "#ffffff", a2: "#ffd23f", tint: "16, 74, 132", base: "10, 52, 99", line: "255, 255, 255", ink: "#ffffff", muted: "#a6c8ea", on: "#0a3463" },
  { key: "ef", name: "Efterårsskov", a1: "#f0b45a", a2: "#e8643a", tint: "44, 58, 35", base: "20, 28, 19", line: "240, 180, 90", ink: "#fbf1dc", muted: "#b7ae8c", on: "#0e130d" },
  { key: "sl", name: "Slåen", a1: "#d8a3ae", a2: "#e58b9b", tint: "54, 38, 53", base: "25, 17, 26", line: "216, 163, 174", ink: "#f6e9ee", muted: "#ae98a6", on: "#110b12" },
  { key: "tg", name: "Tågeskov", a1: "#cdb98a", a2: "#e2b36a", tint: "40, 55, 63", base: "18, 27, 32", line: "205, 185, 138", ink: "#eaeee9", muted: "#9db0b0", on: "#0c1216" },
  { key: "bi", name: "Birk", a1: "#aec3a0", a2: "#d9c47a", tint: "48, 52, 47", base: "21, 23, 20", line: "174, 195, 160", ink: "#eef0e6", muted: "#a3a999", on: "#0e100e" },
  { key: "gs", name: "Granskov", a1: "#d29a69", a2: "#e4a56e", tint: "29, 58, 53", base: "12, 26, 24", line: "210, 154, 105", ink: "#e9f0ea", muted: "#9db5ad", on: "#081210" },
  { key: "mg", name: "Hvid på grå", a1: "#ffffff", a2: "#cfd4dc", tint: "38, 41, 50", base: "26, 28, 36", line: "255, 255, 255", ink: "#ffffff", muted: "#dfe2e8", on: "#111318" }
];

export const DEFAULT_LOOK = LOOKS[0].key;

// Hvor dækkende kortene er (1 = helt massive). Panelet viser det som gennemsigtighed.
export const OPACITY_MIN = 0.2;
export const OPACITY_MAX = 1;
export const DEFAULT_OPACITY = 0.66;

export const lookByKey = (key) => LOOKS.find((look) => look.key === key) || LOOKS[0];
