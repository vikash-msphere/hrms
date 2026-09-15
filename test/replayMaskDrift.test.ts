/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { REDACTED_FIELDS } from "../src/domain/manifests";

// REPLAY MASKING, DERIVED RATHER THAN REMEMBERED.
//
// test/replayMaskCoverage.test.ts asserts a hand-written list of components that must carry `sentry-mask`. A
// list like that cannot fail for a component nobody put on it, and its own comment says why that matters:
// "Per-dialog means someone has to remember, which is exactly the kind of thing that gets forgotten in a
// refactor and fails SILENTLY". lib/resourceStore.ts:73-78 records the identical trap catching MEMORY_ONLY
// itself - "the test that pins this set asserts a hand-written allowlist, so nothing caught it".
//
// So this one runs the other way round. The app already maintains the judgement, for a different reason:
// MEMORY_ONLY (lib/resourceStore.ts) is the set of collections whose rows may never be written to disk,
// because they are "a copy of the most sensitive data the system holds, in plaintext, on a machine the org may
// not own". Session replay ships the same data one hop further - to a third party, with retention - so the two
// sets should agree. Where they disagree, somebody decided a collection was too sensitive to store and nobody
// decided it was too sensitive to record.
//
// This walks MEMORY_ONLY, finds every component that renders each collection, and requires a mask attribute in
// the file or a SENSITIVE_PAGES route around it. It fails on additions to EITHER list, which is the property
// the enumerating test cannot have.
//
// AND IT RUNS IN BOTH DIRECTIONS, which it did not. Asserting only "every MEMORY_ONLY collection is masked"
// leaves the converse - every collection judged too sensitive to RECORD must also be too sensitive to STORE -
// unguarded, and that is exactly where the two lists had come apart: `reviews`, `check-ins` and `suggestions`
// were on SENSITIVE_PAGES with reasons written out, and persistable to IndexedDB for seven days. The second
// half is the `SENSITIVE_PAGES minus MEMORY_ONLY` assertion at the bottom of this file.
const web = import.meta.glob("../web/src/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const rel = (path: string) => path.replace(/^.*\/web\/src\//, "web/src/");
const read = (suffix: string): string => {
  const hit = Object.entries(web).find(([p]) => p.endsWith(suffix));
  if (!hit) throw new Error(`replayMaskDrift: ${suffix} not found - was it renamed?`);
  return hit[1];
};

/** The two lists, parsed from their own source so neither can be restated (and drift) here. */
const setLiteral = (src: string, name: string, open: string): string[] => {
  const body = src.match(new RegExp(`const ${name} = ${open}([\\s\\S]*?)\\]`))?.[1];
  if (!body) throw new Error(`replayMaskDrift: could not parse ${name}`);
  return [...body.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]!);
};
const MEMORY_ONLY = setLiteral(read("/lib/resourceStore.ts"), "MEMORY_ONLY", "new Set\\(\\[");
const SENSITIVE_PAGES = setLiteral(read("/instrument.ts"), "SENSITIVE_PAGES", "\\[");

/**
 * Surfaces that render a MEMORY_ONLY collection but are deliberately not masked. Each entry is a JUDGEMENT,
 * so each carries its reason - and the default for anything not listed is "must be masked", which is the
 * direction that fails closed.
 */
const EXEMPT: Record<string, string> = {
  "web/src/pages/RecruitingAnalytics.tsx":
    "aggregates only - funnel counts and conversion rates, no candidate or offer row is rendered",
  "web/src/pages/PayGradesAdmin.tsx":
    "salary BANDS are org policy, not any individual's pay - the same 'ordinary business data' carve-out instrument.ts states",
  "web/src/pages/SalaryStructuresAdmin.tsx": "structure definitions (which components apply), not anyone's figures",
  "web/src/pages/Requisitions.tsx": "the grade band attached to an open role, not a person's pay",
  "web/src/components/common/PayrollBonuses.tsx":
    "mounts inline at PayrollRuns.tsx:578, and `payroll-runs` IS a SENSITIVE_PAGES route, so the route mask reaches it",
  "web/src/pages/BankFormats.tsx":
    "bank FORMAT templates (which column holds what in a bank's bulk-payment file) - org config, not anyone's account number",
  "web/src/components/common/GenerateLetterDialog.tsx":
    "reads `personal-documents` only to spot a duplicate letter, and renders the document's NAME; the letter itself renders in an <iframe>, which instrument.ts blocks outright",
};

