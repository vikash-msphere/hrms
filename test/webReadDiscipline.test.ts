/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";

// Read discipline in the SPA. Cloudflare bills D1 by rows read and Workers by request, so what the client asks
// for IS the bill. Two habits used to leak through review, and both are cheap to check by name:
//
//   1. reading one settings blob per consumer (`get("settings/<key>")`). A page consulting three keys made three
//      requests, each answered by a scan of the same tiny table. Everything goes through the shared snapshot in
//      lib/settingsStore.ts instead - one read of `GET /v1/settings` serves every key on the page.
//   2. reading a whole collection through `get("<collection>?...")` instead of the resource store, which bypasses
//      in-flight dedup, the freshness tiers and the disk cache - so two components asking for the same rows pay
//      twice.
//
// Both rules have real exceptions, listed (with the reason) below. An exception is a claim that this call must
// not be shared; adding one is a decision, not a formality.
const web = {
  ...(import.meta.glob("../web/src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>),
  ...(import.meta.glob("../web/src/**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>),
};

const rel = (p: string) => p.replace("../web/src/", "");

// ---- 1. settings ---------------------------------------------------------------------------------------------
const SETTINGS_READ = /\bget<[^(]*>\(\s*[`"]settings\//g;
// path suffix -> why this one reads the row itself.
const SETTINGS_ALLOW: Record<string, string> = {
  "pages/PayslipDesignTab.tsx": "needs the row's etag for optimistic concurrency on save, which the snapshot drops",
};

// ---- 2. collections ------------------------------------------------------------------------------------------
// A collection read looks like get<…>("<collection>?…") or get<…>(`<collection>?…`) - a bare `get("thing/id")`
// (one record) is fine and common.
const COLLECTION_READ = /\bget<[^(]*>\(\s*[`"]([a-z][a-z0-9-]*)\?/g;
// collection -> why reading it outside the store is right. These are all NARROWED reads (a server-side filter
// the store's snapshot doesn't model) or one-shot payloads nothing else shares.
const COLLECTION_ALLOW: Record<string, string> = {
  activity: "per-resource audit feed, opened on demand; never a shared collection view",
  "interview-feedback": "narrowed to one interview - a scorecard is read where it is shown",
  interviews: "narrowed to one application (the pipeline drawer)",
  offers: "narrowed to one application (the pipeline drawer)",
  "shift-assignments": "narrowed to the week on screen",
  "time-entries": "narrowed to one employee/status for the timesheet being edited",
  "leave-requests": "conflict check for one interview slot; a page-wide view would not answer it",
  events: "conflict check for one interview slot",
  reviews: "cycle progress roll-up, paged through to completion",
  goals: "the calibration panel's attainment curve: narrowed to one cycle, asks for a single row, and exists FOR the aggregate the server computes alongside it (`?burnup=true`) - the store's snapshot models neither",
  notifications: "the snoozed view is the INVERSE of the cached feed; fetched once, only when it is opened",
  // The employee-profile panels: each is narrowed to ONE employee and mounted only when its tab is opened, so
  // there is no page-wide snapshot to share (and the profile is the only place they are read).
  assets: "narrowed to one employee's kit, on the profile's Assets tab",
  "asset-requests": "narrowed to one employee, on the profile's Assets tab",
  bonuses: "narrowed to one employee, on the profile's pay panels",
  compensation: "narrowed to one employee's compensation history",
  positions: "narrowed to one employee's role history",
  settlements: "narrowed to one employee's final settlement",
  // Aggregate transports own no rows: they ARE the cheap read (a count, not a collection).
  "dashboard-summary": "aggregate KPI counts, not a collection",
  "people-analytics": "the per-person report: one aggregate over a window the page chooses, not a collection - this read EXISTS to stop the page fetching eight collections to compute it",
  "activity-counts": "tab-bar \"new since last seen\" counts, not a collection - this read EXISTS to stop the badges fetching collections",
  "table-fields": "the custom-grid field catalogue for ONE base, assembled per caller from the schema + org config; it owns no rows and is read only while a table is being built",
};

// ---- 3. preferences ------------------------------------------------------------------------------------------
// Preferences are the most-WRITTEN thing in the app (the tab-seen map advances on every navigation) and, before
// the shared snapshot, the most-read. Both halves have to go through lib/prefs.ts: a direct `patch("preferences/
// <key>")` is a request per interaction, and a direct `get("preferences/<key>")` is a request per blob.
const PREFS_DIRECT = /\b(?:get|patch)\(\s*[`"]preferences\//g;

describe("SPA read discipline", () => {
  it("reads and writes preferences through the shared store, never row by row", () => {
    const offenders: string[] = [];
    for (const [path, src] of Object.entries(web)) {
      if (rel(path) === "lib/prefs.ts") continue;
      for (const m of src.matchAll(PREFS_DIRECT)) offenders.push(`${rel(path)}: ${m[0].trim()}`);
    }
    expect(offenders, `direct preference row access (use readPref / writePref / writePrefDeferred):\n${offenders.join("\n")}`).toEqual([]);
  });

  it("reads org settings through the shared snapshot, not one request per key", () => {
    const offenders: string[] = [];
    for (const [path, src] of Object.entries(web)) {
      if (rel(path) === "lib/settingsStore.ts") continue;
      if (Object.keys(SETTINGS_ALLOW).some((suffix) => path.endsWith(suffix))) continue;
      for (const m of src.matchAll(SETTINGS_READ)) offenders.push(`${rel(path)}: ${m[0].trim()}`);
    }
    expect(offenders, `per-key settings reads (use readSetting/getSetting from lib/settingsStore):\n${offenders.join("\n")}`).toEqual([]);
  });

  it("reads collections through the resource store unless the read is deliberately narrowed", () => {
    const offenders: string[] = [];
    for (const [path, src] of Object.entries(web)) {
      if (rel(path).startsWith("lib/resourceStore") || rel(path) === "api.ts") continue;
      for (const m of src.matchAll(COLLECTION_READ)) {
        const collection = m[1]!;
        if (COLLECTION_ALLOW[collection]) continue;
        offenders.push(`${rel(path)}: ${collection}`);
      }
    }
    expect(offenders, `unshared collection reads (use useCollection so they dedupe + cache):\n${offenders.join("\n")}`).toEqual([]);
  });

  // A BADGE MUST NOT FETCH A COLLECTION. The workspace tab bar counts "new since you last looked" for every
  // sibling tab, and it used to answer that by fetching each of those collections and counting rows - so
  // opening one page of a six-tab workspace read six pages of rows to render six small numbers, on every
  // navigation. It asks the server for counts now (GET /v1/activity-counts, one request for the whole bar).
  // The regression is a single import away, so it is named here rather than left to review.
  it("the tab-activity badges never fetch a collection", () => {
    const src = Object.entries(web).find(([p]) => rel(p) === "lib/tabActivity.ts")?.[1] ?? "";
    expect(src, "lib/tabActivity.ts not found - did it move?").not.toBe("");
    expect(src.includes("ensureFetch"), "tabActivity must not fetch collections: badges come from /v1/activity-counts, and cached rows only for FILTERED sub-tabs").toBe(false);
    expect(src.includes("activity-counts"), "tabActivity should be asking the server for its counts").toBe(true);
  });

  it("has no dead allowlist entries", () => {
    const paths = Object.keys(web);
    const deadFiles = Object.keys(SETTINGS_ALLOW).filter((suffix) => !paths.some((p) => p.endsWith(suffix)));
    expect(deadFiles, `allowlisted files that no longer exist: ${deadFiles.join(", ")}`).toEqual([]);
    const seen = new Set<string>();
    for (const src of Object.values(web)) for (const m of src.matchAll(COLLECTION_READ)) seen.add(m[1]!);
    const deadCollections = Object.keys(COLLECTION_ALLOW).filter((c) => !seen.has(c));
    expect(deadCollections, `allowlisted collections nothing reads any more: ${deadCollections.join(", ")}`).toEqual([]);
  });
});
