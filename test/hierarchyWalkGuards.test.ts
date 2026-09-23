/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";

// A WALK UP A PARENT CHAIN MUST TERMINATE ON DATA THAT CYCLES.
//
// The org chart walks `parentId` upward in three places - to force a match's ancestors open, to reveal a
// focused node, and to build the focus spine. Two of them carry a cycle guard (`!trail.includes(p)`); the
// third does not, and it runs inside a `useMemo` during render, so a cycle in the data is a frozen tab rather
// than a slow one.
//
// This is reachable because nothing refuses to WRITE the cycle. The department hierarchy is guarded server
// side - services/codeCascade.ts:266-270 refuses a self-parent and refuses a move under a descendant - but
// the employee MANAGER hierarchy is not: services/employees.ts:271 is a bare `set.managerId = ...`. The
// manager pickers in Directory.tsx and EmployeeProfile.tsx exclude only self, so pointing A's manager at A's
// own report takes one ordinary edit. See test/employeeManagerCycle.test.ts for the write-side half.
//
// So this asserts the client half: whatever the data does, the walk ends. A guard in the loop condition is
// cheap and the failure without one is total.
const sources = import.meta.glob("../web/src/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** What counts as a terminating guard: a visited set/list, or a bounded counter. */
const GUARD = /includes\(|\.has\(|seen|visited|depth|CAP|<\s*\w+/;

type Walk = { file: string; line: number; condition: string; guarded: boolean };

function parentWalks(): Walk[] {
  const out: Walk[] = [];
  for (const [path, src] of Object.entries(sources)) {
    const file = path.replace(/^.*\/web\/src\//, "web/src/");
    const lines = src.split("\n");
    lines.forEach((text, i) => {
      const m = text.match(/while\s*\(([^)]*)\)/);
      if (!m) return;
      // The step is on the condition line or just below it, so look at a small window rather than parsing.
      if (!/parentId/.test(lines.slice(i, i + 3).join(" "))) return;
      out.push({ file, line: i + 1, condition: m[1]!.trim(), guarded: GUARD.test(m[1]!) });
    });
  }
  return out;
}

describe("hierarchy walks terminate on cyclic data", () => {
  const walks = parentWalks();

  it("finds the walks (so a refactor cannot empty this suite)", () => {
    expect(walks.length).toBeGreaterThan(0);
    expect(walks.some((w) => w.file.endsWith("pages/OrgChart.tsx"))).toBe(true);
  });

  it("every `parentId` walk carries a cycle guard in its condition", () => {
    const unguarded = walks.filter((w) => !w.guarded).map((w) => `${w.file}:${w.line}  while (${w.condition})`);
    expect(unguarded).toEqual([]);
  });
});
