import { describe, it, expect } from "vitest";
import { evalCondition, validateAutomation, resolveField, type Automation, type Condition, type EvalContext } from "../src/domain/automations";
import { EVENT_TYPES, eventTypeDef, isKnownEventType, fieldsForEventType } from "../src/domain/events";
import { grantFor } from "../src/domain/grants";
import { resolveRequest, decide } from "../src/domain/permissions";

// ---- Condition evaluator (pure predicate tree; no eval) ----
const ctx = (payload: Record<string, unknown>, extra: Partial<EvalContext> = {}): EvalContext => ({
  type: "leave.approved", subject: "leave-requests/x", actorId: "u1", employeeId: "e1", payload, ...extra,
});

describe("automations - evalCondition", () => {
  it("null condition is always true (unconditional rule)", () => {
    expect(evalCondition(null, ctx({}))).toBe(true);
    expect(evalCondition(undefined, ctx({}))).toBe(true);
  });
  it("comparison ops over payload fields", () => {
    const c = ctx({ days: 5 });
    expect(evalCondition({ field: "days", op: "gt", value: 3 }, c)).toBe(true);
    expect(evalCondition({ field: "days", op: "gte", value: 5 }, c)).toBe(true);
    expect(evalCondition({ field: "days", op: "lt", value: 5 }, c)).toBe(false);
    expect(evalCondition({ field: "days", op: "eq", value: 5 }, c)).toBe(true);
    expect(evalCondition({ field: "days", op: "ne", value: 1 }, c)).toBe(true);
  });
  it("resolves common fields at top level and dotted paths into payload", () => {
    const c = ctx({ meta: { reason: "sick" } });
    expect(evalCondition({ field: "employeeId", op: "eq", value: "e1" }, c)).toBe(true);
    expect(evalCondition({ field: "meta.reason", op: "eq", value: "sick" }, c)).toBe(true);
    expect(evalCondition({ field: "meta.reason", op: "eq", value: "vacation" }, c)).toBe(false);
  });
  it("in / contains / exists", () => {
    const c = ctx({ stage: "offer", tags: ["urgent"] });
    expect(evalCondition({ field: "stage", op: "in", value: ["offer", "hired"] }, c)).toBe(true);
    expect(evalCondition({ field: "tags", op: "contains", value: "urgent" }, c)).toBe(true);
    expect(evalCondition({ field: "stage", op: "exists" }, c)).toBe(true);
    expect(evalCondition({ field: "missing", op: "notExists" }, c)).toBe(true);
  });
  it("all / any / not compose", () => {
    const c = ctx({ days: 10, kind: "loan" });
    const cond: Condition = { all: [{ field: "days", op: "gte", value: 5 }, { any: [{ field: "kind", op: "eq", value: "loan" }, { field: "kind", op: "eq", value: "advance" }] }] };
    expect(evalCondition(cond, c)).toBe(true);
    expect(evalCondition({ not: cond }, c)).toBe(false);
    expect(evalCondition({ all: [{ field: "days", op: "gt", value: 100 }] }, c)).toBe(false);
  });
});

// ---- Rule validation ----
const rule = (over: Partial<Automation> = {}): Automation => ({
  name: "r", triggerType: "leave.approved", actions: [{ kind: "notify", recipient: { of: "subject" }, title: "Hi" }], ...over,
});

