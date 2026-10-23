// Progress maths shared by the overlay and the control panel (loaded in the
// browser as an ES module, and imported directly by test/cyberpunk.test.js).
//
// The server's own percent always counts every job. Cyberpunk lets the
// streamer choose whether Phantom Liberty jobs count, so the pages recompute
// from the job list: everything before `currentIndex` is done, and when
// `includePhantom` is false the "phantom" jobs are dropped from both the done
// count and the total.
export function computeProgress(chapters, currentIndex, includePhantom) {
  const list = Array.isArray(chapters) ? chapters : [];
  const finished = currentIndex >= list.length;
  let completed = 0;
  let total = 0;
  list.forEach((chapter, index) => {
    if (!includePhantom && chapter.part === "phantom") return;
    total += 1;
    if (finished || index < currentIndex) completed += 1;
  });
  const percent = total ? Math.round((completed / total) * 1000) / 10 : 0;
  return { completed, total, percent, finished };
}

// Where the run is right now. There is no "between jobs" state: finishing a job
// starts the next one straight away, so the current job is always "started"
// (in progress, not counted as done) until it is finished.
//   idle     -> nothing started yet; `next` is the first job
//   started  -> `current` is in progress; `next` is what finishing it starts
//   finished -> every job is done
export function describePhase(chapters, currentIndex) {
  const list = Array.isArray(chapters) ? chapters : [];
  if (currentIndex < 0) return { phase: "idle", current: null, next: list[0] || null };
  if (currentIndex >= list.length) return { phase: "finished", current: null, next: null };
  return { phase: "started", current: list[currentIndex], next: list[currentIndex + 1] || null };
}
