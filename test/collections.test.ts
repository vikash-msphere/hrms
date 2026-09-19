/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { COLLECTIONS, isGrantCollection } from "../src/domain/collections";
import { SUPPORTED_SCOPES } from "../src/domain/manifests";

// The gate `domain/collections.ts` names in its own header, and did not have.
//
// `COLLECTIONS` is the allow-list `isGrantCollection` enforces: the grant validator rejects any pattern whose
// first token is not in it. So a collection mounted at a route but missing from this set cannot be named by
// ANY access rule - not by the seed, and not by an admin through the ACL. It is permanently super_admin-only,
// and the ACL surface gives no hint why: the rule is simply refused as naming an unknown collection.
//
// Ten tests import `COLLECTIONS`; none of them held it against the route mounts. The one collection that had
// fallen through was `payroll-debit-accounts`, whose comment claimed the weaker fact ("private-by-default - no
// grant names it") while the omission enforced something else entirely (no grant CAN name it, ever).
//
// A SOURCE scan of the mount table on purpose: a mount is `app.route("/v1/<collection>", ...)` at a call site,
// so there is no runtime registry to read.
const rawIndex = import.meta.glob("../src/index.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const indexSrc = Object.values(rawIndex)[0]!;

// Fan-out envelopes rather than collections: the authz middleware exempts these from the collection decision
// (AGGREGATE_ROUTES in src/middleware/authz.ts) and gates each one per underlying collection instead, so they
// correctly have no entry of their own. Kept in step with that set by the assertion below.
const AGGREGATE_ROUTES = ["search", "dashboard-summary", "people-analytics", "approvals-summary", "activity-counts", "changes"];

// Namespaces that are deliberately NOT routes: virtual capabilities gating an affordance or a cross-cutting
// verb rather than a resource. Each must still be nameable in a grant, which is why they are in COLLECTIONS.
const ROUTELESS: Record<string, string> = {
  timeline: "gates the Dashboard team timeline widget; the data behind it is enforced per underlying collection",
  export: "gates the cross-module CSV/Excel export affordance",
  batch: "the multi-read transport verb (`batch.run`), whose sub-requests re-enter the full chain",
  unmask: "the virtual capability that reveals a masked sensitive field",
  audit: "gates the org-wide audit trail",
};

const mounted = [...indexSrc.matchAll(/app\.route\("\/v1\/([a-z0-9-]+)"/g)].map((m) => m[1]!);

describe("collections registry", () => {
  it("found the mount table", () => {
    // A guard on the scan itself: if the mount shape ever changes, this fails loudly instead of the two
    // assertions below silently passing over an empty list.
    expect(mounted.length).toBeGreaterThan(80);
  });

  it("every mounted collection is nameable in a grant", () => {
    const missing = mounted
      .filter((c) => !AGGREGATE_ROUTES.includes(c))
      .filter((c) => !COLLECTIONS.has(c));
    expect(missing, "mounted at a route but absent from COLLECTIONS, so no access rule can ever name it").toEqual([]);
  });

  it("every entry is either mounted, an aggregate, or a declared routeless capability", () => {
    const stale = [...COLLECTIONS].filter((c) => !mounted.includes(c) && !ROUTELESS[c]);
    expect(stale, "in COLLECTIONS with no route and no entry in ROUTELESS - a stale name compiles into authority that reaches nothing").toEqual([]);
  });

  it("every declared routeless capability is actually in the set", () => {
    const gone = Object.keys(ROUTELESS).filter((c) => !COLLECTIONS.has(c));
    expect(gone).toEqual([]);
  });

  it("the aggregate exemption list matches the middleware's", () => {
    const authz = Object.values(
      import.meta.glob("../src/middleware/authz.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>,
    )[0]!;
    const declared = authz.match(/const AGGREGATE_ROUTES = new Set\(\[([^\]]*)\]\)/);
    expect(declared, "AGGREGATE_ROUTES not found in middleware/authz.ts").not.toBeNull();
    const names = [...declared![1]!.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]!);
    expect(names.sort()).toEqual([...AGGREGATE_ROUTES].sort());
  });

  // The gate the web catalogue did not have, and the reason `kudos` sat in the permissions matrix as a row
  // whose every cell answered 400. The matrix is the ONLY way an admin discovers a grantable resource, so a
  // name in it that the validator refuses is not a cosmetic slip: it is an access control the product appears
  // to offer and does not have. Kudos became announcements with kind="kudos" and the row was left behind.
  //
  // The converse direction is deliberately NOT asserted. `COLLECTIONS` legitimately holds names no admin
  // should be offered a row for (`batch`, `preferences`, `event-log`, `cron-runs`, the workflow observability
  // namespaces): they are plumbing, granted by the seed or by nobody. Absence from the matrix is a product
  // decision; presence in it without a backing collection is a defect.
  it("every collection in the web permissions matrix is a real grantable collection", () => {
    const matrix = Object.values(
      import.meta.glob("../web/src/components/access/permMatrix.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>,
    )[0]!;
    const groups = matrix.slice(matrix.indexOf("COLLECTION_GROUPS"), matrix.indexOf("export const BASE_COLLECTIONS"));
    // Only the `collections: [...]` arrays - the group labels are prose and must not be read as names.
    const names = [...groups.matchAll(/collections:\s*\[([^\]]*)\]/g)]
      .flatMap((m) => [...m[1]!.matchAll(/"([a-z0-9-]+)"/g)].map((n) => n[1]!));
    expect(names.length, "no collections parsed out of COLLECTION_GROUPS - the shape changed").toBeGreaterThan(70);
    const phantom = [...new Set(names)].filter((c) => !COLLECTIONS.has(c));
    expect(phantom, "offered as a row in the permissions matrix but not a collection, so every rule authored there is rejected as unknown").toEqual([]);
  });

  // The other direction, for the one set where absence IS a defect. `SUPPORTED_SCOPES` is the list of
  // collections an org can author a SCOPED rule on - self / dept / reports / org - which is to say the ones
  // the product means an admin to tune per subject. The matrix is the only place an admin discovers them, so a
  // collection that is scope-grantable and not offered there is a permission the engine honours and the UI
  // cannot author: `attendance-day-marks` shipped that way, seeded grants and all, and the only route to it
  // was the raw API. The plumbing exemption above still stands - it applies to names that are in COLLECTIONS
  // and in nobody's scope table.
  it("every scope-grantable collection is offered in the web permissions matrix", () => {
    const matrix = Object.values(
      import.meta.glob("../web/src/components/access/permMatrix.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>,
    )[0]!;
    const groups = matrix.slice(matrix.indexOf("COLLECTION_GROUPS"), matrix.indexOf("export const BASE_COLLECTIONS"));
    const offered = new Set(
      [...groups.matchAll(/collections:\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1]!.matchAll(/"([a-z0-9-]+)"/g)].map((n) => n[1]!)),
    );
    const missing = Object.keys(SUPPORTED_SCOPES).filter((c) => !offered.has(c));
    expect(missing, "scope-grantable but absent from COLLECTION_GROUPS, so no admin can find it to grant it").toEqual([]);
  });

  it("accepts the super wildcard and refuses an unknown token", () => {
    expect(isGrantCollection("**")).toBe(true);
    expect(isGrantCollection("employees")).toBe(true);
    expect(isGrantCollection("payroll-debit-accounts")).toBe(true);
    expect(isGrantCollection("not-a-collection")).toBe(false);
  });
});
