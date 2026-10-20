// How each pane moves when the panes slide, in a window of four 375 px slots, 1,500 px wide.

import { expect, test } from "bun:test";
import { type Before, type Placed, alongOf, beforeOf, goingOf, moveOf } from "./moves";

const RIGHT = 1500;

/** A pane by its key, from its left edge to its right. */
const at = (key: string, left: number, right: number): Placed => ({ key, rect: { left, right } });
const was = (key: string, left: number, right: number, opacity = 1): Before => ({ ...at(key, left, right), opacity });

/** How each pane of `now` moves, by its key. */
function moves(before: Before[], now: Placed[]) {
  const along = alongOf(before, now);
  if (along === undefined) throw new Error("nothing kept moves");
  return { along, by: Object.fromEntries(now.map((pane) => [pane.key, moveOf(pane.rect, beforeOf(before, pane), along, RIGHT)])) };
}

test("on a step out every pane starts where it was: the kept ones as far from their slots as the step, the preview at the right edge moving its left edge as far", () => {
  // `doc` with `[id].tsx` beside it, then `pages` with `doc` and the same file.
  const { along, by } = moves(
    [was("p/doc", 0, 375), was("p/doc/[id].tsx", 375, 1500)],
    [at("p", 0, 375), at("p/doc", 375, 750), at("p/doc/[id].tsx", 750, 1500)],
  );
  expect(along).toBe(-375);
  expect(by["p/doc"]).toEqual({ from: -375, edge: false, opacity: 1 });
  // The same file: no fade, and its right end stays at the edge of the window, so no gap opens there.
  expect(by["p/doc/[id].tsx"]).toEqual({ from: -375, edge: true, opacity: 1 });
  // The folder that comes slides in with them, fading up.
  expect(by.p).toEqual({ from: -375, edge: false, opacity: 0 });
});

test("a step out with four folders in the slots moves every column as one", () => {
  const before = [was("n/src", 0, 375), was("n/src/pages", 375, 750), was("n/src/pages/doc", 750, 1125), was("n/src/pages/doc/[id].tsx", 1125, 1500)];
  const now = [at("n", 0, 375), at("n/src", 375, 750), at("n/src/pages", 750, 1125), at("n/src/pages/doc", 1125, 1500)];
  const { along, by } = moves(before, now);
  for (const key of ["n/src", "n/src/pages", "n/src/pages/doc"]) expect(by[key]).toEqual({ from: along, edge: false, opacity: 1 });
  expect(by.n?.from).toBe(along);
  // Drawn from the answer for the folder left, `pages` was not on screen and `doc` sat in its slot: `doc` did not
  // move while `src` did, and `pages` came in where it ends. That is the step that must not happen again.
  const early = moves(before, [at("n", 0, 375), at("n/src", 375, 750), at("n/src/pages/doc", 750, 1125)]);
  expect(early.by["n/src/pages/doc"]?.from).not.toBe(early.along);
});

test("closing a file slides the list in by a slot while the file's left edge moves to it, and opening it does the reverse", () => {
  const close = moves([was("p/a.md", 0, 1500)], [at("p", 0, 375), at("p/a.md", 375, 1500)]);
  expect(close.by["p/a.md"]).toEqual({ from: -375, edge: true, opacity: 1 });
  expect(close.by.p).toEqual({ from: -375, edge: false, opacity: 0 });
  const open = moves([was("p", 0, 375), was("p/a.md", 375, 1500)], [at("p/a.md", 0, 1500)]);
  expect(open.along).toBe(375);
  expect(open.by["p/a.md"]).toEqual({ from: 375, edge: true, opacity: 1 });
});

test("a pane that comes at the right edge moves whole from past it, and moves its left edge when it comes from the left", () => {
  // A step in: the new last column slides in from beyond the window.
  const right = moves([was("a", 0, 375), was("a/b", 375, 750)], [at("a/b", 0, 375), at("a/b/c", 375, 750), at("a/b/c/f.txt", 750, 1500)]);
  expect(right.by["a/b/c/f.txt"]).toEqual({ from: 375, edge: false, opacity: 0 });
  // A step out to a file not shown before: moved whole from the left, its right end would leave a gap at the edge.
  const left = moves([was("a/b", 0, 375), was("a/b/c", 375, 750)], [at("a", 0, 375), at("a/b", 375, 750), at("a/b/x.txt", 750, 1500)]);
  expect(left.by["a/b/x.txt"]).toEqual({ from: -375, edge: true, opacity: 0 });
});

test("a pane part way through fading in goes on from where it had got to, and an empty key is never the same pane", () => {
  const { by } = moves([was("a", 0, 375), was("a/b", 375, 750, 0.4)], [at("", 0, 375), at("a", 375, 750), at("a/b", 750, 1125)]);
  expect(by["a/b"]?.opacity).toBe(0.4);
  expect(by[""]?.opacity).toBe(0);
  expect(alongOf([was("", 0, 375)], [at("", 375, 750)])).toBeUndefined();
});

test("a preview pushed past the right edge slides out as it was, live, and one back in the slots is drawn there", () => {
  // `page.html` is in the slots, then a step out takes it past the right edge: the pane keeps it while it slides out.
  // Before, a copy slid out in its place, and a copy leaves out the frame of a page or a PDF: it went blank.
  let going = goingOf<string>(true, null, null);
  expect(going).toBeNull();
  going = goingOf(false, "page.html", going);
  expect(going).toBe("page.html");
  // It keeps it on the draws during the slide, and when a second step out comes before the first is over.
  going = goingOf(false, null, going);
  expect(going).toBe("page.html");
  // A step straight back in: the pane is in the slots again, and slides on from where it had got to.
  expect(goingOf(true, null, going)).toBeNull();
  // A pane kept as it slid out goes on from where it was, as far faded out as it was.
  const back = moveOf({ left: 1125, right: 1500 }, was("page.html", 1409, 1787, 0.27), 275, RIGHT);
  expect(back).toEqual({ from: 284, edge: false, opacity: 0.27 });
});
