import test from "node:test";
import assert from "node:assert/strict";
import { sortFilms } from "../public/films/sort.js";

// Rækkefølgen her er "senest set først", som Letterboxd giver den.
const FILMS = [
  { title: "Zodiac", year: 2007, stars: 4 },
  { title: "Åben dør", year: 1999, stars: 5 },
  { title: "Alfa", year: null, stars: null },
  { title: "Ærø", year: 2015, stars: 4 },
  { title: "Øl og brød", year: 2015, stars: 3.5 },
  { title: "Beta", year: 2020, stars: 5 }
];
const titles = (films) => films.map((f) => f.title);

test("senest set beholder rækkefølgen fra Letterboxd", () => {
  assert.deepEqual(titles(sortFilms(FILMS, "recent")), titles(FILMS));
});

test("rating: højest først, uden rating nederst, og lige point beholder rækkefølgen", () => {
  assert.deepEqual(titles(sortFilms(FILMS, "rating")), ["Åben dør", "Beta", "Zodiac", "Ærø", "Øl og brød", "Alfa"]);
});

test("udgivelsesår: nyeste først, uden år nederst, og samme år beholder rækkefølgen", () => {
  assert.deepEqual(titles(sortFilms(FILMS, "year")), ["Beta", "Ærø", "Øl og brød", "Zodiac", "Åben dør", "Alfa"]);
});

test("A–Å følger dansk alfabet, så Æ, Ø og Å kommer sidst", () => {
  assert.deepEqual(titles(sortFilms(FILMS, "az")), ["Alfa", "Beta", "Zodiac", "Ærø", "Øl og brød", "Åben dør"]);
});

test("Å–A er den omvendte rækkefølge", () => {
  assert.deepEqual(titles(sortFilms(FILMS, "za")), ["Åben dør", "Øl og brød", "Ærø", "Zodiac", "Beta", "Alfa"]);
});

test("sortering ændrer ikke den oprindelige liste, og en ukendt nøgle falder tilbage til senest set", () => {
  const before = titles(FILMS);
  sortFilms(FILMS, "az");
  assert.deepEqual(titles(FILMS), before);
  assert.deepEqual(titles(sortFilms(FILMS, "noget-andet")), before);
});
