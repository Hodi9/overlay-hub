// PLACEHOLDER list. GTA VI comes out on 19 Nov 2026 and Rockstar has not
// published any mission names. The only figure out there is Insider Gaming's
// leak (Tom Henderson, 15 Nov 2026): "nearly 100 story missions across five
// chapters". So this seeds 5 chapters x 20 numbered missions to make the
// overlay and panel testable. Replace it after launch with the real list,
// using "Indsæt hele listen" in the control panel (one mission per line,
// "Mission | Chapter"). "day" is the mission name, "location" the chapter.
export const CHAPTER_COUNT = 5;
export const MISSIONS_PER_CHAPTER = 20;

export const DEFAULT_MISSIONS = Array.from({ length: CHAPTER_COUNT * MISSIONS_PER_CHAPTER }, (_, i) => ({
  day: `Mission ${i + 1}`,
  location: `Chapter ${Math.floor(i / MISSIONS_PER_CHAPTER) + 1}`
}));
