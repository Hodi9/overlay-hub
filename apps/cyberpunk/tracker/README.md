# Cyberpunk 2077 auto-tracker

Trackeren læser **skærmen**: Cyberpunk viser titlen på den quest, du har valgt at
spore, i HUD'en (med det nuværende mål under). Scriptet tager et billede af det
område hvert 2. sekund, læser det med Windows' indbyggede OCR, og hvis teksten
indeholder navnet på et job fra listen, sætter det jobbet som **Mission startet**
på overlayet. Intet ekstra skal installeres. Det bruger kun den OCR, der følger
med Windows 10/11 (Indstillinger → Tid og sprog → Sprog og område → tilføj
"English (United States)" med "Optical character recognition").

Det skal køre på den pc, der viser spillet (det OBS optager), fordi det læser
skærmen. Sæt spillet til **Borderless Windowed**: i eksklusiv fuldskærm kan et
skærmbillede komme ud helt sort.

## Hvorfor skærmen og ikke savefilen?

`metadata.9.json` i en save har en liste over færdige quest-kæder, men ingen
oplysning om hvilken quest du er i gang med, og en hel kæde som Automatic Love
står kun som ét ID. Så den kan ikke vise "startet", og den opdateres først, når
spillet gemmer. HUD'en viser derimod lige nu, hvad du er i gang med.

## Opsætning

1. Kopiér `cyberpunk-tracker-config.example.json` til `cyberpunk-tracker-config.json` (filen er gitignored — commit den aldrig).
2. Sæt `panelUrl` til din overlay-hub-adresse, fx `https://overlay-hub.onrender.com`.
3. Sæt `apiKey` til værdien af `CYBERPUNK_TRACKER_KEY` fra Render (Environment). Den er genereret automatisk.
4. **Kalibrér området** (se nedenfor). Det er ikke valgfrit her: standardområdet er midt på skærmen, men quest-titlen sidder i HUD'en.
5. Dobbeltklik `Start Cyberpunk Tracker.cmd`, mens du spiller, og lad vinduet stå i baggrunden.

## Kalibrér området

1. Dobbeltklik `Calibrate Cyberpunk Region.cmd`. Gå tilbage til spillet med et main job sporet og quest-titlen synlig. Der tages et fuldt skærmbillede efter 10 sekunder.
2. Det gemmes som `calibration-screenshot.png` i denne mappe (gitignored), og din skærmopløsning vises.
3. Åbn billedet og find rektanglet omkring quest-titlen **og målet under den**. Skriv det ind i `cyberpunk-tracker-config.json`:

```json
{
  "panelUrl": "https://overlay-hub.onrender.com",
  "apiKey": "...",
  "gamePath": "cyberpunk",
  "profile": null,
  "region": { "x": 1500, "y": 250, "width": 400, "height": 160 }
}
```

(Tallene er kun et eksempel — brug dine egne fra skærmbilledet.)

4. Test uden at røre ved det rigtige overlay:

```bash
powershell -File ..\..\_lib\tracker\ocr-tracker.ps1 -ConfigPath cyberpunk-tracker-config.json -Once -DryRun
```

Den skriver, hvad den læser på skærmen lige nu. Står quest-titlen i teksten, virker det.

## Hvad du kan forvente

- **Det er det *sporede* job, der tæller.** Sporer du et gig eller et sidejob, står der "Ingen match" (i vinduet og i kontrolpanelet), og intet ændres. Det er helt fint.
- **Den følger kun frem.** Et nyt job bliver fundet, hvis det ligger inden for de næste 5 jobs på listen. Starter du noget længere fremme (fx Phantom Liberty midt i Akt 2), findes det ikke automatisk. Kontrolpanelet viser så en knap **Start «jobbet»**, hvis navnet allerede står på listen (alt før tæller som gennemført), ellers **+ Tilføj som næste main job**. Du kan også flytte jobs med pilene, så listen følger din rækkefølge.
- **Den siger kun, hvad du er i gang med, ikke hvornår du er færdig.** Når næste job bliver sporet, tæller det forrige som færdigt. Det allersidste job afslutter du selv med **Mission færdiggjort**.
- **Navnene på listen er ikke verificeret mod spillet** (kilderne er ikke helt enige). Kontrolpanelet viser alt, hvad scriptet læser, så du kan se, hvordan en titel faktisk bliver læst, og rette navnet på listen, hvis OCR'en staver det anderledes.

## Flere personer på samme server

Giv hver deres kørsel et profilnavn, så fremskridtet ikke overskrives: sæt `"profile": "navn"` i deres `cyberpunk-tracker-config.json` og brug `?profile=navn` på overlay- og kontrolpanel-adresserne.
