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
const access = import.meta.glob("../web/src/components/{access,assets,layout,workflows,holidays}/**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
// The router and the nav table, read as text: the route gate below is a drift check between the two.
const app = import.meta.glob("../web/src/App.tsx", { query: "?raw", import: "default", eager: true })["../web/src/App.tsx"] as string;
const nav = import.meta.glob("../web/src/nav.ts", { query: "?raw", import: "default", eager: true })["../web/src/nav.ts"] as string;

const AFFORDANCE = /AccessScope|AccessItem|AccessAction|AccessTab|AccessTarget|FieldAccess|accessCollection/;
const VERB_CALL = /\b(?:invoke|upload)\(/;
const VERB_MARK = /AccessAction|RowActions/;

// path suffix -> reason. Empty today; keep it that way unless a file truly manages no grantable resource.
const PAGE_ALLOW: Record<string, string> = {
  // `/profile` and `/employees/<id>` are ONE page now (pages/EmployeeProfile.tsx), which carries every
  // affordance and binds its own `<AccessScope>` so both addresses target the same record. What is left here
  // is the address plus the one case that never reaches that page: an account with no employee record, which
  // has no subject for an affordance to be about.
  "pages/Profile.tsx": "a thin route wrapper around EmployeeProfile, which carries the affordances",
};
const VERB_ALLOW: Record<string, string> = {
  // "Who can see my record": the ONE verb in the app that is deliberately not an admin affordance. It reports
  // on the caller's OWN record - the service pins the target to their employee id, so the path id never
  // chooses whose record is graded - and every role holds it for themselves (`employees.me.viewers`). Wrapping
  // it in AccessAction would offer to manage a permission that is not meant to be taken away: a person being
  // able to find out who reads their bank details is the feature, not a grant.
  "components/common/MyViewers.tsx": "self-only privacy report; held by everyone for their own record by design",
};
// Per-object affordances whose object was never fetched as a row, so there IS no `access.can` to pass: the
// path is known (it makes a good ACL target) but the hint is not, and the gate falls back to the caller's
// capability. Add a file here only when the object genuinely never arrives as a resource in that view.
// Per-record panels with no grantable resource of their own. A panel about ONE employee is the unit an admin
// grants, so it needs its own key: the tab it sits under names a single collection, and a merged tab holds
// several - Performance is goals + cards + reviews, Posts is announcements + suggestions - so an admin asked
// for sight of somebody's reviews would open the only key on screen and grant goals. Both shipped without one.
const PANEL_ALLOW: Record<string, string> = {
  "components/common/EmployeePicker.tsx": "a form control for choosing a person; it manages no resource of its own",
};
const CAN_ALLOW: Record<string, string> = {
  "pages/Operations.tsx": "cron/queue job rows are audit records, not resources - they carry no access hint",
  "pages/PayslipDesignTab.tsx": "the target is the settings/payslip blob, edited in place, never listed as a row",
  "pages/Documents.tsx": "a signed copy is named by the acknowledgement row; that personal-document is never itself fetched",
  "components/common/PhotoAvatar.tsx": "the avatar knows an employee id, not the employee resource",
};

const allowed = (path: string, allow: Record<string, string>) => Object.keys(allow).some((suffix) => path.endsWith(suffix));

describe("web access-affordance coverage", () => {
  it("every page references an access affordance", () => {
    const misses = Object.entries(pages)
      .filter(([p, src]) => !allowed(p, PAGE_ALLOW) && !AFFORDANCE.test(src))
      .map(([p]) => p);
    expect(misses, `pages with no manage-access surface: ${misses.join(", ")}`).toEqual([]);
  });

  it("every per-record employee panel references an access affordance", () => {
    const misses = Object.entries(common)
      .filter(([p]) => /\/Employee[A-Z][A-Za-z]*\.tsx$/.test(p))
      .filter(([p, src]) => !allowed(p, PANEL_ALLOW) && !AFFORDANCE.test(src))
      .map(([p]) => p);
    expect(misses, `per-record panels with no manage-access key of their own: ${misses.join(", ")}`).toEqual([]);
  });

  it("every file calling invoke()/upload() carries an AccessAction/RowActions mark", () => {
    const misses = Object.entries({ ...pages, ...common })
      .filter(([p, src]) => !allowed(p, VERB_ALLOW) && VERB_CALL.test(src) && !VERB_MARK.test(src))
      .map(([p]) => p);
    expect(misses, `verb calls without a manage-access mark: ${misses.join(", ")}`).toEqual([]);
  });

  // An affordance for a verb ON ONE ROW must hand AccessAction that row's `access.can`: that hint is what the
  // gate answers from, and without it the check falls back to the caller's collection-wide capability - which
  // says nothing about THIS object. (A collection-level action has no row and correctly passes no hint.)
  it("every per-object verb affordance passes the row's `can` hint", () => {
    const misses: string[] = [];
    for (const [p, src] of Object.entries({ ...pages, ...common, ...access })) {
      if (allowed(p, CAN_ALLOW)) continue;
      for (const tag of src.match(/<AccessAction[^>]*>/g) ?? []) {
        if (!/\bverb=/.test(tag) || !/\bobjectPath=/.test(tag) || /\bcan=/.test(tag)) continue;
        misses.push(`${p}: ${tag.slice(0, 120)}`);
      }
    }
    expect(misses, `per-object verb affordances with no can hint:\n${misses.join("\n")}`).toEqual([]);
  });

  // A permission answer belongs in the render decision, not in `disabled`: an action the caller may never
  // perform must be absent, not present-and-greyed. (`disabled` stays right for STATE - busy, invalid, a
  // locked row - which is why only the capability/can shapes are banned here.)
  it("no action is merely disabled by a permission check", () => {
    const banned = /disabled=\{[^}]*(?:can\??\.includes\(|hasCapability\(|usePermission\()/;
    const misses = Object.entries({ ...pages, ...common, ...access })
      .flatMap(([p, src]) => src.split("\n").map((l, i) => [p, i + 1, l] as const).filter(([, , l]) => banned.test(l)))
      .map(([p, n, l]) => `${p}:${n}: ${l.trim().slice(0, 120)}`);
    expect(misses, `permission expressed as disabled instead of hidden:\n${misses.join("\n")}`).toEqual([]);
  });

  // Every route the shell can render is gated the same way the sidebar gates it (nav.ts pageGate): a page
  // whose nav entry is hidden must not be reachable by typing its URL. A new route key therefore has to
  // appear in the nav, in nav.ts's ALIAS_GATE, or in the identity-surface allowlist below.
  it("every route key has a gate (or is an identity surface)", () => {
    const routeKeys = [...app.matchAll(/case "([a-z0-9-]+)":/g)].map((m) => m[1]!);
    const navKeys = new Set([...nav.matchAll(/key: "([a-z0-9-]+)"/g)].map((m) => m[1]!));
    const aliasBlock = nav.slice(nav.indexOf("const ALIAS_GATE"), nav.indexOf("export function pageGate"));
    for (const m of aliasBlock.matchAll(/^\s*"?([a-z0-9-]+)"?:\s*\{/gm)) navKeys.add(m[1]!);
    // Open to every signed-in user by design: their own identity and their own inbox.
    const IDENTITY = new Set(["dashboard", "profile", "notifications"]);
    const misses = routeKeys.filter((k) => !navKeys.has(k) && !IDENTITY.has(k));
    expect(misses, `route keys with no gate: ${misses.join(", ")}`).toEqual([]);
  });
});
