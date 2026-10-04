// Default mission list, in canonical main-story play order (Ludendorff
// prologue through the ending), cross-checked against the GTA Wiki and
// gtabase.com mission lists. `character` is the mission's primary playable
// protagonist for the control panel's colour tag; missions that are genuinely
// played across multiple characters at once (most heists, a few story beats)
// are tagged null. Heist-approach variants of the finale itself (e.g. Loud vs
// Smart) are collapsed to one row each.
//
// `optional: true` rows are heist preparation missions and optional family
// missions. Which preps you play depends on the approach you pick (and the
// sources disagree on the exact mapping), so they are listed and auto-matched
// from your save but are NOT counted in the progress percentage — otherwise
// the story could never reach 100% for whichever approach you didn't choose.
//
// Use the "Tilføj som ny mission" button in the control panel to insert
// anything this list is still missing (Strangers & Freaks, Lester's other
// assassinations, Dr. Friedlander sessions) as you actually hit it — that
// guarantees the text matches your save exactly.
export const DEFAULT_MISSIONS = [
  { name: "Prologue", character: null },
  { name: "Franklin and Lamar", character: "franklin" },
  { name: "Repossession", character: "franklin" },
  { name: "Complications", character: "franklin" },
  { name: "Father/Son", character: "michael" },
  { name: "Marriage Counseling", character: "michael" },
  { name: "Daddy's Little Girl", character: "michael" },
  { name: "Chop", character: "franklin" },
  { name: "The Long Stretch", character: "franklin" },
  { name: "Friend Request", character: "michael" },
  { name: "The Good Husband", character: "michael" },
  { name: "Casing the Jewel Store", character: "michael" },
  { name: "Carbine Rifles", character: null, optional: true },
  { name: "Bugstars Equipment", character: null, optional: true },
  { name: "BZ Gas Grenades", character: null, optional: true },
  { name: "The Jewel Store Job", character: null },
  { name: "Mr. Philips", character: "trevor" },
  { name: "Nervous Ron", character: "trevor" },
  { name: "Trevor Philips Industries", character: "trevor" },
  { name: "Crystal Maze", character: "trevor" },
  { name: "Friends Reunited", character: "trevor" },
  { name: "Fame or Shame", character: "michael" },
  { name: "Dead Man Walking", character: "michael" },
  { name: "Three's Company", character: null },
  { name: "By the Book", character: "trevor" },
  { name: "Scouting the Port", character: "trevor" },
  { name: "Minisub", character: null, optional: true },
  { name: "Cargobob", character: null, optional: true },
  { name: "The Merryweather Heist", character: null },
  { name: "Did Somebody Say Yoga?", character: "michael" },
  { name: "Hood Safari", character: "franklin" },
  { name: "The Hotel Assassination", character: "franklin" },
  { name: "Boiler Suits", character: null, optional: true },
  { name: "Masks", character: null, optional: true },
  { name: "Trash Truck", character: null, optional: true },
  { name: "Tow Truck", character: null, optional: true },
  { name: "Blitz Play", character: null },
  { name: "I Fought the Law...", character: null },
  { name: "Eye in the Sky", character: "trevor" },
  { name: "Mr. Richards", character: "michael" },
  { name: "Caida Libre", character: "michael" },
  { name: "Deep Inside", character: "franklin" },
  { name: "Minor Turbulence", character: "trevor" },
  { name: "Paleto Score Setup", character: "trevor" },
  { name: "Predator", character: null },
  { name: "Military Hardware", character: null },
  { name: "The Paleto Score", character: null },
  { name: "Derailed", character: "trevor" },
  { name: "Monkey Business", character: null },
  { name: "Hang Ten", character: "trevor" },
  { name: "Surveying the Score", character: null },
  { name: "Bury the Hatchet", character: "michael" },
  { name: "Pack Man", character: "franklin" },
  { name: "Fresh Meat", character: "franklin" },
  { name: "Cleaning out the Bureau", character: "michael" },
  { name: "Architect's Plans", character: "franklin" },
  { name: "Fire Truck", character: null, optional: true },
  { name: "The Bureau Raid", character: null },
  { name: "Reuniting the Family", character: "michael" },
  { name: "Doting Dad", character: "michael", optional: true },
  { name: "The Wrap Up", character: "michael" },
  { name: "Lamar Down", character: "franklin" },
  { name: "The Ballad of Rocco", character: "michael" },
  { name: "Legal Trouble", character: "michael" },
  { name: "Meltdown", character: "michael" },
  { name: "Parenting 101", character: "michael", optional: true },
  { name: "Planning the Big Score", character: null },
  { name: "Stingers", character: null, optional: true },
  { name: "Sidetracked", character: null, optional: true },
  { name: "Gauntlet", character: null, optional: true },
  { name: "Driller", character: null, optional: true },
  { name: "The Big Score", character: null },
  { name: "Ending", character: null }
];
