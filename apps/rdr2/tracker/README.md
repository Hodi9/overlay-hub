# RDR2 auto-tracker

Watches your newest RDR2 save file on disk and pushes the mission name
straight to the overlay, the same way the GTA V tracker does — RDR2's save
files store the current mission name as readable text right in the header.
No OCR, no screen capture, and it works even while the game is minimized.

## Setup

1. Copy `rdr2-tracker-config.example.json` to `rdr2-tracker-config.json` (gitignored — never commit it).
2. Set `panelUrl` to your overlay-hub URL, e.g. `https://overlay-hub.onrender.com`.
3. Set `apiKey` to the `RDR2_TRACKER_KEY` value from Render's environment variables.
4. Leave `"saveFolder": null` — it auto-detects `Documents\Rockstar Games\Red Dead Redemption 2\Profiles`. Only set this manually if autodetection fails.
5. Double-click `Start RDR2 Tracker.cmd` while you play. Leave the window open in the background.

This is entirely optional — the control panel's Back/Advance buttons and the
Twitch chat-style "Sæt nu" clicks work fine without it. Running the tracker
just means you never have to touch the panel yourself.

## Testing without touching the live overlay

```bash
powershell -File rdr2-save-tracker.ps1 -Once -DryRun
```

Prints the mission name/percent from your most recent save without sending anything.

## Running it for more than one person

Add `"profile": "name"` to `rdr2-tracker-config.json` and use `?profile=name`
on the overlay/control URLs. See the control panel's "avanceret" section for
a profile switcher.
