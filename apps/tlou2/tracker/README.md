# TLOU2 auto-tracker

TLOU2's save files don't expose a readable chapter name the way RDR2's do, and
if you're on PS4/PS5 there's no local save file at all. So this watches the
**screen** instead: TLOU2 shows a large title card ("SEATTLE, DAY ONE" /
"DOWNTOWN" etc.) whenever you enter a new chapter. This script grabs that
region of the screen every 2 seconds, runs it through Windows' built-in OCR,
and — if the text matches an upcoming chapter — pushes the update to the
overlay automatically. No extra software to install; it only uses OCR that
ships with Windows 10/11 (Settings → Time & language → Language & region →
add "English (United States)" with the "Optical character recognition"
option, if it's not already installed).

This has to run on the PC that's actually displaying the game (capture card
output, PC gameplay, whatever OBS is capturing) since it reads the screen.

## Setup

1. Copy `tlou2-tracker-config.example.json` to `tlou2-tracker-config.json` (this file is gitignored — never commit it).
2. Set `panelUrl` to your overlay-hub URL, e.g. `https://overlay-hub.onrender.com`.
3. Set `apiKey` to the `TLOU2_TRACKER_KEY` value from Render's environment variables for this service.
4. Leave `"region": null` to use a default centered capture box, or calibrate it (see below).
5. Double-click `Start TLOU2 Tracker.cmd` while you play. Leave the window open in the background.

## Calibrating the capture region (optional)

The default region is a centered box (60% width, 30% height, vertically
centered-ish) which should catch most title cards on a standard 16:9
fullscreen setup. If matches aren't happening, calibrate manually:

```bash
powershell -File tlou2-ocr-tracker.ps1 -Calibrate
```

This saves a full screenshot (`calibration-screenshot.png`, also gitignored)
and prints your screen resolution. Open the screenshot, note the pixel
rectangle around where the title card text appears, and add it to
`tlou2-tracker-config.json`:

```json
{
  "panelUrl": "https://overlay-hub.onrender.com",
  "apiKey": "...",
  "region": { "x": 400, "y": 350, "width": 1120, "height": 320 }
}
```

## Testing without touching the live overlay

```bash
powershell -File tlou2-ocr-tracker.ps1 -Once -DryRun
```

Prints what it recognized on screen right now without sending anything.

## If the chapter list doesn't match what you see in-game

The default chapter list (`apps/tlou2/chapters.js`) is a best-effort seed —
it hasn't been verified against the game's actual on-screen title-card
wording, especially for Abby's chapters. Open the control panel while
playing: every OCR capture (matched or not) shows up under "Automatisk
tracker (OCR)", so you can see exactly what the script read and fix chapter
names/order in the list below it to match.
