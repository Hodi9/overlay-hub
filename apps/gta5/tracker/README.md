# GTA V auto-tracker

Unlike TLOU2, GTA V's save files (PC, both the legacy version and GTAV
Enhanced) store the current mission name as readable text right in the save
file header — the same trick RDR2 uses. So this works exactly like the RDR2
tracker: it watches your newest save file on disk and pushes the mission
name straight to the overlay. No OCR, no screen capture, and it works even
while the game is minimized or you're tabbed out.

## Setup

1. Copy `gta5-tracker-config.example.json` to `gta5-tracker-config.json` (gitignored — never commit it).
2. Set `panelUrl` to your overlay-hub URL, e.g. `https://overlay-hub.onrender.com`.
3. Set `apiKey` to the `GTA5_TRACKER_KEY` value from Render's environment variables.
4. Leave `"saveFolder": null` — it auto-detects both `Documents\Rockstar Games\GTA V\Profiles` and `...\GTAV Enhanced\Profiles` and uses whichever has the most recently written save. Only set this manually if autodetection fails (e.g. a non-default Documents location).
5. Double-click `Start GTA5 Tracker.cmd` while you play. Leave the window open in the background.

## Testing without touching the live overlay

```bash
powershell -File gta5-save-tracker.ps1 -Once -DryRun
```

Prints the mission name/percent from your most recent save without sending anything.

## How progress is tracked

Like the RDR2 tracker, GTA V progress is a *set* of ticked-off missions. Each
save the tracker reads is matched against the **whole** mission list and that
one mission is marked done — so it works wherever you are in the game when
you start the tracker (it does not need to start from mission 1). The control
panel shows the full list with checkmarks and updates live.

Joined mid-playthrough? The story is mostly linear, so use **Fyld ud til
seneste** in the control panel to mark everything before the latest matched
mission as done in one click. From then on the tracker keeps adding missions
by itself.

## The mission list

`apps/gta5/missions.js` covers the main story (56 rows; heist approach
variants are collapsed into one row each). Strangers & Freaks, Lester's
assassinations, family missions and Dr. Friedlander sessions are not
included. While you play, every save the tracker reads (matched or not) shows
up live in the control panel under "Automatisk tracker (save-fil)". When it
says "Ingen match," click **+ Tilføj som ny mission** to append the exact
text straight from your own save file — guaranteed to match because it's your
actual game data.

## Running it for more than one person

Same as the TLOU2 tracker — add `"profile": "name"` to
`gta5-tracker-config.json` and use `?profile=name` on the overlay/control
URLs. See the control panel's "avanceret" section for a profile switcher.
