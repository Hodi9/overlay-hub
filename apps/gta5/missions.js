// Default mission list, in story order. This is a short, deliberately
// conservative starter list (only the early-game missions this was written
// with real confidence about, plus a couple confirmed against actual save
// file headers) — GTA V has ~69 main story missions with some
// player-dependent branching (heist approaches etc.), too many to safely
// recall from memory in exact order/wording. Use the "Tilføj som næste"
// button in the control panel to extend it from the tracker's own live
// capture as you play — that guarantees the text matches your save exactly.
export const DEFAULT_MISSIONS = [
  { name: "Prologue", character: null },
  { name: "Franklin and Lamar", character: "franklin" },
  { name: "Repossession", character: "franklin" },
  { name: "Complications", character: "michael" },
  { name: "Friend Request", character: "franklin" },
  { name: "The Long Stretch", character: null },
  { name: "Marriage Counseling", character: "michael" },
  { name: "Father/Son", character: "michael" },
  { name: "Chop", character: "franklin" },
  { name: "Casing the Jewel Store", character: "michael" },
  { name: "Hood Safari", character: "franklin" },
  { name: "The Jewel Store Job", character: "michael" },
  { name: "Daddy's Little Girl", character: "franklin" },
  { name: "Nervous Ron", character: "trevor" },
  { name: "Mr. Philips", character: "trevor" },
  { name: "Trevor Philips Industries", character: null },
  { name: "Grass Roots", character: "michael" }
];