describe("automations - validateAutomation", () => {
  it("accepts a well-formed rule", () => {
    expect(validateAutomation(rule())).toEqual([]);
  });
  it("rejects an unknown trigger type", () => {
    expect(validateAutomation(rule({ triggerType: "nope.event" }))).toContain(`triggerType "nope.event" is not a known event type`);
  });
  it("requires a name, a trigger and at least one action", () => {
    expect(validateAutomation({ name: "", triggerType: "", actions: [] }).length).toBeGreaterThanOrEqual(3);
  });
  it("rejects an unknown action kind", () => {
    const errs = validateAutomation(rule({ actions: [{ kind: "danger" } as never] }));
    expect(errs.some((e) => e.includes("unknown action kind"))).toBe(true);
  });
  it("validates per-action required params", () => {
    expect(validateAutomation(rule({ actions: [{ kind: "notify", recipient: { of: "subject" } } as never] })).some((e) => e.includes("title"))).toBe(true);
    expect(validateAutomation(rule({ actions: [{ kind: "emitEvent", type: "nope" }] })).some((e) => e.includes("not a known event"))).toBe(true);
    expect(validateAutomation(rule({ actions: [{ kind: "wait", delayDays: 0, then: [] }] })).some((e) => e.includes("positive delay"))).toBe(true);
  });
  it("allows nested waits (durable multi-step chains) up to the depth cap", () => {
    const nested: Automation = rule({ actions: [{ kind: "wait", delayDays: 1, then: [{ kind: "wait", delayDays: 1, then: [{ kind: "notify", recipient: { of: "subject" }, title: "x" }] }] }] });
    expect(validateAutomation(nested)).toEqual([]);
  });
  it("checks a condition field against the trigger's catalog", () => {
    expect(validateAutomation(rule({ condition: { field: "days", op: "gt", value: 1 } }))).toEqual([]);
    expect(validateAutomation(rule({ condition: { field: "bogus", op: "gt", value: 1 } })).some((e) => e.includes("not a known field"))).toBe(true);
  });
});

// ---- PR5: apiCall / waitFor / data-passing ----
describe("automations - resolveField (data-passing bag)", () => {
  const ctx: EvalContext = { type: "offer.accepted", subject: "offers/o1", actorId: null, employeeId: "e1", payload: { candidateId: "c1" }, results: { emp: { path: "employees/e9" } } };
  it("reads common fields, payload keys, and the results bag", () => {
    expect(resolveField(ctx, "employeeId")).toBe("e1");
    expect(resolveField(ctx, "candidateId")).toBe("c1"); // bare -> payload
    expect(resolveField(ctx, "results.emp.path")).toBe("employees/e9");
    expect(resolveField(ctx, "payload.candidateId")).toBe("c1");
    expect(resolveField(ctx, "results.missing")).toBeUndefined();
  });
});

describe("automations - validate apiCall / waitFor", () => {
  const r = (actions: unknown[]): Automation => ({ name: "r", triggerType: "offer.accepted", actions: actions as never });
  it("apiCall needs method + /v1 path", () => {
    expect(validateAutomation(r([{ kind: "apiCall", method: "POST", path: "/v1/transitions", body: {} }]))).toEqual([]);
    expect(validateAutomation(r([{ kind: "apiCall", method: "POST", path: "transitions" }])).some((e) => e.includes("must start with /v1/"))).toBe(true);
    expect(validateAutomation(r([{ kind: "apiCall", path: "/v1/x" }])).some((e) => e.includes("needs a method"))).toBe(true);
  });
  it("waitFor arms need an event or timer + a then", () => {
    const ok = r([{ kind: "waitFor", on: [{ event: "transition.completed", match: "employeeId", then: [{ kind: "notify", recipient: { of: "subject" }, title: "done" }] }, { timer: { days: 30 }, then: [{ kind: "notify", recipient: { of: "managerOf" }, title: "nudge" }] }] }]);
    expect(validateAutomation(ok)).toEqual([]);
    expect(validateAutomation(r([{ kind: "waitFor", on: [{ then: [] }] }])).length).toBeGreaterThan(0);
    expect(validateAutomation(r([{ kind: "waitFor", on: [{ event: "nope.event", then: [{ kind: "notify", recipient: { of: "subject" }, title: "x" }] }] }])).some((e) => e.includes("not a known event"))).toBe(true);
    expect(validateAutomation(r([{ kind: "waitFor", on: [{ timer: { days: 0 }, then: [{ kind: "notify", recipient: { of: "subject" }, title: "x" }] }] }])).some((e) => e.includes("positive delay"))).toBe(true);
  });
  it("waitFor must be the last action in its list", () => {
    const bad = r([
      { kind: "waitFor", on: [{ event: "transition.completed", then: [{ kind: "notify", recipient: { of: "subject" }, title: "x" }] }] },
      { kind: "notify", recipient: { of: "subject" }, title: "unreachable" },
    ]);
    expect(validateAutomation(bad).some((e) => e.includes("waitFor must be the last action"))).toBe(true);
  });
  it("a data-passing chain (apiCall captureAs -> apiCall template) validates", () => {
    const chain = r([
      { kind: "apiCall", method: "POST", path: "/v1/transitions", body: { employee: "{{subject}}" }, captureAs: "tr" },
      { kind: "notify", recipient: { of: "subject" }, title: "Onboarding {{results.tr.path}} started" },
    ]);
    expect(validateAutomation(chain)).toEqual([]);
  });
});

