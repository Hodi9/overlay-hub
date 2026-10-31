# Mafia III: Definitive Edition auto-tracker

Uses OCR (see `apps/_lib/tracker/README.md` for how the shared script
works), not save-file reading. No confirmed evidence that this game's save
files are readable text the way RDR2/GTA5's are — the modding community
around Mafia's Definitive Edition trilogy doesn't have the kind of
save-editor tools that usually show up once a format's been cracked. If
you want to double-check once you've played a bit (could mean switching to
a much more reliable save-file-based tracker instead of OCR), just ask.

## Setup

1. Copy `mafia3-tracker-config.example.json` to `mafia3-tracker-config.json` (gitignored — never commit it).
2. Set `apiKey` to the `MAFIA3_TRACKER_KEY` value from Render.
3. Double-click `Start Mafia3 Tracker.cmd` while you play.

## Mission list and order

`apps/mafia3/chapters.js` has the 46 story missions: the nine prologue
missions, then the district arcs in walkthrough order, ending with Kill Sal
Marcano. Each mission carries its story chapter name from the Mafia Wiki as
its "location", so a capture of either the mission or the chapter name
matches. The DLC campaigns and the optional/betrayal chapters aren't in it.

Mafia III lets you take New Bordeaux's districts in any order, so only the
prologue and the finale are fixed. The tracker only looks a few missions
ahead of the current one: if you go a different way, every OCR capture shows
up live in the control panel — click a mission to jump there, or click
**+ Tilføj som næste kapitel** when it says "Ingen match" to add the exact
text from your own game.
