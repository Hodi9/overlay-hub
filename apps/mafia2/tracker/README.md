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

## The chapter list is a short starter, by design

`apps/mafia2/chapters.js` only has the first few chapters — not a
transcript of the game's real chapter titles, just what this was written
with real confidence about. While you play, every OCR capture shows up
live in the control panel; click **+ Tilføj som næste kapitel** when it
says "Ingen match" to add the exact text from your own game, one chapter
at a time, guaranteed correct because it's your actual game data.
