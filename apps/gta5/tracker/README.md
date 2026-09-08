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

## The mission list is a short starter, by design

`apps/gta5/missions.js` only ships with the early-game missions this was
built with real confidence about (plus a couple confirmed against actual
save files). GTA V has around 69 story missions with some choice-dependent
branching, which is too much to safely guess from memory in exact order and
wording — a wrong guess here just means "no match," not a Real Problem, but
it's not worth pretending the list is complete.

Instead: while you play, every save the tracker reads (matched or not) shows
up live in the control panel under "Automatisk tracker (save-fil)". When it
says "Ingen match," click **+ Tilføj som næste mission** to append the exact
text straight from your own save file — guaranteed correct because it's your
actual game data, not a guess. A few sessions of doing that and the list
will be complete and accurate for your playthrough.

## Running it for more than one person

Same as the TLOU2 tracker — add `"profile": "name"` to
`gta5-tracker-config.json` and use `?profile=name` on the overlay/control
URLs. See the control panel's "avanceret" section for a profile switcher.