// KNOWN BLIND SPOT, stated rather than papered over: this scans pages and components, so a collection fetched
// by a PROVIDER in web/src/lib and rendered by a page is not attributed to that page. `lib/approvals.tsx`
// reads `tax-verifications` and hands the rows to pages/Approvals.tsx, which renders each person's
// prior-employer income and TDS; that queue and the shared ApprovalRow summary line both carry
// `data-sentry-mask`, but by review rather than because this test required it. Widening the scan to lib/ would
// need provider-to-consumer attribution, so anything reaching a page that way is still uncovered here.

const kebab = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

/**
 * The ways a component gets a collection's rows. Not every render goes through the store: `MyCompensation`
 * walks the cursor with `getAllPages`, and the approvals provider reads the tax queue with a bare `get`. A
 * detector that only knew `useCollection` would miss exactly the surfaces that bypassed it.
 */
const READS = (c: string): RegExp[] => [
  new RegExp(`useCollection<[^>]+>\\("${c}"`),
  new RegExp(`(?:getAllPages|list|listAll|get)<[^>]*>\\(\\s*[\`"']${c}[\`"'?/]`),
];

type Surface = { file: string; collection: string; masked: boolean; routeMasked: boolean };

function surfaces(): Surface[] {
  const out: Surface[] = [];
  for (const [path, src] of Object.entries(web)) {
    if (!/\.tsx$/.test(path) || !/\/(pages|components)\//.test(path)) continue;
    const file = rel(path);
    const masked = /sentry-mask|sentry-block/.test(src);
    const base = path.split("/").pop()!.replace(/\.tsx$/, "");
    const routeMasked = path.includes("/pages/") && SENSITIVE_PAGES.includes(kebab(base));
    for (const collection of MEMORY_ONLY) {
      if (READS(collection).some((re) => re.test(src))) out.push({ file, collection, masked, routeMasked });
    }
  }
  return out;
}

/**
 * SENSITIVE_PAGES entries that are ROUTE names rather than collection names, so the converse assertion cannot
 * look them up directly. Each says which collections the route actually renders and where they stand.
 */
const ROUTE_ONLY: Record<string, string> = {
  documents:
    "a page name, not a collection: it renders `personal-documents` (in MEMORY_ONLY) and `org-documents`, which is org-wide policy material rather than anyone's record and is deliberately cacheable",
};

describe("session replay: MEMORY_ONLY collections are masked wherever they render", () => {
  it("parses both lists (so a rename cannot empty this suite)", () => {
    expect(MEMORY_ONLY).toContain("compensation");
    expect(MEMORY_ONLY).toContain("api-keys");
    expect(SENSITIVE_PAGES).toContain("payslips");
  });

  it("finds the surfaces that render them", () => {
    expect(surfaces().length).toBeGreaterThan(5);
  });

  it("every surface is masked, on a masked route, or exempt with a stated reason", () => {
    const gaps = surfaces()
      .filter((s) => !s.masked && !s.routeMasked && !EXEMPT[s.file])
      .map((s) => `${s.file} renders "${s.collection}" unmasked`);
    // Sorted + de-duplicated so the failure reads as a work list rather than a pile.
    expect([...new Set(gaps)].sort()).toEqual([]);
  });

  it("every collection too sensitive to RECORD is also too sensitive to STORE", () => {
    // The converse of the walk above, and the half that was missing. Replay ships a collection's values to a
    // third party with retention; IndexedDB writes them to the reader's own disk for up to MAX_AGE_MS.rows.
    // A collection judged too sensitive for the first and left persistable for the second is a decision
    // nobody made - it is a decision one list recorded and the other never heard about.
    const gaps = SENSITIVE_PAGES.filter((c) => !MEMORY_ONLY.includes(c) && !ROUTE_ONLY[c]);
    expect(gaps, "masked from session replay but written to disk - add to MEMORY_ONLY, or to ROUTE_ONLY with the reason").toEqual([]);
  });

  it("every route-only exception still names a SENSITIVE_PAGES entry", () => {
    expect(Object.keys(ROUTE_ONLY).filter((c) => !SENSITIVE_PAGES.includes(c))).toEqual([]);
  });

  it("every exemption still names a file that exists and still renders such a collection", () => {
    // An exemption that has outlived its file is a hole nobody can see. Keep the table honest.
    const rendered = new Set(surfaces().map((s) => s.file));
    expect(Object.keys(EXEMPT).filter((f) => !rendered.has(f))).toEqual([]);
  });
});

// THE SECOND REGISTRY, WALKED THE SAME WAY.
//
// MEMORY_ONLY judges whole COLLECTIONS. domain/manifests.ts REDACTED_FIELDS judges single FIELDS - the list of
// values that are "genuinely a different sensitivity from the row they sit on - money, personal contact
// details, free text about a person", each with the reason written beside it. That is the same judgement the
// walk above runs on, one level finer, and the app was already acting on it in three of four cases by memory
// rather than by derivation: offers sat behind a SENSITIVE_PAGES route, candidates and leave reasons carried
// `data-sentry-mask`, and `tickets: ["description"]` carried nothing at all - on the one page that
// deliberately attaches replays. Nothing could have failed, because nothing was asking.
//
// So this asks. For every `<collection>: [<field>]` entry, any page or component that reads the collection AND
// names the field must mask, sit on a masked route, or be exempt with its reason. The registry is IMPORTED,
// not restated, so adding a field to it is what adds the requirement.
const fieldSurfaces = () => {
  const out: { file: string; entry: string; masked: boolean; routeMasked: boolean }[] = [];
  for (const [path, src] of Object.entries(web)) {
    if (!/\.tsx$/.test(path) || !/\/(pages|components)\//.test(path)) continue;
    const base = path.split("/").pop()!.replace(/\.tsx$/, "");
    const routeMasked = path.includes("/pages/") && SENSITIVE_PAGES.includes(kebab(base));
    for (const [collection, fields] of Object.entries(REDACTED_FIELDS)) {
      if (!READS(collection).some((re) => re.test(src))) continue;
      // The field has to be NAMED in the file, not merely reachable through it: a page that lists leave dates
      // without ever touching `.reason` is not a surface for it, and demanding a mask there would teach the
      // next reader that the attribute is decoration.
      for (const field of fields) {
        if (new RegExp(`\\.${field}\\b`).test(src)) out.push({ file: rel(path), entry: `${collection}.${field}`, masked: /sentry-mask|sentry-block/.test(src), routeMasked });
      }
    }
  }
  return out;
};

/** Keyed `<file> <collection>.<field>`, so an exemption covers one field on one surface and not a whole page. */
const FIELD_EXEMPT: Record<string, string> = {
  "web/src/pages/LeaveCalendar.tsx leave-requests.reason":
    "copies `reason` onto the calendar entry and never renders it - the only other mention in the file is the .ics exporter deliberately leaving it out (LeaveCalendar.tsx:369)",
};

describe("session replay: REDACTED_FIELDS values are masked wherever they render", () => {
  it("parses the registry (so an empty import cannot empty this suite)", () => {
    expect(Object.keys(REDACTED_FIELDS)).toContain("tickets");
    expect(REDACTED_FIELDS["leave-requests"]).toContain("reason");
    expect(fieldSurfaces().length).toBeGreaterThan(5);
  });

  it("every surface is masked, on a masked route, or exempt with a stated reason", () => {
    const gaps = fieldSurfaces()
      .filter((s) => !s.masked && !s.routeMasked && !FIELD_EXEMPT[`${s.file} ${s.entry}`])
      .map((s) => `${s.file} renders "${s.entry}" unmasked`);
    expect([...new Set(gaps)].sort()).toEqual([]);
  });

  it("every field exemption still names a surface that exists", () => {
    const live = new Set(fieldSurfaces().map((s) => `${s.file} ${s.entry}`));
    expect(Object.keys(FIELD_EXEMPT).filter((k) => !live.has(k))).toEqual([]);
  });
});
