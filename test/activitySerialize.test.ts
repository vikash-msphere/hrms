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

// The lineage keys the client passes straight back as `?correlation` / `?session` / `?subject`. All three are
// equality keys rather than labels, so what matters is that they survive the serializer intact and are absent
// (not null, not "") when the row carries none - a `?session=` with an empty value would widen the feed to
// everything instead of narrowing it.
describe("toActivityResource carries the lineage keys", () => {
  it("passes the act, the sitting, the authority and the subject through", () => {
    const r = toActivityResource(row({
      entity: "compensation", entityId: "cmp1",
      correlationId: "act-1", sessionId: "u1:1700000000000", actorRole: "payroll_admin", subjectId: "emp1",
    }));
    expect(r.correlation_id).toBe("act-1");
    expect(r.session_id).toBe("u1:1700000000000");
    expect(r.actor_role).toBe("payroll_admin");
    expect(r.subject).toBe("employees/emp1"); // a wire ref, so the outbound edge tokenizes it
  });

  it("omits each one rather than emitting an empty value the client would filter on", () => {
    const r = toActivityResource(row({ entity: "boards", entityId: "b1" }));
    expect(r.correlation_id).toBeUndefined();
    expect(r.session_id).toBeUndefined();
    expect(r.actor_role).toBeUndefined();
    expect(r.subject).toBeUndefined();
  });
});
