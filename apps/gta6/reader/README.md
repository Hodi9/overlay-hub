# GTA VI mission-læser

Ser streamernes offentlige Twitch-streams, læser missionstitlen GTA viser nederst til højre, og sætter den som
"Spiller nu" på hver streamers egen tracker. Missionen før bliver krydset af. Streamerne skal ikke installere noget.
Kører på en Windows-pc med ffmpeg og Node; tekstgenkendelsen er Windows' egen.

## Opsætning

1. Kopiér `config.example.json` til `config.json` (den bliver ikke lagt på GitHub).
2. Én linje pr. stream: `twitch` (kanalnavnet på Twitch), `profile` (kanal-id på dreamglow.xyz, eller `null` for
   hovedtrackeren) og `apiKey`:
   - en kanal fra "Lav din egen kanal": kanalens **tracker-nøgle** (`t_...`, vises på kanalsiden)
   - hovedtrackeren: værdien af `GTA6_TRACKER_KEY` på Render
3. `region` er udsnittet der læses, i brøkdele af billedet (x, y, bredde, højde). Standard er nederste højre
   hjørne under overlayet.

## Kør

- `start-reader.cmd` (eller `node reader.mjs`). `"dryRun": true` i config, eller `--dry-run`, læser og logger uden
  at sende noget — brug det først.
- Alt den læser skrives i vinduet og i `reader.log`, og udsnittene gemmes i `captures/<kanal>/` (de seneste 300).

## Sikkerhed

- Hver stream hentes for sig og sendes kun til trackeren ved siden af den i config, med den trackers nøgle.
  Serveren afviser også tekst, hvis streamen ikke er kanalens egen (kanalens Twitch-navn, eller
  `GTA6_TWITCH_CHANNEL` for hovedtrackeren).
- Kun hele missionsnavne tæller. Missionen der allerede spiller og afkrydsede missioner ignoreres, så overlayets
  egen "GONE FISHING"-linje kan aldrig ændre noget. Linjer der ligner undertekster ignoreres.
- En titel der passer (næsten) præcist tæller med det samme; en usikker skal læses to gange. Efter en ændring venter den stream 60 sekunder.
