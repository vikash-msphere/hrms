/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { grantFor } from "../bootstrap/authz/grants";
import { resolveRequest, decide } from "../src/domain/permissions";
import type { Role } from "../src/env";

// THE GATE THAT TIES ROUTES TO SEEDED GRANTS. It did not exist, and two findings came straight out of the gap.
//
// There are drift guards for the openapi spec, the custom-method registry, the mount order, the purge
// cascades, the seed's materialisation - and `test/grants.test.ts` covers custom VERBS exactly (every verb the
// UI can offer is reachable, or is on a withheld list with its reason). Nothing covered the two other shapes a
// route comes in:
//
//   1. a mounted COLLECTION whose list nobody can call. `boards`, `table-views`, `approval-delegations` and
//      `goal-templates` shipped that way: under the app's "hide, never disable" rule the nav entries simply do
//      not render, so a fresh install presented a Kanban module, a table builder and the delegation screen as
//      if they did not exist.
//   2. a SUB-RESOURCE, which is a 3-token key that no 2-token pattern can ever match (`matchFrom` returns
//      `ki >= key.length` once the pattern runs out). `employees/{id}/presence` shipped with no grant, so the
//      status pill, the "on leave until ..." callout and the covering-person note 403'd for every caller
//      including the person reading their OWN profile - and `usePresence` swallows the error, so the feature
//      looked implemented and was dead for the whole workforce.
//
// Both are "a route was added, the grant was not", and both passed every gate. This asserts each mount and
// each sub-resource resolves to an allow under SOME seeded non-super role, with an explicit, reasoned list of
// the ones that are deliberately super-only or ACL-only.
//
// A SOURCE scan of the mount table, like test/collections.test.ts: a mount is a call site, not a registry.
const rawIndex = import.meta.glob("../src/index.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const rawEmployeeRoutes = import.meta.glob("../src/routes/employees.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const NON_SUPER: Role[] = ["employee", "manager", "hr_admin", "payroll_admin", "it_admin", "project_manager"];
// Three object codes: the caller's own, a member of their department, and a flat-coded row - so a `me`,
// `my-dept` or `*` rule each get a chance to match. Reachable under any of them is reachable.
const SELF = { employeeCode: "04-1c-0a9" };
const CODES = ["04-1c-0a9", "04-1c-0b2", "0a"];
const ok = (role: Role, method: string, path: string) => decide(grantFor(role), resolveRequest(method, path), SELF).allow;

/** Collections deliberately unreachable by every seeded role, each with the reason it is withheld. */
const WITHHELD_COLLECTIONS: Record<string, string> = {
  "api-keys": "machine credentials: a key acts as its owner, so minting one is an administrative act (super/ACL only)",
  "cron-runs": "the ops console - scheduler internals, not a product surface",
  "search-insights": "⌘K usage counters, including the text of queries that found nothing - tuning data for whoever runs the app, opened through the ACL",
  "access-rules": "the access system itself: granting access is super's act, and the ACL is where it is delegated",
  policy: "the policy manifest (protected fields, owner refs, state visibility) is the authz configuration itself",
  roles: "the role catalogue, same reason as `policy`",
  referrals: "private + ACL by design (see the referrals module notes) - the whole collection is per-object",
  "payroll-debit-accounts": "the employer's own bank account, which the bank file is drawn on: super-only, grantable through the ACL",
  moderation: "the flagged-post queue quotes public posts in full and is deliberately NOT narrowed per holder (moderating is an org-wide job), so the capability is the whole access decision - granted to a named moderator through the ACL, never seeded to a role",
  // users left this list when HR was given the account list, read-only, to reset a forgotten app PIN from it.
  // Changing who can sign in and as what is still super's act (users.write, PROTECTED_FIELDS).
  // letterheads (HR), leave-adjustments (HR, and each person's own read), payroll-openings, payroll-budgets and
  // card-transactions (payroll) were here until the least-privilege review of the role files: each is the named
  // role's own job, and the stated risk (salary figures, named people's spending) is data that role already
  // reads. The reasons for each grant are in bootstrap/authz/roles/.
};

/** Employee sub-resources deliberately unreachable by every seeded role. */
const WITHHELD_SUBRESOURCES: Record<string, string> = {};

const mounted = [...Object.values(rawIndex)[0]!.matchAll(/app\.route\("\/v1\/([a-z0-9-]+)"/g)].map((m) => m[1]!);
// Fan-out envelopes: gated per underlying collection rather than as a collection of their own.
const AGGREGATES = ["search", "dashboard-summary", "people-analytics", "approvals-summary", "activity-counts", "changes", "attention", "expense-close", "payroll-forecast", "activity", "operations", "notifications", "preferences", "settings", "batch"];

// `.get("/:employee_id/<sub>", ...)` on the employees router - the sub-resource shape the finding is about.
const subResources = [
  ...new Set(
    [...Object.values(rawEmployeeRoutes)[0]!.matchAll(/\.(?:get|patch)\("\/:employee_id\/([a-z0-9-]+)"/g)].map((m) => m[1]!),
  ),
];

describe("seeded grants reach every mounted route", () => {
  it("found the mount table and the employee sub-resources", () => {
    expect(mounted.length).toBeGreaterThan(80);
    expect(subResources).toContain("presence");
    expect(subResources).toContain("bank-account");
  });

  it("every mounted collection's list is reachable by some seeded role", () => {
    const dead: string[] = [];
    for (const c of mounted) {
      if (AGGREGATES.includes(c) || WITHHELD_COLLECTIONS[c]) continue;
      if (!NON_SUPER.some((role) => ok(role, "GET", `/v1/${c}`))) dead.push(c);
    }
    expect(dead, "mounted but no seeded role can list it - the module renders as if it did not exist").toEqual([]);
  });

  it("every employee sub-resource is reachable by some seeded role", () => {
    const dead: string[] = [];
    for (const sub of subResources) {
      if (WITHHELD_SUBRESOURCES[sub]) continue;
      const reachable = NON_SUPER.some((role) => CODES.some((code) => ok(role, "GET", `/v1/employees/${code}/${sub}`)));
      if (!reachable) dead.push(sub);
    }
    expect(dead, "a 3-token sub-resource key that no seeded 2-token pattern can match - 403 for everyone, including on their own profile").toEqual([]);
  });

  it("every withheld entry still names something that is mounted", () => {
    const stale = Object.keys(WITHHELD_COLLECTIONS).filter((c) => !mounted.includes(c));
    expect(stale, "a withheld collection that no longer exists - the list stops describing the policy").toEqual([]);
    expect(Object.keys(WITHHELD_SUBRESOURCES).filter((s) => !subResources.includes(s))).toEqual([]);
  });

  it("every withheld collection really is unreachable (the list is exact, not a mute button)", () => {
    const granted = Object.keys(WITHHELD_COLLECTIONS).filter((c) => NON_SUPER.some((role) => ok(role, "GET", `/v1/${c}`)));
    expect(granted, "listed as withheld but a seeded role can reach it - remove it from the list").toEqual([]);
  });
});
