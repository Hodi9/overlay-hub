// Default main-job list for a Cyberpunk 2077 playthrough with Phantom Liberty
// (Ultimate Edition). `act` is the label the overlay shows; `part` is "base"
// or "phantom" and decides whether the job counts when the overlay is set to
// exclude Phantom Liberty (?pl=off).
//
// Cross-checked against RPG Site, Gamepressure and Attack of the Fanboy, which
// disagree on a few spots — treat this as a starter list, not a transcript:
//   - The Information / The Pickup: Gamepressure and RPG Site put The
//     Information first, Attack of the Fanboy the reverse.
//   - "The Gig" is a main job on RPG Site only, so it is left out.
//   - Act 2 is three parallel threads (Judy, Panam, Takemura) played in an
//     order you choose, and Phantom Liberty can be started during Act 2. The
//     list below is one sensible order — reorder it with the arrows in the
//     control panel to match your run.
//   - Act 3 and both Phantom Liberty endings branch on your choices, so the
//     list stops at the last shared job of each. Add your ending's jobs from
//     the control panel as you reach them.
// The lifepath opener differs per lifepath: "The Nomad", "The Street Kid" or
// "The Corpo-Rat" — edit the first row to match yours.
export const DEFAULT_QUESTS = [
  { name: "The Nomad", act: "Prologue", part: "base" },
  { name: "Practice Makes Perfect", act: "Prologue", part: "base" },
  { name: "The Rescue", act: "Prologue", part: "base" },

  { name: "The Ripperdoc", act: "Act 1", part: "base" },
  { name: "The Ride", act: "Act 1", part: "base" },
  { name: "The Information", act: "Act 1", part: "base" },
  { name: "The Pickup", act: "Act 1", part: "base" },
  { name: "The Heist", act: "Act 1", part: "base" },
  { name: "Love Like Fire", act: "Act 1", part: "base" },

  { name: "Playing for Time", act: "Act 2", part: "base" },
  { name: "Automatic Love", act: "Act 2", part: "base" },
  { name: "The Space in Between", act: "Act 2", part: "base" },
  { name: "Disasterpiece", act: "Act 2", part: "base" },
  { name: "Double Life", act: "Act 2", part: "base" },
  { name: "Ghost Town", act: "Act 2", part: "base" },
  { name: "Lightning Breaks", act: "Act 2", part: "base" },
  { name: "Life During Wartime", act: "Act 2", part: "base" },
  { name: "Down on the Street", act: "Act 2", part: "base" },
  { name: "Gimme Danger", act: "Act 2", part: "base" },
  { name: "Play It Safe", act: "Act 2", part: "base" },
  { name: "Search and Destroy", act: "Act 2", part: "base" },
  { name: "M'ap Tann Pèlen", act: "Act 2", part: "base" },
  { name: "I Walk the Line", act: "Act 2", part: "base" },
  { name: "Transmission", act: "Act 2", part: "base" },
  { name: "Never Fade Away", act: "Act 2", part: "base" },
  { name: "Tapeworm", act: "Act 2", part: "base" },

  { name: "Dog Eat Dog", act: "Dogtown", part: "phantom" },
  { name: "Hole in the Sky", act: "Dogtown", part: "phantom" },
  { name: "The Spider and the Fly", act: "Dogtown", part: "phantom" },
  { name: "Lucretia My Reflection", act: "Dogtown", part: "phantom" },
  { name: "The Damned", act: "Dogtown", part: "phantom" },
  { name: "Get It Together", act: "Dogtown", part: "phantom" },
  { name: "You Know My Name", act: "Dogtown", part: "phantom" },
  { name: "Birds with Broken Wings", act: "Dogtown", part: "phantom" },
  { name: "I've Seen That Face Before", act: "Dogtown", part: "phantom" },
  { name: "Firestarter", act: "Dogtown", part: "phantom" },

  { name: "Nocturne Op55N1", act: "Act 3", part: "base" }
];
