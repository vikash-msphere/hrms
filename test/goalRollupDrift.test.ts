/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { goalAttainment } from "../src/domain/performance";
import { weightedProgress } from "../web/src/lib/goalMeasure";

// The Goals page states "how far along is this set of goals" in three places - a person's own scoreboard, each
// report's roll-up in the team band, and an objective's figure in the drawer - and a review scores the same
// rows with `goalAttainment`. Two implementations of one rule is a drift waiting to happen, and this is the
// drift that already happened: the page weighted by `(g.weight || 1)` while the server weighted by `g.weight`,
// and `goals.weight` DEFAULTS TO 0. So the two disagreed on the ordinary case and disagreed worst where it
// counts - five untouched goals beside one weighted goal at 100% read as ~17% on the page and scored 100% in
// the review, off the same rows, with a bonus priced off the second number.
//
// The web bundle can't import from src/, hence the mirror rather than a shared module. This pins the two.
describe("the Goals page's roll-up mirrors the review score", () => {
  // Every shape a weight column can be in, including the mixed one that was wrong in both directions.
  const cases: { name: string; goals: { weight: number; progress: number }[] }[] = [
    { name: "fully weighted", goals: [{ weight: 60, progress: 50 }, { weight: 10, progress: 100 }] },
    { name: "no weights at all (the default)", goals: [{ weight: 0, progress: 80 }, { weight: 0, progress: 20 }] },
    { name: "one weighted goal beside untouched ones", goals: [{ weight: 10, progress: 100 }, { weight: 0, progress: 0 }, { weight: 0, progress: 0 }, { weight: 0, progress: 0 }, { weight: 0, progress: 0 }, { weight: 0, progress: 0 }] },
    { name: "most weighted, one left out", goals: [{ weight: 50, progress: 100 }, { weight: 50, progress: 100 }, { weight: 0, progress: 0 }] },
    { name: "a single weighted goal", goals: [{ weight: 100, progress: 42 }] },
    { name: "a single unweighted goal", goals: [{ weight: 0, progress: 42 }] },
    { name: "equal weights", goals: [{ weight: 1, progress: 0 }, { weight: 1, progress: 100 }] },
    { name: "progress out of range in both directions", goals: [{ weight: 5, progress: 140 }, { weight: 5, progress: -20 }] },
    { name: "negative weight reads as no weight", goals: [{ weight: -5, progress: 60 }, { weight: 5, progress: 20 }] },
  ];

  it("agrees on every shape a weight column can be in", () => {
    for (const { name, goals } of cases) {
      const scored = goalAttainment(goals.map((g) => ({ ...g, status: "in_progress" as const })));
      expect(weightedProgress(goals), name).toBe(scored!.score);
    }
  });

  it("does not let one weighted goal speak for a whole unweighted set", () => {
    // The regression itself: partial weights are an unfinished setup, not an instruction to ignore the rest of
    // somebody's year. Both halves must count all six goals, so ~17%, never 100%.
    const goals = [{ weight: 10, progress: 100 }, ...Array.from({ length: 5 }, () => ({ weight: 0, progress: 0 }))];
    expect(weightedProgress(goals)).toBe(17);
    expect(goalAttainment(goals.map((g) => ({ ...g, status: "in_progress" as const })))).toMatchObject({ score: 17, weighted: false });
  });

  it("still weights when every goal carries one", () => {
    // 60 at 50% and 10 at 100% is 57%, not the 75% a plain average would claim - the whole point of weights.
    expect(weightedProgress([{ weight: 60, progress: 50 }, { weight: 10, progress: 100 }])).toBe(57);
  });

  it("reads an empty set as zero rather than dividing by nothing", () => {
    // The page filters to open goals and can be left with none; `goalAttainment` answers null for that case
    // because a review with nothing to score is not a score of 0, but a progress bar needs a number.
    expect(weightedProgress([])).toBe(0);
    expect(goalAttainment([])).toBeNull();
  });
});
