/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { grantFor } from "../src/domain/grants";
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

const NON_SUPER: Role[] = ["employee", "manager", "hr_admin", "payroll_admin"];
// Three object codes: the caller's own, a member of their department, and a flat-coded row - so a `me`,
// `my-dept` or `*` rule each get a chance to match. Reachable under any of them is reachable.
const SELF = { employeeCode: "04-1c-0a9" };
const CODES = ["04-1c-0a9", "04-1c-0b2", "0a"];
const ok = (role: Role, method: string, path: string) => decide(grantFor(role), resolveRequest(method, path), SELF).allow;

/** Collections deliberately unreachable by every seeded role, each with the reason it is withheld. */
const WITHHELD_COLLECTIONS: Record<string, string> = {
  "api-keys": "machine credentials: a key acts as its owner, so minting one is an administrative act (super/ACL only)",
  "cron-runs": "the ops console - scheduler internals, not a product surface",
  "access-rules": "the access system itself: granting access is super's act, and the ACL is where it is delegated",
  policy: "the policy manifest (protected fields, owner refs, state visibility) is the authz configuration itself",
  roles: "the role catalogue, same reason as `policy`",
  letterheads: "issuing stationery per legal entity; opened through the ACL rather than seeded to a role",
  referrals: "private + ACL by design (see the referrals module notes) - the whole collection is per-object",
  "payroll-debit-accounts": "the employer's own bank account, which the bank file is drawn on: super-only, grantable through the ACL",
  "card-transactions": "imported corporate card statements: every row is a named person's spending on a company card, so the collection is super-only and opened to finance through the ACL rather than seeded to a role",
  "payroll-budgets": "salary cost caps per cost centre. A cap read beside its spend states a department's whole pay bill, which is a closer thing to individual salaries the smaller the team - a two-person team's budget line is very nearly their pay. Finance-only in the same way `payroll-debit-accounts` is: super-only, opened to named people through the ACL rather than seeded to a role",
  "tax-verifications": "the prior-employer verification queue rides the `tax` capability, decided per employee sub-resource",
  moderation: "the flagged-post queue quotes public posts in full and is deliberately NOT narrowed per holder (moderating is an org-wide job), so the capability is the whole access decision - granted to a named moderator through the ACL, never seeded to a role",
  users: "the login directory (role and status per account). Changing who can sign in and as what is super's act; delegated through the ACL, never seeded",
  "leave-adjustments": "the leave balance ledger: every write moves an encashable balance by hand, and the opening import does it for a whole workforce at once. Private by default (a new collection is granted through the ACL, not by a seed), including the self-scoped read that lets people see why their own balance moved",
  "payroll-openings": "pay and tax from before HRMS, per person: salary figures entered by hand for a one-time import, read by the payroll engine rather than by people. Private by default like `payroll-debit-accounts`, opened to payroll through the ACL",
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
