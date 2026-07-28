import { describe, it, expect } from "vitest";
import { toActivityResource } from "../src/http/serialize";

// The org-wide activity feed only offers a drill-in ref (`entity_ref`) for entities the target-resolve gate
// can actually resolve (RESOURCE_COLLECTIONS). A non-resource entity - the activity endpoint itself, settings,
// a denied read - must NOT get a ref, or clicking it would fire GET /v1/activity?resource=<unresolvable> and
// the authz gate would deny + audit a bogus "activity: unresolved target resource" row back into the feed.
const row = (over: Record<string, unknown>) => ({ uuid: "u1", action: "x", actorId: "a1", actorEmail: "a@e", at: 0, ...over });

describe("toActivityResource entity_ref guard", () => {
  it("emits entity_ref for a resolvable resource entity", () => {
    const r = toActivityResource(row({ entity: "employees", entityId: "emp1" }));
    expect(r.entity).toBe("employees");
    expect(r.entity_ref).toBe("employees/emp1");
  });

  it("omits entity_ref for a non-resource entity (e.g. the activity endpoint, settings)", () => {
    for (const entity of ["activity", "settings", "(unmapped)", "batch"]) {
      const r = toActivityResource(row({ entity, entityId: "whatever" }));
      expect(r.entity).toBe(entity); // the label still shows in the feed
      expect(r.entity_ref).toBeUndefined(); // but it is not drillable
    }
  });

  it("omits entity_ref when there is no entityId", () => {
    const r = toActivityResource(row({ entity: "employees", entityId: null }));
    expect(r.entity_ref).toBeUndefined();
  });
});
