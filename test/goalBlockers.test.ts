/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { blockingChains, retroSeed } from "../web/src/lib/goalState";

// What to unblock first, on a page that otherwise only shows what is late.
//
// A list of goals sorted by drift can never say which one is the REASON: the goal holding up three others is
// usually fine on its own numbers. The properties worth holding: the count runs through the chain, a
// finished blocker is not blocking anybody, and a pair of goals each recorded as waiting on the other is
// somebody's mistake rather than a hang.

const idOf = (ref: string) => ref.split("/").pop()!;
const goal = (id: string, over: Partial<{ status: string; blocked_by: string }> = {}) => ({
  path: `goals/${id}`,
  title: id,
  status: "in_progress",
  ...over,
}) as Parameters<typeof blockingChains>[0][number];

describe("blocking chains", () => {
  it("counts the whole chain, not just what waits on it directly", () => {
    // c waits on b, b waits on a. a is holding up two goals.
    const out = blockingChains([
      goal("a"),
      goal("b", { blocked_by: "goals/a" }),
      goal("c", { blocked_by: "goals/b" }),
    ], idOf);
    const byId = new Map(out.map((x) => [idOf(x.goal.path!), x.blocking.length]));
    expect(byId.get("a")).toBe(2);
    expect(byId.get("b")).toBe(1);
    // Most held up first.
    expect(idOf(out[0]!.goal.path!)).toBe("a");
  });

  it("drops a blocker that has been finished", () => {
    const out = blockingChains([
      goal("done", { status: "completed" }),
      goal("waiting", { blocked_by: "goals/done" }),
    ], idOf);
    // The goal waiting on it may not have noticed, which is worth saying elsewhere - but a finished goal is
    // not holding anything up, and putting it at the top of "unblock these" sends somebody nowhere.
    expect(out).toEqual([]);
  });

  it("ignores a dependent that was cancelled", () => {
    const out = blockingChains([
      goal("a"),
      goal("dead", { blocked_by: "goals/a", status: "cancelled" }),
    ], idOf);
    expect(out).toEqual([]);
  });

  it("survives a pair that each wait on the other", () => {
    const out = blockingChains([
      goal("a", { blocked_by: "goals/b" }),
      goal("b", { blocked_by: "goals/a" }),
    ], idOf);
    // Both are reported as holding up exactly the other, and the walk terminates.
    expect(out).toHaveLength(2);
    expect(out[0]!.blocking).toHaveLength(1);
  });

  it("says nothing about a blocker that is not on the page", () => {
    const out = blockingChains([goal("waiting", { blocked_by: "goals/elsewhere" })], idOf);
    // Another team's goal, or one this reader cannot see. An anonymous row is not something to act on.
    expect(out).toEqual([]);
  });
});

// The closing note, started from the record rather than from a blank box.
describe("the retro seed", () => {
  it("names the measure, the shape of the climb and what was delivered", () => {
    const text = retroSeed(
      { status: "completed", progress: 100, unit: "days", baseline_value: 14, current_value: 3, target_value: 3 },
      [{ title: "Rewrite the welcome email", deliver_time: "2026-03-02T00:00:00Z" }, { title: "Still going", deliver_time: null }],
      [{ at_time: "2026-01-04T00:00:00Z", progress: 0 }, { at_time: "2026-01-20T00:00:00Z", progress: 40 }, { at_time: "2026-03-02T00:00:00Z", progress: 100 }],
    );
    expect(text).toContain("3 days against a target of 3");
    expect(text).toContain("2026-01-20");
    expect(text).toContain("Rewrite the welcome email");
    expect(text).toContain("1 linked task still open");
    // The one thing the record cannot answer is left as a prompt rather than filled in.
    expect(text).toContain("What I would do differently");
  });

  it("says the percentage plainly for a goal with no measure", () => {
    const text = retroSeed({ status: "completed", progress: 60 }, [], []);
    expect(text.split("\n")[0]).toBe("Finished at 60%.");
  });
});
