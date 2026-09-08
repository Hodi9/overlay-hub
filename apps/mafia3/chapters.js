// Mafia III doesn't have a simple linear chapter sequence like the other
// two games — its own wiki describes story progress as district-based:
// you choose which of New Bordeaux's districts to take over and in what
// order, each with its own 2-3 mission arc, plus optional/betrayal
// chapters that depend on player choices. So there's no single "correct"
// chapter order to seed here. These two names are verified real mission
// titles (checked against mafiagame.fandom.com's mission list — the
// original seed here had a mission name from a different Mafia game
// entirely, an easy mistake without checking), commonly cited as early
// missions, but your actual order will very likely differ. Lean on
// "+ Tilføj som næste kapitel" in the control panel — for this game more
// than the other two, that's the real source of truth, not this list.
export const DEFAULT_CHAPTERS = [
  { day: "The Dead Stay Gone", location: "" },
  { day: "Sit Down", location: "" }
];
