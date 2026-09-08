# Mafia II: Definitive Edition auto-tracker

Uses OCR (see `apps/_lib/tracker/README.md` for how the shared script
works), not save-file reading. No confirmed evidence that this game's save
files are readable text the way RDR2/GTA5's are — the modding community
around Mafia's Definitive Edition trilogy doesn't have the kind of
save-editor tools that usually show up once a format's been cracked. If
you want to double-check once you've played a bit (could mean switching to
a much more reliable save-file-based tracker instead of OCR), just ask.

## Setup

1. Copy `mafia2-tracker-config.example.json` to `mafia2-tracker-config.json` (gitignored — never commit it).
2. Set `apiKey` to the `MAFIA2_TRACKER_KEY` value from Render.
3. Double-click `Start Mafia2 Tracker.cmd` while you play.

## The chapter list

`apps/mafia2/chapters.js` has all 16 chapters (Prologue + 15), checked
against the Mafia Wiki rather than recalled from memory — worth mentioning
since the initial memory-based guess actually had chapters 1 and 2 swapped
("Home Sweet Home" isn't first, "The Old Country" is). If the OCR still
doesn't match what's on screen, the control panel shows every capture
live; click **+ Tilføj som næste kapitel** when it says "Ingen match" to
add the exact text from your own game instead.
