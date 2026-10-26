// Mine ratings. Ret listen her for at tilføje eller ændre et spil — siden bygger sig selv ud fra den.
//
//   id     – kort navn uden mellemrum, bruges som nøgle (skal være unik)
//   title  – spillets navn
//   year   – udgivelsesår (valgfri)
//   score  – 1 til 10, gerne med én decimal (fx 8.5 eller 8.2). null = ikke ratet endnu
//   note   – kort note, helst en til to sætninger
//   image  – valgfrit billede til kortet, fx "/img/ratings/rdr2.webp". Stående billeder
//            i sort/hvid passer bedst (kortet er 5:7). Uden billede vises et mørkt kort.
//   color  – true for at beholde billedets farver. Ellers gøres billedet sort/hvidt.
window.RATINGS = [
  { id: "rdr2", title: "Red Dead Redemption 2", year: 2018, score: 9.5, note: "Stilen, tidsperioden og plottwistene sidder lige i skabet, og alle missioner er værd at spille. Perfekt.", image: "/img/ratings/rdr2.webp" },
  { id: "tlou2", title: "The Last of Us Part II", year: 2020, score: null, note: "", image: "/img/tlou2.jpg" },
  { id: "gta5", title: "Grand Theft Auto V", year: 2013, score: null, note: "", image: "/img/ratings/gta5.webp" },
  { id: "cyberpunk", title: "Cyberpunk 2077", year: 2020, score: null, note: "", image: "/img/ratings/cyberpunk.webp" },
  { id: "mafia", title: "Mafia-trilogien", score: null, note: "", image: "/img/ratings/mafia.webp" },
  { id: "minecraft", title: "Minecraft", year: 2011, score: 8.2, note: "Ny-tilbagevender, og jeg mangler stadig at klare det på stream. Men jeg elsker at glemme tiden og bare grine.", image: "/img/ratings/minecraft.webp" },
  { id: "detroit", title: "Detroit: Become Human", year: 2018, score: null, note: "", image: "/img/ratings/detroit.webp" },
  { id: "hogwarts", title: "Hogwarts Legacy", year: 2023, score: null, note: "", image: "/img/ratings/hogwarts.webp" },
  { id: "jedi", title: "Star Wars Jedi: Fallen Order", year: 2019, score: null, note: "", image: "/img/ratings/jedi.webp" },
  { id: "wolfenstein", title: "Wolfenstein: The New Order", year: 2014, score: 7.9, note: "Elskede humoren og post-2. verdenskrigs-verdenen, og at man spiller med modstandsgruppen. Fed fortælling i et skydespil.", image: "/img/ratings/wolfenstein.webp" },
  { id: "witcher3", title: "The Witcher 3: Wild Hunt", year: 2015, score: null, note: "", image: "/img/ratings/witcher3.webp" },
];
