// Mine ratings. Ret listen her for at tilføje eller ændre et spil — siden bygger sig selv ud fra den.
//
//   id     – kort navn uden mellemrum, bruges som nøgle (skal være unik)
//   title  – spillets navn
//   year   – udgivelsesår (valgfri)
//   score  – 1 til 10, halve point er fine (fx 8.5). null = ikke ratet endnu
//   note   – kort note, helst en til to sætninger
//   image  – valgfrit billede til kortet, fx "/img/ratings/rdr2.webp". Stående billeder
//            i sort/hvid passer bedst (kortet er 5:7). Uden billede vises et mørkt kort.
window.RATINGS = [
  { id: "rdr2", title: "Red Dead Redemption 2", year: 2018, score: 9.5, note: "Stilen, tidsperioden og plottwistene sidder lige i skabet, og alle missioner er værd at spille. Perfekt.", image: "/img/rdr2.jpg" },
  { id: "tlou2", title: "The Last of Us Part II", year: 2020, score: null, note: "", image: "/img/tlou2.jpg" },
  { id: "gta5", title: "Grand Theft Auto V", year: 2013, score: null, note: "", image: "/img/gta5.jpg" },
  { id: "cyberpunk", title: "Cyberpunk 2077", year: 2020, score: null, note: "", image: "/img/cyberpunk.jpg" },
  { id: "mafia", title: "Mafia-trilogien", score: null, note: "", image: "/img/mafia.webp" },
  { id: "minecraft", title: "Minecraft", year: 2011, score: null, note: "", image: "/img/minecraft-dragon.webp" },
];
