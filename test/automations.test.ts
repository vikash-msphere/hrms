import { describe, it, expect } from "vitest";
import { evalCondition, validateAutomation, resolveField, type Automation, type Condition, type EvalContext } from "../src/domain/automations";
import { EVENT_TYPES, eventTypeDef, isKnownEventType, fieldsForEventType } from "../src/domain/events";
import { grantFor } from "../bootstrap/authz/grants";
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

// ---- The write schema names every writable field of the contract ----
//
// `writeSchema` in routes/automations.ts is `.strict()`, so a field the contract declares writable but the
// schema does not name is not ignored - it makes the WHOLE body invalid. `schedule` shipped that way: the
// builder sends it on every save (null for an event-triggered rule), so no rule of any kind could be created
// from the dialog, and a scheduled rule could not be authored at all. The route answered 400 with a Zod
// "unrecognized key" and the dialog simply stayed open. Both halves of that are invisible to the pure tests
// above, which call the service directly.
const routeSrc = Object.values(
  import.meta.glob("../src/routes/automations.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>,
)[0]!;
const specSrc = Object.values(
  import.meta.glob("../openapi.yaml", { query: "?raw", import: "default", eager: true }) as Record<string, string>,
)[0]!;

describe("automations - the route accepts every writable field in the contract", () => {
  // The `automation` schema's properties, read as text. A property starts at a known indent and runs to the
  // next one, which is what makes `readOnly` findable whether it sits inline (`etag: { ..., readOnly: true }`)
  // or on its own line under the key (`path:`).
  const writable = (() => {
    const start = specSrc.indexOf("\n    automation:\n");
    expect(start, "openapi.yaml no longer declares an `automation` schema").toBeGreaterThan(0);
    const block = specSrc.slice(start).split("\n      x-aep-resource:")[0]!;
    const heads = [...block.matchAll(/^ {8}([a-z_]+):/gm)];
    return heads
      .filter(([, name], i) => {
        const body = block.slice(heads[i]!.index!, heads[i + 1]?.index ?? block.length);
        return !/readOnly:\s*true/.test(body) && name !== "access";
      })
      .map(([, name]) => name!);
  })();

  it("found the contract's fields (sanity: the spec still parses this way)", () => {
    expect(writable).toEqual(["name", "description", "trigger_type", "condition", "actions", "schedule", "enabled"]);
  });

  it("names each of them in writeSchema", () => {
    const schemaBlock = routeSrc.split("const writeSchema = z.object({")[1]!.split("}).strict();")[0]!;
    const named = new Set([...schemaBlock.matchAll(/^\s{2}([a-z_]+):/gm)].map(([, k]) => k!));
    const missing = writable.filter((f) => !named.has(f));
    expect(missing, "writable in openapi.yaml but not named in the .strict() writeSchema - the route 400s the whole body").toEqual([]);
  });
});

// A CONDITION TREE IS CALLER-SUPPLIED STRUCTURE, and it was the one recursive walk in this file with no
// ceiling on it. `validateAction` has bounded action nesting since it was written; `validateCondition` took no
// depth at all, and `evalCondition` - which runs on EVERY event of a matching trigger - recursed freely.
//
// A `{not:{not:…}}` chain 20,000 deep is about 160 KB of JSON, far inside the request body cap, and overflows
// the stack: authoring one 500s inside the validator rather than being refused as the bad request it is, and a
// stored one takes the engine down for that trigger every time it fires, because the parsed rule is cached.
describe("automations - condition depth", () => {
  const nest = (n: number): Condition => {
    let c: Condition = { field: "days", op: "gt", value: 3 };
    for (let i = 0; i < n; i++) c = { not: c };
    return c;
  };

  it("evaluates an ordinary nested condition", () => {
    // Two `not`s cancel, so this is the underlying comparison - and it is nowhere near the ceiling.
    expect(evalCondition(nest(2), ctx({ days: 5 }))).toBe(true);
    expect(evalCondition(nest(3), ctx({ days: 5 }))).toBe(false);
  });

  it("refuses to author a condition nested past the ceiling", () => {
    const rule = { name: "deep", triggerType: "leave.approved", condition: nest(5000), actions: [{ kind: "notify", title: "hi", recipient: { of: "subject" } }] };
    const errors = validateAutomation(rule as unknown as Automation);
    expect(errors.some((e) => /nesting too deep/.test(e))).toBe(true);
  });

  // The evaluator carries the bound too, not just the validator: a row can predate the validator (a seed, a
  // direct write, an older build), and this is the path that runs per event. Past the ceiling the condition is
  // treated as UNMET - the rule declines to fire rather than firing on everything or blowing the stack.
  //
  // BOTH PARITIES, because the first attempt at this bound returned `false` at the depth limit and handed it
  // back to the enclosing `not`s - so an odd number of them inverted the refusal into `true` and the rule
  // would have fired on everything. The ceiling unwinds the whole evaluation now; these two cases are what
  // tells the difference.
  it("evaluates a condition past the ceiling as unmet, whatever its nesting parity", () => {
    for (const n of [50_000, 50_001]) {
      expect(() => evalCondition(nest(n), ctx({ days: 5 }))).not.toThrow();
      expect(evalCondition(nest(n), ctx({ days: 5 })), `nesting ${n}`).toBe(false);
    }
  });
});

// The ROOT lookup is own-property too, not `in`.
//
// `resolveField`'s roots bag is a plain object literal, so `in` consulted Object.prototype: `toString`,
// `valueOf`, `constructor`, `hasOwnProperty` and `__proto__` all answered true and handed back Object
// internals as the resolved value. The loop that walks the REST of a dotted path had guarded against exactly
// that since it was written - its comment names `constructor`/`__proto__` - but the guard was on the tail
// while the segment that decides where the walk STARTS was unprotected. Nothing is invoked here, so this was
// a correctness hole rather than an execution one: a condition on such a name matched every event, which is
// the outcome ("the rule fires on everything") the bound exists to prevent.
describe("automations - resolveField does not walk the prototype chain", () => {
  const c = ctx({ days: 5 });

  it("resolves an inherited name to undefined, not to an Object internal", () => {
    for (const name of ["toString", "valueOf", "constructor", "hasOwnProperty", "isPrototypeOf", "__proto__"]) {
      expect(resolveField(c, name)).toBeUndefined();
      expect(evalCondition({ field: name, op: "exists" }, c)).toBe(false);
      expect(evalCondition({ field: name, op: "notExists" }, c)).toBe(true);
    }
    expect(resolveField(c, "__proto__.constructor")).toBeUndefined();
  });

  it("a payload key that happens to share the name still resolves", () => {
    // An inherited name is not a reserved word - it just is not a ROOT. Falling through to the payload is the
    // same rule every other bare name follows.
    expect(resolveField(ctx({ toString: "hello" }), "toString")).toBe("hello");
  });

  it("the real roots are untouched", () => {
    expect(resolveField(c, "type")).toBe("leave.approved");
    expect(resolveField(c, "employeeId")).toBe("e1");
    expect(resolveField(c, "payload.days")).toBe(5);
    expect(resolveField(c, "days")).toBe(5);
    // Declared-but-unset roots stay roots (they resolve to undefined rather than indexing the payload).
    expect(resolveField(ctx({ now: "from-payload" }), "now")).toBeUndefined();
    expect(resolveField(ctx({}, { now: "2026-09-13T00:00:00Z" }), "now")).toBe("2026-09-13T00:00:00Z");
  });
});
