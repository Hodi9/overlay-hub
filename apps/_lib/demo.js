// ?demo=<tal mellem 0 og 1> på en tracker-overlay: hvis intet er startet endnu, vises i stedet et tilfældigt
// "gennemført" trin, så en besøgende fra forsiden ikke bare ser "Ikke startet endnu". Det er kun et blik på
// svaret — den gemte fremgang bliver aldrig ændret, og er der rigtig fremgang, vises den som den er.
// Overlay-siden vælger selv tallet (Math.random), så state og events giver samme trin.

export function demoFraction(request) {
  const raw = request.query?.demo;
  if (typeof raw !== "string" || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(0.999999, Math.max(0, n)) : null;
}

// Et trin mellem ca. 10 % og 90 % af vejen igennem: aldrig 0 og aldrig helt færdigt.
export function demoStep(total, fraction) {
  if (total <= 1) return 0;
  const min = Math.min(total - 1, Math.max(1, Math.round(total * 0.1)));
  const max = Math.max(min, Math.round(total * 0.9));
  return Math.min(total - 1, min + Math.floor(fraction * (max - min + 1)));
}

// Til trackere med et sæt af gennemførte missioner (GTA V, RDR2): de første N krævede missioner er klaret.
export function demoCompleted(chapters, fraction, isRequired = () => true) {
  const required = [];
  chapters.forEach((chapter, index) => { if (isRequired(chapter)) required.push(index); });
  const done = required.slice(0, demoStep(required.length, fraction));
  return { completed: new Set(done), lastCompletedIndex: done.length ? done[done.length - 1] : -1 };
}
