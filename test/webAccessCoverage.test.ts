/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";

// Access-affordance coverage gate for the web UI. The manage-access model is ambient (AccessScope +
// shared primitives), but bare pages and hand-rolled action buttons must opt in explicitly - and that
// convention regressed silently before this gate existed. Two mechanical rules (heuristic on source text,
// deliberately file-granular so it stays robust to formatting):
//
//  1. Every page component references at least one access affordance (its own, or a scoped shared
//     primitive), so no page ships with zero manage-access surface.
//  2. Every file that calls the custom-method API (`invoke(` / `upload(`) also references AccessAction or
//     RowActions - i.e. its verb buttons carry (or sit next to) a manage-access target.
//
// If a file is a genuine exception, add it to the allowlist WITH the reason.
const pages = import.meta.glob("../web/src/pages/**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const common = import.meta.glob("../web/src/components/common/**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const AFFORDANCE = /AccessScope|AccessItem|AccessAction|AccessTab|AccessTarget|FieldAccess|accessCollection/;
const VERB_CALL = /\b(?:invoke|upload)\(/;
const VERB_MARK = /AccessAction|RowActions/;

// path suffix -> reason. Empty today; keep it that way unless a file truly manages no grantable resource.
const PAGE_ALLOW: Record<string, string> = {};
const VERB_ALLOW: Record<string, string> = {};

const allowed = (path: string, allow: Record<string, string>) => Object.keys(allow).some((suffix) => path.endsWith(suffix));

describe("web access-affordance coverage", () => {
  it("every page references an access affordance", () => {
    const misses = Object.entries(pages)
      .filter(([p, src]) => !allowed(p, PAGE_ALLOW) && !AFFORDANCE.test(src))
      .map(([p]) => p);
    expect(misses, `pages with no manage-access surface: ${misses.join(", ")}`).toEqual([]);
  });

  it("every file calling invoke()/upload() carries an AccessAction/RowActions mark", () => {
    const misses = Object.entries({ ...pages, ...common })
      .filter(([p, src]) => !allowed(p, VERB_ALLOW) && VERB_CALL.test(src) && !VERB_MARK.test(src))
      .map(([p]) => p);
    expect(misses, `verb calls without a manage-access mark: ${misses.join(", ")}`).toEqual([]);
  });
});
