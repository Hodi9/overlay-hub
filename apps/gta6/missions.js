// GTA VI story missions: 91 across five chapters. Taken from the review-copy lists PC Gamer and GameSpot
// published on 18 Nov 2026, the day before launch (both list the same 91 names; the order follows PC Gamer's
// numbered list; GameSpot swaps a few neighbours in chapter 1). Rockstar has not published a list itself.
// Three missions are hidden by both sources to avoid spoilers; they are "[Spoiler]" here and can be renamed
// in the control panel. "day" is the mission name, "location" the chapter.
const CHAPTERS = [
  ["Chapter 1: Just Like Paradise", [
    "Prologue", "Gone Fishing", "Gear Up", "Just a Scratch", "Lab Fees", "Unwanted Attention", "Pipework",
    "Hey Arnold!", "Island Dreams", "Feng Shui", "Coming Home", "Buck Me", "Clean Up After Donnie",
    "Down to Earth", "Clear Skies", "Day Release", "Swamped", "[Spoiler]", "Recalibration", "Tourist Trap",
    "Home Sweet Home", "Discharge Time"
  ]],
  ["Chapter 2: Paradise Lost", [
    "What's in the Bag?", "Ambulance Chaser", "Just Moved In", "Girls' Trip", "Moses", "Daily Driver",
    "Slam Dunk", "Breakfast Run", "Coffee Break", "Afternoon Delight", "Checking Out"
  ]],
  ["Chapter 3: Tits Ass Drug Money", [
    "Welcome to Vice City", "Dealer's Choice", "Meet the Heders", "Dubious Provenance", "Mami Knows Best",
    "South Leonida Real Estate", "Tyrone", "Here, Kitty Kitty", "Car Services", "Top Billing", "Boobie Time",
    "First Impressions", "Caught Slipping", "Crosstown Traffic", "Credit Check", "Steal the Zorrusso for Randy",
    "Sinfrontera National Bank", "Security Expert", "Ride or Die", "Company Property", "The Missing Link",
    "Safe Word", "Cooties", "Bricked Up", "Hidden Charges", "The Cartel Heist"
  ]],
  ["Chapter 4: Vice City, Baby", [
    "Ocean Beach", "Another Life", "Company Cars", "Lawyer Up", "Party Hard", "Heavy Lifting", "Photo/Shoot",
    "Making Gainz", "Watch It", "Cash Injections", "Amateur Hour", "Dirty Work", "Too Much Baggage",
    "Adventures in Babysitting", "Fresh Evidence", "Power Play", "Child's Play", "Headliners",
    "Close Surveillance", "Delivery Method", "Team Building", "Fully Catered", "VCIA Takedown", "Sunset",
    "[Spoiler]"
  ]],
  ["Chapter 5: Top of the World, Ma", [
    "Bird in the Hand", "Taking Liberties", "VC Baby", "Doggie Bag", "Operation Savage Glory",
    "Protective Custody", "[Spoiler]"
  ]]
];

export const DEFAULT_MISSIONS = CHAPTERS.flatMap(([location, names]) => names.map((day) => ({ day, location })));

// The pre-launch placeholder list was "Mission 1".."Mission 100" in "Chapter 1".."Chapter 5". A saved list that
// still looks like that is replaced by the real one (progress on placeholders meant nothing).
export function isPlaceholderList(chapters) {
  return Array.isArray(chapters) && chapters.length > 0 &&
    chapters.every((c) => /^Mission \d+$/.test(String(c?.day || "")) && /^Chapter \d+$/.test(String(c?.location || "")));
}
