// The story missions in the order gamepressure.com's walkthrough plays them
// (prologue first, Kill Sal Marcano last). "day" is the mission name,
// "location" is the story chapter it belongs to on the Mafia Wiki
// (mafiagame.fandom.com/wiki/Missions_in_Mafia_III) — the prologue's nine
// missions are the sections of the wiki's "The Home Fires Burn" chapter.
// Capture text that matches either the mission or the chapter name counts.
//
// Mafia III lets you take New Bordeaux's districts in any order, so only the
// prologue and the finale are fixed; the middle follows the walkthrough. If
// your run goes a different way, jump with the control panel or use
// "+ Tilføj som næste kapitel". Left out on purpose: the DLC campaigns
// (Faster, Baby!, Stones Unturned, Sign of the Times) and the optional and
// betrayal chapters, which not every playthrough reaches.
export const DEFAULT_CHAPTERS = [
  { day: "Why Take the Chance?", location: "The Home Fires Burn" },
  { day: "This Changes Everything", location: "The Home Fires Burn" },
  { day: "A Taste of the Action", location: "The Home Fires Burn" },
  { day: "Go Down on Their Own", location: "The Home Fires Burn" },
  { day: "Never Going to Be Over", location: "The Home Fires Burn" },
  { day: "...Time to Make a Change", location: "The Home Fires Burn" },
  { day: "Still Pull This Off", location: "The Home Fires Burn" },
  { day: "Damn If This Ain't a Gas", location: "The Home Fires Burn" },
  { day: "...A Friend in Jesus", location: "The Home Fires Burn" },
  { day: "Old Times' Sake", location: "The Way of Flesh" },
  { day: "Prostitution", location: "The Way of Flesh" },
  { day: "Smack", location: "The Way of Flesh" },
  { day: "Kill Ritchie Doucet", location: "Pray on the Way Up" },
  { day: "Cut and Run", location: "The Blade Stained Red" },
  { day: "Moonshine", location: "The Blade Stained Red" },
  { day: "Protection", location: "The Blade Stained Red" },
  { day: "Kill the Butcher", location: "Brave New World" },
  { day: "We Partners Now?", location: "Work the Man Who Bleeds" },
  { day: "Union Extortion", location: "Work the Man Who Bleeds" },
  { day: "Contraband", location: "Work the Man Who Bleeds" },
  { day: "Get Michael Grecco", location: "Fish Gotta Eat" },
  { day: "An Emotional Attachment", location: "Sit Down" },
  { day: "Garbage", location: "The Dead Stay Gone" },
  { day: "Guns", location: "The Dead Stay Gone" },
  { day: "Get Enzo Conti", location: "A Little Late for That" },
  { day: "Construction", location: "Compromised Corruption" },
  { day: "Blackmail", location: "Compromised Corruption" },
  { day: "Kill Tony Derazio", location: "Everyone Will Notice" },
  { day: "Auto Theft", location: "Hot Rubber & Cold Blood" },
  { day: "Smuggling", location: "Hot Rubber & Cold Blood" },
  { day: "Kill Frank Pagani: Setup", location: "The Connection to Cuba" },
  { day: "Kill Frank Pagani: Takedown", location: "The Connection to Cuba" },
  { day: "PCP", location: "The Privileged Die Slow" },
  { day: "Southern Union", location: "The Privileged Die Slow" },
  { day: "Kill Remy Duvall", location: "There's a War Goin' On" },
  { day: "Kill Olivia Marcano", location: "Certainly Was Exciting" },
  { day: "Sex", location: "Evil That Men Do" },
  { day: "Drugs", location: "Evil That Men Do" },
  { day: "Kill the Judge", location: "The Poor Sumbitch" },
  { day: "Kill \"Uncle\" Lou Marcano", location: "Real Nice Time" },
  { day: "My Name's Lincoln Clay...", location: "In Comes the Devil" },
  { day: "Gambling", location: "The Fists & the Flames" },
  { day: "Black Market", location: "The Fists & the Flames" },
  { day: "Rescue Alvarez", location: "Jesuit in New Mexico" },
  { day: "Kill Tommy Marcano", location: "Burn Like Napalm" },
  { day: "Kill Sal Marcano", location: "Yet Here We Are" }
];
