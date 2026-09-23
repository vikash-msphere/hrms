/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

// Three tables have to agree about which routes open a specific RECORD, and nothing held them together.
//
//   - `App.tsx` decides it, by passing `openId={route.id}` to a page.
//   - `lib/resourceRoute.ts#DEEP_OPEN` is where the activity feed, the approvals inbox and search look it up
//     when they turn a record ref into a hash route.
//   - a page absent from DEEP_OPEN falls through to `PAGE_OF` (the list page) or, if it is in neither, to
//     `null` - no link at all.
//
// Nothing breaks when they drift: the reader just lands one level too shallow, or gets no destination. That is
// exactly the kind of miss nobody files a bug for, so it is asserted here instead. A source scan rather than a
// rendered test on purpose - what is being checked is that the two tables name the same set.
const source = (glob: Record<string, string>, suffix: string): string => {
  const hit = Object.entries(glob).find(([path]) => path.endsWith(suffix));
  if (!hit) throw new Error(`deepOpenRoutes: ${suffix} not found - was it renamed?`);
  return hit[1];
};

const appSource = (): string =>
  source(import.meta.glob("../web/src/App.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>, "/App.tsx");

const routeSource = (): string =>
  source(
    import.meta.glob("../web/src/lib/resourceRoute.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>,
    "/resourceRoute.ts",
  );

/** Page keys whose `case` in App.tsx renders a component taking `openId`. */
function openIdRoutes(src: string): string[] {
  const keys: string[] = [];
  let pending: string | null = null;
  for (const line of src.split("\n")) {
    const label = /^\s*case "([^"]+)":/.exec(line);
    if (label) {
      pending = label[1]!;
      continue;
    }
    if (pending && /\bopenId=\{route\.id/.test(line)) keys.push(pending);
    if (/\breturn\b/.test(line)) pending = null;
  }
  return [...new Set(keys)];
}

/** The page keys DEEP_OPEN maps its collections onto. */
function deepOpenPages(src: string): Set<string> {
  const block = /const DEEP_OPEN: Record<string, string> = \{([\s\S]*?)\n\};/.exec(src);
  if (!block) throw new Error("deepOpenRoutes: DEEP_OPEN table not found - was it renamed?");
  return new Set([...block[1]!.matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]!));
}

describe("every route that opens a record is reachable as one", () => {
  it("finds the routes at all (the scan itself must not silently match nothing)", () => {
    expect(openIdRoutes(appSource()).length).toBeGreaterThan(15);
    expect(deepOpenPages(routeSource()).size).toBeGreaterThan(15);
  });

  it("every openId-taking route in App.tsx has a DEEP_OPEN entry pointing at it", () => {
    const pages = deepOpenPages(routeSource());
    // `payroll-runs` is the one deliberate exception: its first route segment is a TAB name, not an id (it
    // predates deep-opening), so a record link there is `payroll-runs/<tab>/<id>` and cannot be expressed as a
    // DEEP_OPEN page. `pay-periods` renders PayrollRuns and is the same route.
    const EXEMPT = new Set(["pay-periods"]);
    const missing = openIdRoutes(appSource()).filter((k) => !EXEMPT.has(k) && !pages.has(k));
    expect(missing).toEqual([]);
  });
});
