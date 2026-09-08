# Shared OCR tracker

`ocr-tracker.ps1` is used by every OCR-based story tracker (TLOU2, and the
Mafia trilogy). It watches a region of the screen every 2 seconds, runs it
through Windows' built-in OCR, and posts the recognized text to whichever
game's `/api/tracker` endpoint its config points at.

Each game has its own `tracker/` folder with just a config file and a
`.cmd` launcher that calls this shared script — see that game's folder for
setup instructions specific to it.

## Config shape

```json
{
  "panelUrl": "https://overlay-hub.onrender.com",
  "apiKey": "the game's TRACKER_KEY value",
  "gamePath": "mafia1",
  "profile": null,
  "region": null
}
```

- `gamePath` selects which game's API the text gets posted to (must match the app's mount path, e.g. `mafia1`, `mafia2`, `mafia3`, `tlou2`).
- `profile` — see the control panel's "avanceret" section if you're running this for more than one person on the same deployment.
- `region` — leave `null` for a default centered capture box, or calibrate with `-Calibrate` (see below).

## Commands

```bash
# One-time calibration screenshot + your screen resolution
powershell -File ocr-tracker.ps1 -ConfigPath <path-to-config.json> -Calibrate

# Test what it reads right now without sending anything
powershell -File ocr-tracker.ps1 -ConfigPath <path-to-config.json> -Once -DryRun
```
