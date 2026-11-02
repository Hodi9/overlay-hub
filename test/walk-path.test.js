import test from "node:test";
import assert from "node:assert/strict";
import { walkMountPath } from "../apps/walk/path.js";

test("the walk overlay can sit on a short readable path or a long secret one", () => {
  assert.equal(walkMountPath("marcelwalk"), "/marcelwalk");
  assert.equal(walkMountPath("/marcelwalk/"), "/marcelwalk"); // slashes around it are ignored
  assert.equal(walkMountPath("  walk-k7m2x9q4r1  "), "/walk-k7m2x9q4r1");
  assert.equal(walkMountPath("Marcel_Walk-2"), "/Marcel_Walk-2");
});

test("a path that is empty, too short or not plain letters and digits mounts nothing", () => {
  for (const value of [undefined, null, "", "   ", "/", "ab", "a b", "marcel/walk", "../walk", "marcel.walk", "marcelwalk?x=1", "mærcel"]) {
    assert.equal(walkMountPath(value), null, JSON.stringify(value));
  }
});

test("the walk overlay never takes the name of another page", () => {
  const taken = ["/london", "/gaester", "/api", "/health"];
  assert.equal(walkMountPath("london", taken), null);
  assert.equal(walkMountPath("/health/", taken), null);
  assert.equal(walkMountPath("londonwalk", taken), "/londonwalk");
});
