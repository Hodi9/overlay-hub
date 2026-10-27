// Sorteringer til Film-siden. Ren logik uden DOM, så den også kan testes i Node.
// Film uden rating eller udgivelsesår står altid nederst, og ved lige point bliver rækkefølgen
// fra Letterboxd (senest set først) bevaret.

const collator = new Intl.Collator("da", { sensitivity: "base" });

export const SORTS = {
  recent: () => 0,
  rating: (a, b) => missingLast(a.stars, b.stars) ?? b.stars - a.stars,
  year: (a, b) => missingLast(a.year, b.year) ?? b.year - a.year,
  az: (a, b) => collator.compare(a.title, b.title),
  za: (a, b) => collator.compare(b.title, a.title)
};

function missingLast(x, y) {
  const noX = x === null || x === undefined;
  const noY = y === null || y === undefined;
  if (noX && noY) return 0;
  if (noX) return 1;
  if (noY) return -1;
  return null;
}

export function sortFilms(films, key) {
  const compare = SORTS[key] || SORTS.recent;
  return films
    .map((film, index) => ({ film, index }))
    .sort((a, b) => compare(a.film, b.film) || a.index - b.index)
    .map(({ film }) => film);
}
