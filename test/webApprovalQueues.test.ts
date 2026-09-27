/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";

// The approvals badge is a server-side COUNT (GET /v1/approvals-summary); the approval collections' ROWS are
// read only for the routes that render them, listed in QUEUES_BY_ROUTE (web/src/App.tsx). That map is the thing
// that can rot: add a bucket to a page and forget the map, and the page silently shows an empty queue - the
// exact bug the old "read all ten on every page" shape could not have.
//
// So: read what each page actually consumes off useApprovals(), map it back to the routes that render that
// page, and require the map to cover it. Deliberately textual - a page reads buckets by name, and a name is
// what this can check.
const app = (import.meta.glob("../web/src/App.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>)["../web/src/App.tsx"]!;
const pages = import.meta.glob("../web/src/pages/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

// Bucket name on the approvals state -> the queue it is fetched from.
const BUCKET_QUEUE: Record<string, string> = {
  leaves: "leave-requests",
  reimbs: "reimbursements",
  overtimes: "overtime-requests",
  remotes: "remote-work-requests",
  lateEarlies: "late-early-requests",
  regularizations: "attendance-regularizations",
  encashments: "leave-encashments",
  loans: "loans",
  timeEntries: "time-entries",
  expenses: "expenses",
  assetRequests: "asset-requests",
  taxVerifications: "tax-verifications",
};
// Fields that need no rows: the server answers them, or they act on rows the page already has.
// Fields of the approvals context that are not a queue of rows, so reading one implies no list read.
// `loading` / `error` are the state of the queues the route already asked for, not a queue of their own -
// they are what let the page tell an empty inbox from an unread one from a failed one.
const ROWLESS = new Set(["total", "counts", "reload", "history", "loading", "error"]);

const ALL_COLLECTION_QUEUES = Object.values(BUCKET_QUEUE).filter((q) => q !== "tax-verifications");

// The map, parsed out of App.tsx. `ALL_QUEUES` / `APPROVAL_COLLECTIONS` are the two symbolic values it uses.
function queuesByRoute(): Record<string, string[]> {
  const start = app.indexOf("const QUEUES_BY_ROUTE");
  const end = app.indexOf("\n};", start);
  expect(start, "QUEUES_BY_ROUTE not found in App.tsx").toBeGreaterThan(0);
  const block = app.slice(start, end);
  const out: Record<string, string[]> = {};
  for (const m of block.matchAll(/^\s*(?:"([^"]+)"|([A-Za-z][\w-]*)):\s*(.+?),\s*(?:\/\/.*)?$/gm)) {
    const route = m[1] ?? m[2]!;
    const value = m[3]!;
    if (value.includes("ALL_QUEUES")) out[route] = [...ALL_COLLECTION_QUEUES, "tax-verifications"];
    else if (value.includes("APPROVAL_COLLECTIONS")) out[route] = [...ALL_COLLECTION_QUEUES];
    else out[route] = [...value.matchAll(/"([^"]+)"/g)].map((q) => q[1]!);
  }
  return out;
}

// route key -> the page components that route can render (a route with an :id renders a detail page too).
function routeComponents(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const m of app.matchAll(/case "([^"]+)":\s*\n?\s*return ([^\n]+)/g)) {
    out[m[1]!] = [...m[2]!.matchAll(/<([A-Z]\w+)/g)].map((c) => c[1]!);
  }
  return out;
}

// Which approval buckets a page source reads - `approvals.leaves`, or a destructure of useApprovals().
function bucketsUsed(src: string): string[] {
  const used = new Set<string>();
  for (const m of src.matchAll(/\bapprovals\.([A-Za-z]\w*)/g)) used.add(m[1]!);
  for (const m of src.matchAll(/const\s*\{([^}]*)\}\s*=\s*useApprovals\(\)/g)) {
    for (const name of m[1]!.split(",")) {
      const n = name.split(":")[0]!.trim();
      if (n) used.add(n);
    }
  }
  return [...used].filter((n) => !ROWLESS.has(n));
}

describe("approval queue rows are fetched for the routes that render them", () => {
  it("every bucket a page reads is a queue its route asked for", () => {
    const map = queuesByRoute();
    const components = routeComponents();
    const misses: string[] = [];
    for (const [path, src] of Object.entries(pages)) {
      const component = path.split("/").pop()!.replace(".tsx", "");
      const buckets = bucketsUsed(src);
      if (!buckets.length) continue;
      const routes = Object.entries(components).filter(([, comps]) => comps.includes(component)).map(([r]) => r);
      expect(routes, `no route in App.tsx renders ${component}, which reads approval buckets`).not.toEqual([]);
      for (const route of routes) {
        const asked = map[route] ?? [];
        for (const bucket of buckets) {
          const queue = BUCKET_QUEUE[bucket];
          if (!queue) {
            misses.push(`${component}: unknown approvals field "${bucket}"`);
          } else if (!asked.includes(queue)) {
            misses.push(`route "${route}" renders ${component} which reads ${bucket}, but QUEUES_BY_ROUTE omits "${queue}"`);
          }
        }
      }
    }
    expect(misses, misses.join("\n")).toEqual([]);
  });

  it("the map asks for nothing no page reads (a queue nobody renders is a wasted list read)", () => {
    const map = queuesByRoute();
    const components = routeComponents();
    const extra: string[] = [];
    for (const [route, queues] of Object.entries(map)) {
      const needed = new Set(
        (components[route] ?? []).flatMap((component) => {
          const src = pages[`../web/src/pages/${component}.tsx`];
          return src ? bucketsUsed(src).map((b) => BUCKET_QUEUE[b]!) : [];
        }),
      );
      for (const q of queues) if (!needed.has(q)) extra.push(`route "${route}" fetches "${q}" but no page it renders reads it`);
    }
    expect(extra, extra.join("\n")).toEqual([]);
  });
});
