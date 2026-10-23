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