// ---- Event registry ----
describe("events registry", () => {
  it("has unique, non-empty type ids", () => {
    const types = EVENT_TYPES.map((e) => e.type);
    expect(new Set(types).size).toBe(types.length);
    expect(types.every((t) => t.length > 0)).toBe(true);
  });
  it("known-type lookups work and the flagship events exist", () => {
    for (const t of ["offer.accepted", "employee.created", "payroll.published", "loan.approved", "leave.approved"]) {
      expect(isKnownEventType(t)).toBe(true);
      expect(eventTypeDef(t)).toBeTruthy();
    }
  });
  it("fieldsForEventType includes the common fields plus the type's own", () => {
    const names = fieldsForEventType("leave.approved").map((f) => f.name);
    expect(names).toContain("employeeId"); // common
    expect(names).toContain("days"); // own
  });
});

// ---- Builder metadata (/v1/workflow-meta) ----
import { buildWorkflowMeta } from "../src/domain/workflowMeta";
import { ACCESS_VERBS } from "../src/http/accessHint";

describe("workflow-meta assembler", () => {
  const meta = buildWorkflowMeta(ACCESS_VERBS);
  it("exposes the event catalog with fields", () => {
    const leave = meta.events.find((e) => e.type === "leave.approved");
    expect(leave).toBeTruthy();
    expect(leave!.fields.map((f) => f.name)).toContain("days");
  });
  it("splits each resource into standard ops and custom verbs", () => {
    const lr = meta.resources.find((r) => r.name === "leave-requests");
    expect(lr).toBeTruthy();
    expect(lr!.standard.sort()).toEqual(["delete", "update"]);
    expect(lr!.verbs).toEqual(expect.arrayContaining(["approve", "reject", "cancel"]));
    expect(lr!.verbs).not.toContain("update"); // standard, not custom
  });
  it("carries the enum vocabularies", () => {
    expect(meta.conditionOps).toContain("gte");
    expect(meta.recipientKinds).toContain("managerOf");
    expect(meta.actionKinds).toEqual(expect.arrayContaining(["apiCall", "waitFor", "notify"]));
  });
});

// ---- Authz wiring: authoring is HR/super only ----
const can = (role: string, method: string, path: string) => decide(grantFor(role), resolveRequest(method, path), { employeeCode: "04-002-001" }).allow;

describe("automations - authoring is privileged (HR/super only)", () => {
  it("hr_admin may author rules and the enable/disable/test verbs; may read the logs", () => {
    expect(can("hr_admin", "POST", "/v1/automations")).toBe(true);
    expect(can("hr_admin", "PATCH", "/v1/automations/aa-01")).toBe(true);
    expect(can("hr_admin", "POST", "/v1/automations/aa-01:enable")).toBe(true);
    expect(can("hr_admin", "POST", "/v1/automations/aa-01:test")).toBe(true);
    expect(can("hr_admin", "GET", "/v1/event-log")).toBe(true);
    expect(can("hr_admin", "GET", "/v1/automation-runs")).toBe(true);
    expect(can("hr_admin", "GET", "/v1/workflow-meta")).toBe(true);
  });
  it("employee and manager cannot touch automations or the logs (private-by-default)", () => {
    for (const role of ["employee", "manager", "payroll_admin"]) {
      expect(can(role, "GET", "/v1/automations")).toBe(false);
      expect(can(role, "POST", "/v1/automations")).toBe(false);
      expect(can(role, "POST", "/v1/automations/aa-01:enable")).toBe(false);
      expect(can(role, "GET", "/v1/event-log")).toBe(false);
      expect(can(role, "GET", "/v1/workflow-meta")).toBe(false);
    }
  });
  it("super_admin reaches everything via the wildcard", () => {
    expect(can("super_admin", "POST", "/v1/automations")).toBe(true);
    expect(can("super_admin", "GET", "/v1/event-log")).toBe(true);
  });
});
