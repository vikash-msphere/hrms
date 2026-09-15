import { describe, it, expect } from "vitest";
import { ruleFlags, denyBlocking } from "@/components/access/ruleLogic";
import type { AccessRule } from "@/components/access/permMatrix";

// `scope: "create"` IS A SEPARATE DIMENSION, NOT A TIER OF THE ROW-SCOPE LADDER.
//
// src/domain/policyValidate.ts states it - "scope=create gates collection-level creation; it takes no field or
// verb" - and services/accessRules.ts#buildPattern enforces it: a create rule compiles to the bare one-token
// `<collection>` pattern, which that function's own comment calls "distinct from `<collection>.**` (every
// object)". So an org-wide (`all`) rule does not reach creation, in either direction.
//
// The dead-rule lint used to answer otherwise. `covers()` short-circuited on `a.scope === "all"` before
// looking at `create`, and `create` is absent from the BREADTH table so the breadth comparison passed
// trivially - which badged a create grant "Already covered by a broader rule ... so this one adds nothing"
// whenever the same subject also held an all-scope write or admin allow on that collection. That is what a
// full-admin role looks like on any catalog, and acting on the advice revokes the ability to add records.
//
// A lint that is wrong in the direction of removing a grant is worse than no lint, which is why this is
// pinned. These are pure functions over already-loaded rules, so no server is needed.
const rule = (r: Partial<AccessRule> & { path: string }): AccessRule => ({
  subject_kind: "role",
  subject: "hr_admin",
  collection: "leave-types",
  scope: "all",
  effect: "allow",
  status: "active",
  ...r,
});

const kinds = (r: AccessRule, all: AccessRule[]) => ruleFlags(r, all).map((f) => f.kind);

describe("ACL lint: a create grant is not covered by an org-wide rule", () => {
  it("does not call a create allow redundant beside an all-scope write allow", () => {
    const create = rule({ path: "access-rules/1", scope: "create" });
    const writeAll = rule({ path: "access-rules/2", scope: "all", level: "write" });
    expect(kinds(create, [create, writeAll])).not.toContain("shadowed");
  });

  it("does not call a create allow redundant beside an all-scope admin allow", () => {
    const create = rule({ path: "access-rules/1", scope: "create" });
    const adminAll = rule({ path: "access-rules/2", scope: "all", level: "admin" });
    expect(kinds(create, [create, adminAll])).not.toContain("shadowed");
  });

  it("does not call an all-scope read allow redundant beside a create allow either", () => {
    // The other direction of the same split: creating says nothing about reading what exists.
    const readAll = rule({ path: "access-rules/1", scope: "all", level: "read" });
    const create = rule({ path: "access-rules/2", scope: "create" });
    expect(kinds(readAll, [readAll, create])).not.toContain("shadowed");
  });

  it("still flags a genuinely shadowed rule, so the lint has not simply been switched off", () => {
    // A self-scope read under an all-scope write really is dead: broader scope AND a higher level.
    const selfRead = rule({ path: "access-rules/1", scope: "self", level: "read" });
    const writeAll = rule({ path: "access-rules/2", scope: "all", level: "write" });
    expect(kinds(selfRead, [selfRead, writeAll])).toContain("shadowed");
  });

  it("still flags a duplicate create allow against a broader create allow", () => {
    // Same dimension, so the ordinary rules apply: two create allows on one collection, the second adds nothing.
    const create = rule({ path: "access-rules/1", scope: "create", level: "read" });
    const createWrite = rule({ path: "access-rules/2", scope: "create", level: "write" });
    expect(kinds(create, [create, createWrite])).toContain("shadowed");
  });
});

describe("ACL lint: a deny obeys the same split", () => {
  it("an org-wide deny is not reported as blocking a create allow", () => {
    // `<collection>.**` does not match the one-token create key, so warning here would send the author
    // looking for a rule that is not in the way.
    const denyAll = rule({ path: "access-rules/9", scope: "all", effect: "deny" });
    const create = rule({ path: "access-rules/1", scope: "create" });
    expect(kinds(create, [create, denyAll])).not.toContain("denied");
    expect(denyBlocking({ subject_kind: "role", subject: "hr_admin", collection: "leave-types", scope: "create" }, [denyAll])).toBeUndefined();
  });

  it("an org-wide deny still blocks an org-wide allow", () => {
    const denyAll = rule({ path: "access-rules/9", scope: "all", effect: "deny" });
    const readAll = rule({ path: "access-rules/1", scope: "all", level: "read" });
    expect(kinds(readAll, [readAll, denyAll])).toContain("denied");
  });
});
