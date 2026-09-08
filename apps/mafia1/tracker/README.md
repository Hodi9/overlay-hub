# Mafia: Definitive Edition auto-tracker

Uses OCR (see `apps/_lib/tracker/README.md` for how the shared script
works), not save-file reading. Mafia DE's `.sav` files don't have an
obviously readable community save-editor scene the way RDR2/GTA5 do, which
suggests they're probably encrypted — but this hasn't actually been
confirmed against a real save file yet. If you want to double-check once
you've played a bit (could mean switching to a much more reliable
save-file-based tracker instead of OCR), just ask.

## Setup

1. Copy `mafia1-tracker-config.example.json` to `mafia1-tracker-config.json` (gitignored — never commit it).
2. Set `apiKey` to the `MAFIA1_TRACKER_KEY` value from Render.
3. Double-click `Start Mafia1 Tracker.cmd` while you play.

## The chapter list is a short starter, by design

`apps/mafia1/chapters.js` only has the first few chapters — not a
transcript of the game's real chapter titles, just what this was written
with real confidence about. While you play, every OCR capture shows up
live in the control panel; click **+ Tilføj som næste kapitel** when it
says "Ingen match" to add the exact text from your own game, one chapter
at a time, guaranteed correct because it's your actual game data.
