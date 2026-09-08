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

## Mafia III doesn't have a fixed chapter order

Unlike Mafia I and II, Mafia III lets you choose which of New Bordeaux's
districts to take over and in what order — there's no single correct
chapter sequence to pre-fill. `apps/mafia3/chapters.js` only has two
verified-real mission names as a starting point (checked against
mafiagame.fandom.com, not guessed). While you play, every OCR capture
shows up live in the control panel; click **+ Tilføj som næste kapitel**
when it says "Ingen match" to add the exact text from your own game — for
this game especially, that's the real source of truth, not any pre-written
list.
