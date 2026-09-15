import { describe, it, expect } from "vitest";
import { actorSubtrees, scopeFor, verbScopeFor, actorScope } from "../src/domain/access";
import { decide, resolveRequest, type Grant } from "../src/domain/permissions";
import { DEFAULT_POLICY } from "../src/domain/manifests";

// A subtree grant - `<collection>.<code>-*.**`, the compiled form of "this department and everything under
// it" - used to decide ITEMS correctly and contribute NOTHING to a list. `actorScope` answers with one of
// three tiers, all of them relative to the caller (all / my department / mine), and a department that is not
// the caller's own matches none of them, so the breadth fell through to `own` and the list showed the holder
// their own rows only. They could open records their own list would never show them, which is the one shape a
// scope must never have.
//
// These tests pin the two halves together: what the ENGINE allows on an item, and what the list scope carries.

const A_DEPT = "04"; // the caller's own department
const B_DEPT = "07"; // somebody else's - the whole point of the tier
const CALLER = `${A_DEPT}-1c-0a9`;

const actor = (grant: Grant) => ({ grant, employeeCode: CALLER, employeeId: "emp-uuid", policy: DEFAULT_POLICY }) as any;
// The collection gate (the bare one-token rule) is what lets the list be CALLED at all; the scoped rules
// decide which rows come back. Every seeded role carries the pair, and so must anything authored by hand.
const listable = (extra: Record<string, "read" | "write" | "admin">): Grant => ({ levels: { "leave-requests": "read", ...extra }, allow: [] });

describe("actorSubtrees", () => {
  it("finds a named department's prefix, and only from this collection's patterns", () => {
    const grant = listable({ [`leave-requests.${B_DEPT}-*.**`]: "read", [`expenses.09-*.**`]: "read" });
    expect(actorSubtrees(actor(grant), "leave-requests")).toEqual([B_DEPT]);
    // The expenses pattern must not leak across: a prefix is only authority on the collection that names it.
    expect(actorSubtrees(actor(grant), "expenses")).toEqual(["09"]);
    expect(actorSubtrees(actor(grant), "goals")).toEqual([]);
  });

  it("reports several, de-duplicated", () => {
    const grant = listable({ [`leave-requests.${B_DEPT}-*.**`]: "read", "leave-requests.09-*.**": "write" });
    expect(actorSubtrees(actor(grant), "leave-requests").sort()).toEqual(["07", "09"]);
  });

  it("is the ENGINE's answer, not the pattern's promise: a deny over the subtree drops it", () => {
    const grant: Grant = { ...listable({ [`leave-requests.${B_DEPT}-*.**`]: "read" }), deny: [`leave-requests.${B_DEPT}-*.**`] };
    expect(actorSubtrees(actor(grant), "leave-requests")).toEqual([]);
  });

  it("ignores the relative tiers and the empty prefix", () => {
    // `me` / `my-dept` are breadths, not subtrees; `-*` is the empty prefix, which isUnder refuses outright,
    // so it is authority over nothing rather than over everything.
    const grant = listable({ "leave-requests.me.**": "read", "leave-requests.my-dept.**": "read", "leave-requests.-*.**": "read" });
    expect(actorSubtrees(actor(grant), "leave-requests")).toEqual([]);
  });

  it("reads the custom-method lane when a verb is asked for", () => {
    const grant: Grant = { levels: {}, allow: [`leave-requests.${B_DEPT}-*.approve`] };
    expect(actorSubtrees(actor(grant), "leave-requests", "approve")).toEqual([B_DEPT]);
    // A verb grant is not a read grant: the level lane sees nothing.
    expect(actorSubtrees(actor(grant), "leave-requests")).toEqual([]);
    // ...and it is that verb only.
    expect(actorSubtrees(actor(grant), "leave-requests", "reject")).toEqual([]);
  });
});

describe("scopeFor carries subtrees alongside the breadth", () => {
  it("a named-department grant keeps `own` breadth and adds the prefix", () => {
    const grant = listable({ "leave-requests.me.**": "read", [`leave-requests.${B_DEPT}-*.**`]: "read" });
    const scope = scopeFor(actor(grant), "leave-requests");
    // Breadth is unchanged - the caller is not a department-wide reader of their OWN department.
    expect(scope.breadth).toBe("own");
    expect(scope.subtrees).toEqual([B_DEPT]);
  });

  it("the item decision and the list scope now agree about the same row", () => {
    const grant = listable({ [`leave-requests.${B_DEPT}-*.**`]: "read" });
    const self = { employeeCode: CALLER };
    const row = `${B_DEPT}-1a-002-0k`;
    // The engine has always allowed this item...
    expect(decide(grant, resolveRequest("GET", `/v1/leave-requests/${row}`), self).allow).toBe(true);
    // ...and the list scope now carries the prefix that will bind it, instead of nothing.
    expect(scopeFor(actor(grant), "leave-requests").subtrees).toEqual([B_DEPT]);
  });

  it("skips the scan at `all` breadth - there is nothing left to widen", () => {
    const grant = listable({ "leave-requests.**": "read", [`leave-requests.${B_DEPT}-*.**`]: "read" });
    const scope = scopeFor(actor(grant), "leave-requests");
    expect(scope.breadth).toBe("all");
    expect(scope.subtrees).toEqual([]);
  });

  it("an anchor on the caller's OWN department reads as dept breadth, and still records the prefix", () => {
    const grant = listable({ [`leave-requests.${A_DEPT}-*.**`]: "read" });
    // The breadth probe asks the engine about a sibling in the caller's own department, and a `04-*` pattern
    // answers yes - so this is genuinely `dept` breadth, reached by a different pattern. The prefix is
    // recorded anyway: it is redundant while the caller sits in 04 and is the whole rule the moment they
    // move, and `applyScope` ORs it into a breadth that already covers it, which changes no row.
    expect(actorScope(actor(grant), "leave-requests")).toBe("dept");
    expect(scopeFor(actor(grant), "leave-requests").subtrees).toEqual([A_DEPT]);
  });
});

describe("verbScopeFor", () => {
  it("a subtree-only approver gets a scope instead of nothing", () => {
    const grant: Grant = { levels: {}, allow: [`leave-requests.${B_DEPT}-*.approve`] };
    const scope = verbScopeFor(actor(grant), "leave-requests", "approve");
    expect(scope).not.toBeNull();
    expect(scope!.subtrees).toEqual([B_DEPT]);
    // The empty breadth: `own` with NO owner binds `1 = 0`, so the queue counts the subtree and NOT the
    // caller's own rows - they hold no approve over themselves.
    expect(scope!.breadth).toBe("own");
    expect(scope!.ownerId).toBeNull();
  });

  it("keeps the real owner when the caller genuinely holds the verb at own scope", () => {
    const grant: Grant = { levels: {}, allow: ["leave-requests.me.approve"] };
    const scope = verbScopeFor(actor(grant), "leave-requests", "approve");
    expect(scope!.breadth).toBe("own");
    expect(scope!.ownerId).toBe("emp-uuid");
  });

  it("still returns null when the caller holds the verb nowhere", () => {
    expect(verbScopeFor(actor({ levels: {}, allow: [] }), "leave-requests", "approve")).toBeNull();
  });
});
