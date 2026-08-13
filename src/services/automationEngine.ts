// The automation engine: turns emitted events into the "next logical step". Loads enabled `automations` rows
// matching an event's type, evaluates each rule's condition, runs its actions, and records `automation_runs`.
// BEST-EFFORT throughout - a bad rule or failing action is logged and skipped, never propagated to the action
// that emitted the event.
//
// Actions run with SYSTEM AUTHORITY: `apiCall` re-dispatches through the app's own middleware as the system
// principal (services/internalDispatch.ts); the notify family / emitEvent run via deps directly. The privileged
// act is AUTHORING a rule (gated hr_admin/super at the route). See docs/workflow-engine-plan.md (PR5).
//
// DURABLE EXECUTION: a `waitFor` action suspends the chain into a `workflow_instances` row and resumes when a
// correlated event is emitted (resume hook below) or a timer arm fires (cron `workflow.timer`). First arm wins
// (atomic claim). Data-passing: apiCall `captureAs` stores the response in the `results` bag, which later
// actions template into `path`/`body` via `{{...}}`.
import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { systemActor } from "../lib/systemActor";
import type { AppUser } from "../env";
import type { DomainEvent } from "../domain/events";
import { allocFlatCode } from "./codeAlloc";
import { notify, notifyManager, notifyAudience, audienceEmployeeIds } from "./notifications";
import type { Action, Automation, EvalContext, RecipientSpec, WaitArm, Schedule, EmailAttachmentSpec } from "../domain/automations";
import type { EmailAttachment } from "../ports";
import { evalCondition, resolveField, scheduleDueOn, SCHEDULE_TRIGGER } from "../domain/automations";
import { computeEmployeeMetrics, NEVER_TAKEN_LEAVE } from "./scheduledMetrics";
import { assertPublicHttpsUrl } from "../lib/urlGuard";
import { buildBankFile } from "./bankFile";
import { renderEmail, loadEmailBrand } from "../lib/emailLayout";

export { systemActor };

// A chain of `emitEvent` actions can re-trigger rules; refuse to recurse past this so a mis-authored loop can
// never self-fire forever (each hop increments depth). Carried across a durable suspend/resume too.
const MAX_EVENT_DEPTH = 5;

// Hard ceiling on the TOTAL number of automation dispatches per originating request. The per-event `depth`
// guard only bounds emitEvent->emitEvent chains; an `apiCall` re-dispatches a real request that emits its own
// events at depth 0, so without this a rule whose apiCall re-triggers its own trigger would loop forever as
// super. The counter lives on the shared Deps (reused by apiCall re-dispatch), so it accumulates across the
// whole synchronous fan-out and fails closed once exhausted.
const MAX_TOTAL_DISPATCHES = 50;

type AutomationRow = typeof schema.automations.$inferSelect;

// Short in-isolate cache of the enabled rule set (mirrors policyLoad's 5s TTL).
let cache: { at: number; rows: AutomationRow[] } | null = null;
const CACHE_TTL_MS = 5000;

async function loadEnabled(deps: Deps): Promise<AutomationRow[]> {
  const now = +deps.clock.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.rows;
  const rows = await deps.db
    .select()
    .from(schema.automations)
    .where(eq(schema.automations.disabled, false));
  cache = { at: now, rows };
  return rows;
}

export function invalidateAutomationCache(): void {
  cache = null;
}

function parseAutomation(row: AutomationRow): Automation {
  return {
    name: row.name,
    triggerType: row.triggerType,
    condition: row.conditionJson ? JSON.parse(row.conditionJson) : null,
    actions: JSON.parse(row.actionsJson) as Action[],
    enabled: !row.disabled,
    schedule: row.scheduleJson ? (JSON.parse(row.scheduleJson) as Schedule) : null,
  };
}

const nowIso = () => new Date().toISOString();
function contextOf(event: DomainEvent): EvalContext {
  const now = nowIso();
  return { type: event.type, subject: event.subject, actorId: event.actorId, employeeId: event.employeeId, payload: event.payload, results: {}, now, today: now.slice(0, 10) };
}

// {{path}} templating over the eval context + results bag. A string that is EXACTLY one placeholder returns the
// raw resolved value (so an object/number/path survives); otherwise placeholders are interpolated into the string.
function template(value: unknown, ctx: EvalContext): unknown {
  if (typeof value === "string") {
    const whole = value.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
    if (whole) return resolveField(ctx, whole[1]!.trim());
    return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, e: string) => {
      const v = resolveField(ctx, e.trim());
      return v == null ? "" : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => template(v, ctx));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue; // no prototype pollution via templated body
      out[k] = template(v, ctx);
    }
    return out;
  }
  return value;
}

// Resolve an action's recipient spec to an employee uuid (notifications are employee-owned).
async function resolveRecipient(deps: Deps, ctx: EvalContext, spec: RecipientSpec): Promise<string | null> {
  if (spec.of === "subject") return ctx.employeeId ?? null;
  if (spec.of === "actor") {
    if (!ctx.actorId) return null;
    const u = (await deps.db.select({ employeeId: schema.users.employeeId }).from(schema.users).where(eq(schema.users.uuid, ctx.actorId)).limit(1))[0];
    return u?.employeeId ?? null;
  }
  if (spec.of === "managerOf") {
    if (!ctx.employeeId) return null;
    const e = (await deps.db.select({ managerId: schema.employees.managerId }).from(schema.employees).where(eq(schema.employees.uuid, ctx.employeeId)).limit(1))[0];
    return e?.managerId ?? null;
  }
  if (spec.of === "ref" && spec.field) {
    const raw = resolveField(ctx, spec.field);
    if (typeof raw !== "string") return null;
    const slash = raw.indexOf("/");
    return slash >= 0 ? raw.slice(slash + 1) : raw; // accept "employees/<id>" or a bare uuid
  }
  return null;
}

// Resolve an email action's attachment specs to file bytes. Each spec references a stored document by a
// templated wire path "<collection>/<id>"; only doc-bearing collections on this allowlist resolve. Best-effort:
// a missing / unknown / unreadable doc is skipped (logged), never aborts the email. `docs.get` returns
// plaintext (the DocumentStore decrypts at rest), so bytes attach directly.
async function resolveAttachments(deps: Deps, ctx: EvalContext, specs: EmailAttachmentSpec[] | undefined): Promise<EmailAttachment[]> {
  if (!specs?.length) return [];
  const out: EmailAttachment[] = [];
  for (const spec of specs) {
    try {
      // Generated attachment: the payroll bank-transfer file for a run + bank format.
      if ("bankFile" in spec) {
        const run = String(template(spec.bankFile.run, ctx));
        const runId = run.includes("/") ? run.slice(run.indexOf("/") + 1) : run; // accept "payroll-runs/<id>" or a bare uuid
        const bank = String(template(spec.bankFile.bank, ctx));
        const { bytes, fileName } = await buildBankFile(deps, runId, bank);
        out.push({ filename: spec.filename || fileName, content: bytes, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
        continue;
      }
      // Stored document, referenced by wire path "<collection>/<id>".
      const ref = String(template(spec.document, ctx));
      const slash = ref.indexOf("/");
      if (slash < 0) continue;
      const collection = ref.slice(0, slash);
      const id = ref.slice(slash + 1);
      let r2Key: string | null = null;
      let filename = spec.filename ?? "";
      let contentType = "application/pdf";
      if (collection === "payslips") {
        const row = (await deps.db.select({ r2Key: schema.payslips.r2Key }).from(schema.payslips).where(eq(schema.payslips.uuid, id)).limit(1))[0];
        r2Key = row?.r2Key ?? null;
        filename ||= "Payslip.pdf";
      } else if (collection === "personal-documents") {
        const row = (await deps.db.select({ r2Key: schema.personalDocuments.r2Key, fileName: schema.personalDocuments.fileName, title: schema.personalDocuments.title, contentType: schema.personalDocuments.contentType, deleteTime: schema.personalDocuments.deleteTime }).from(schema.personalDocuments).where(eq(schema.personalDocuments.uuid, id)).limit(1))[0];
        if (row && !row.deleteTime) { r2Key = row.r2Key; filename ||= row.fileName || `${row.title}.pdf`; contentType = row.contentType || "application/pdf"; }
      } else if (collection === "org-documents") {
        const row = (await deps.db.select({ r2Key: schema.orgDocuments.r2Key, fileName: schema.orgDocuments.fileName, title: schema.orgDocuments.title, contentType: schema.orgDocuments.contentType, deleteTime: schema.orgDocuments.deleteTime, disabled: schema.orgDocuments.disabled }).from(schema.orgDocuments).where(eq(schema.orgDocuments.uuid, id)).limit(1))[0];
        if (row && !row.deleteTime && !row.disabled) { r2Key = row.r2Key; filename ||= row.fileName || `${row.title}.pdf`; contentType = row.contentType || "application/pdf"; }
      } else if (collection === "attachments") {
        const row = (await deps.db.select({ r2Key: schema.attachments.r2Key, fileName: schema.attachments.fileName, contentType: schema.attachments.contentType }).from(schema.attachments).where(eq(schema.attachments.uuid, id)).limit(1))[0];
        if (row) { r2Key = row.r2Key; filename ||= row.fileName || "attachment"; contentType = row.contentType || "application/octet-stream"; }
      } else {
        continue; // collection not on the attachable allowlist
      }
      if (!r2Key) continue;
      const buf = await deps.docs.get(r2Key);
      if (!buf) continue;
      out.push({ filename, content: new Uint8Array(buf), contentType });
    } catch (e) {
      console.error("[automationEngine] attachment resolve failed (non-fatal)", e);
    }
  }
  return out;
}

type ActionOutcome = { kind: string; status: "done" | "skipped" | "error" | "suspended"; detail?: string };

// Run one action with system authority. Mutates `ctx.results` for captures. Never throws (caller also guards).
async function runAction(deps: Deps, ctx: EvalContext, event: DomainEvent, action: Action, depth: number): Promise<ActionOutcome> {
  switch (action.kind) {
    case "notify": {
      const recipient = await resolveRecipient(deps, ctx, action.recipient);
      if (!recipient) return { kind: action.kind, status: "skipped", detail: "no recipient" };
      await notify(deps, { recipient, type: action.type ?? event.type, title: String(template(action.title, ctx)), body: action.body ? String(template(action.body, ctx)) : null, link: action.link ?? null, subject: event.subject ?? undefined, action: action.action ?? null });
      return { kind: action.kind, status: "done" };
    }
    case "notifyManager": {
      if (!ctx.employeeId) return { kind: action.kind, status: "skipped", detail: "no employee" };
      await notifyManager(deps, ctx.employeeId, { type: action.type ?? event.type, noun: action.noun });
      return { kind: action.kind, status: "done" };
    }
    case "notifyAudience": {
      // Template the audience too, so a rule can target a department/employees carried in the event
      // (e.g. { kind: "department", department: "{{departmentId}}" }).
      const audience = template(action.audience, ctx) as typeof action.audience;
      await notifyAudience(deps, audience, { type: action.type ?? event.type, title: String(template(action.title, ctx)), body: action.body ? String(template(action.body, ctx)) : null, link: action.link ?? null });
      return { kind: action.kind, status: "done" };
    }
    case "apiCall": {
      if (!deps.dispatch) return { kind: action.kind, status: "error", detail: "dispatch not configured" };
      const path = String(template(action.path, ctx));
      const body = action.body !== undefined ? template(action.body, ctx) : undefined;
      const res = await deps.dispatch(action.method, path, body);
      if (action.captureAs) (ctx.results ??= {})[action.captureAs] = res.body;
      if (res.status >= 400) return { kind: action.kind, status: "error", detail: `${action.method} ${path} -> ${res.status}` };
      return { kind: action.kind, status: "done", detail: `${action.method} ${path} -> ${res.status}` };
    }
    case "emitEvent": {
      if (depth + 1 > MAX_EVENT_DEPTH) return { kind: action.kind, status: "skipped", detail: "max event depth" };
      const { emitEvent } = await import("./eventBus");
      await emitEvent(deps, systemActor(), action.type, { subject: event.subject, employeeId: event.employeeId, payload: (template(action.payload ?? event.payload, ctx) as Record<string, unknown>), depth: depth + 1 });
      return { kind: action.kind, status: "done" };
    }
    case "wait": {
      const delayMs = (action.delayDays ?? 0) * 86_400_000 + (action.delayHours ?? 0) * 3_600_000;
      const runAfter = new Date(+deps.clock.now() + delayMs);
      await deps.db.insert(schema.jobs).values({
        code: await allocFlatCode(deps, schema.jobs),
        kind: "automation.action",
        payload: JSON.stringify({ actions: action.then, event, ctx, depth, correlationId: deps.trace }),
        employeeId: ctx.employeeId ?? null,
        runAfter,
      });
      return { kind: action.kind, status: "done", detail: `deferred to ${runAfter.toISOString()}` };
    }
    case "waitFor": {
      await suspend(deps, ctx, event, action.on, depth);
      return { kind: action.kind, status: "suspended", detail: `awaiting ${action.on.length} arm(s)` };
    }
    case "webhook": {
      if (!deps.webhook) return { kind: action.kind, status: "skipped", detail: "webhook egress not configured" };
      try {
        assertPublicHttpsUrl(action.url);
      } catch (e) {
        return { kind: action.kind, status: "error", detail: String(e instanceof Error ? e.message : e) };
      }
      const body: Record<string, unknown> = { type: event.type, subject: event.subject, employeeId: event.employeeId };
      if (action.includeFields) for (const f of action.includeFields) body[f] = event.payload[f];
      else body.payload = event.payload;
      await deps.webhook.post(action.url, body);
      return { kind: action.kind, status: "done" };
    }
    case "email": {
      // A literal address targets no employee; every other kind resolves to an employee's work email.
      let to: string | null;
      if (action.to.of === "address") {
        to = String(template(action.to.address, ctx)).trim() || null;
      } else {
        const recipient = await resolveRecipient(deps, ctx, action.to);
        if (!recipient) return { kind: action.kind, status: "skipped", detail: "no recipient" };
        const emp = (await deps.db.select({ workEmail: schema.employees.workEmail }).from(schema.employees).where(eq(schema.employees.uuid, recipient)).limit(1))[0];
        to = emp?.workEmail ?? null;
      }
      if (!to) return { kind: action.kind, status: "skipped", detail: "recipient has no email" };
      const subject = String(template(action.subject, ctx));
      const atts = await resolveAttachments(deps, ctx, action.attachments);
      const html = renderEmail({ heading: subject, preheader: subject, bodyHtml: String(template(action.html, ctx)) }, await loadEmailBrand(deps));
      await deps.email.send(to, subject, html, atts);
      return { kind: action.kind, status: "done", detail: `emailed ${to}${atts.length ? ` (+${atts.length} attachment)` : ""}` };
    }
    case "emailAudience": {
      const audience = template(action.audience, ctx) as typeof action.audience;
      const ids = await audienceEmployeeIds(deps, audience);
      if (!ids.length) return { kind: action.kind, status: "skipped", detail: "empty audience" };
      const subject = String(template(action.subject, ctx));
      // Wrap the body in the branded shell once (same message for every recipient); load the brand once.
      const html = renderEmail({ heading: subject, preheader: subject, bodyHtml: String(template(action.html, ctx)) }, await loadEmailBrand(deps));
      // One read for the addresses; then fan out (best-effort per recipient - a bad address never aborts the rest).
      let sent = 0;
      const CHUNK = 90; // D1 binds ~100 params per statement
      for (let i = 0; i < ids.length; i += CHUNK) {
        const emps = await deps.db.select({ workEmail: schema.employees.workEmail }).from(schema.employees).where(inArray(schema.employees.uuid, ids.slice(i, i + CHUNK)));
        for (const e of emps) {
          if (!e.workEmail) continue;
          try { await deps.email.send(e.workEmail, subject, html); sent++; } catch (err) { console.error("[automationEngine] emailAudience send failed (non-fatal)", err); }
        }
      }
      return { kind: action.kind, status: "done", detail: `emailed ${sent} recipient(s)` };
    }
    default:
      return { kind: (action as Action).kind, status: "error", detail: "unknown action kind" };
  }
}

// Run a list of actions in order (best-effort per action). Stops after a `waitFor` (terminal - it suspends).
async function runActions(deps: Deps, ctx: EvalContext, event: DomainEvent, actions: Action[], depth: number): Promise<ActionOutcome[]> {
  const outcomes: ActionOutcome[] = [];
  for (const action of actions) {
    try {
      const outcome = await runAction(deps, ctx, event, action, depth);
      outcomes.push(outcome);
      if (outcome.status === "suspended") break;
    } catch (e) {
      outcomes.push({ kind: action.kind, status: "error", detail: String(e) });
    }
  }
  return outcomes;
}

// ---- Durable suspend / resume ----

// Persist a suspended workflow and register any timer arms as durable timers (jobs with run_after). The full
// eval context (payload + captured results) is snapshotted so the continuation resumes with everything it had.
async function suspend(deps: Deps, ctx: EvalContext, event: DomainEvent, arms: WaitArm[], depth: number): Promise<void> {
  const awaitedTypes = arms.filter((a): a is Extract<WaitArm, { event: string }> => "event" in a).map((a) => a.event);
  const [inst] = await deps.db
    .insert(schema.workflowInstances)
    .values({
      code: await allocFlatCode(deps, schema.workflowInstances),
      status: "waiting",
      awaitedTypes: awaitedTypes.join(","),
      armsJson: JSON.stringify(arms),
      resultsJson: JSON.stringify(ctx),
      correlationId: deps.trace ?? null,
      originType: event.type,
      subject: event.subject ?? null,
      employeeId: ctx.employeeId ?? null,
      depth,
    })
    .returning();
  // Timer arms -> durable timers on the jobs queue; the cron drain fires them when due.
  for (let i = 0; i < arms.length; i++) {
    const arm = arms[i]!;
    if ("timer" in arm) {
      const delayMs = (arm.timer.days ?? 0) * 86_400_000 + (arm.timer.hours ?? 0) * 3_600_000;
      await deps.db.insert(schema.jobs).values({
        code: await allocFlatCode(deps, schema.jobs),
        kind: "workflow.timer",
        payload: JSON.stringify({ instanceId: inst!.uuid, armIndex: i }),
        runAfter: new Date(+deps.clock.now() + delayMs),
      });
    }
  }
}

// Atomically flip a waiting instance to `done` (first arm wins). Returns the row if THIS caller won the race.
async function claim(deps: Deps, instanceId: string): Promise<typeof schema.workflowInstances.$inferSelect | null> {
  const rows = await deps.db
    .update(schema.workflowInstances)
    .set({ status: "done", resumedAt: deps.clock.now(), updatedAt: new Date() })
    .where(and(eq(schema.workflowInstances.uuid, instanceId), eq(schema.workflowInstances.status, "waiting")))
    .returning();
  return rows[0] ?? null;
}

// Does a resuming event satisfy an event arm's correlation? Match on the instance's captured employeeId
// (default) or subject - the two values persisted at suspend time.
function armMatches(inst: typeof schema.workflowInstances.$inferSelect, arm: Extract<WaitArm, { event: string }>, event: DomainEvent): boolean {
  if (arm.event !== event.type) return false;
  const field = arm.match ?? "employeeId";
  if (field === "subject") return !!inst.subject && inst.subject === (event.subject ?? null);
  return !!inst.employeeId && inst.employeeId === (event.employeeId ?? null); // default: same employee
}

function ctxFromInstance(inst: typeof schema.workflowInstances.$inferSelect, resumeEvent?: DomainEvent): EvalContext {
  const ctx: EvalContext = inst.resultsJson ? JSON.parse(inst.resultsJson) : { type: inst.originType ?? "", payload: {}, results: {} };
  ctx.results ??= {};
  // Refresh the execution-time clock so a resumed continuation stamps {{today}}/{{now}} as of resume, not suspend.
  ctx.now = nowIso();
  ctx.today = ctx.now.slice(0, 10);
  if (resumeEvent) ctx.results.resumeEvent = resumeEvent.payload;
  return ctx;
}

// Resume any waiting workflows whose event arm matches this event. Called by dispatchAutomations after the
// normal rules. First matching arm per instance wins; the atomic claim guards against double-resume.
async function resumeWaiting(deps: Deps, event: DomainEvent, depth: number): Promise<number> {
  const waiting = await deps.db.select().from(schema.workflowInstances).where(eq(schema.workflowInstances.status, "waiting"));
  let resumed = 0;
  for (const inst of waiting) {
    if (inst.awaitedTypes && !inst.awaitedTypes.split(",").includes(event.type)) continue; // cheap prefilter
    let arms: WaitArm[];
    try { arms = JSON.parse(inst.armsJson) as WaitArm[]; } catch { continue; }
    const arm = arms.find((a): a is Extract<WaitArm, { event: string }> => "event" in a && armMatches(inst, a, event));
    if (!arm) continue;
    if (!(await claim(deps, inst.uuid))) continue; // lost the race (another arm/timer already fired)
    const ctx = ctxFromInstance(inst, event);
    const prevTrace = deps.trace;
    deps.trace = inst.correlationId ?? prevTrace; // the continuation belongs to the original saga's trace
    try { await runActions(deps, ctx, event, arm.then, inst.depth); } finally { deps.trace = prevTrace; }
    resumed++;
  }
  return resumed;
}

async function recordRun(deps: Deps, automationId: string, eventId: string | null, event: DomainEvent, start: number, outcomes: ActionOutcome[]): Promise<void> {
  const anyErr = outcomes.some((o) => o.status === "error");
  const anyDone = outcomes.some((o) => o.status === "done" || o.status === "suspended");
  const allSkip = outcomes.length > 0 && outcomes.every((o) => o.status === "skipped");
  const status = anyErr ? (anyDone ? "partial" : "error") : allSkip ? "skipped" : "done";
  try {
    await deps.db.insert(schema.automationRuns).values({
      code: await allocFlatCode(deps, schema.automationRuns),
      automationId,
      eventId,
      eventType: event.type,
      // Denormalize what/who the run was about + the workflow trace, so the UI shows cause and can group.
      subject: event.subject ?? null,
      employeeId: event.employeeId ?? null,
      correlationId: deps.trace ?? null,
      status,
      resultJson: JSON.stringify(outcomes),
      startedAt: new Date(start),
      finishedAt: deps.clock.now(),
    });
  } catch (e) {
    console.error("[automationEngine] automation_runs insert failed (non-fatal)", e);
  }
}

// Entry point called by emitEvent: run every enabled rule that matches, then resume any waiting workflows. Never throws.
export async function dispatchAutomations(deps: Deps, event: DomainEvent, eventId: string | null, depth: number): Promise<void> {
  if (depth > MAX_EVENT_DEPTH) return;
  const budget = (deps.automationBudget ??= { n: 0 });
  if (budget.n >= MAX_TOTAL_DISPATCHES) {
    console.warn(`[automationEngine] dispatch budget exhausted (${MAX_TOTAL_DISPATCHES}); dropping ${event.type}`);
    return;
  }
  budget.n++;
  const rules = (await loadEnabled(deps)).filter((r) => r.triggerType === event.type);
  for (const row of rules) {
    let automation: Automation;
    try {
      automation = parseAutomation(row);
    } catch (e) {
      console.error(`[automationEngine] rule ${row.uuid} has malformed JSON (skipped)`, e);
      continue;
    }
    const ctx = contextOf(event); // fresh results bag per rule
    if (!evalCondition(automation.condition, ctx)) continue;
    const start = +deps.clock.now();
    const outcomes = await runActions(deps, ctx, event, automation.actions, depth);
    await recordRun(deps, row.uuid, eventId, event, start, outcomes);
  }
  try {
    await resumeWaiting(deps, event, depth);
  } catch (e) {
    console.error("[automationEngine] resumeWaiting failed (non-fatal)", e);
  }
}

// Daily scanner: fire the time-driven ("schedule.recurring") rules whose recurrence matches today. Called
// from the cron day-tick. Each rule is claimed with a guarded per-day stamp so a re-run of the tick can't
// double-fire it. A `perEmployee` rule fans out one firing per active employee, carrying derived metrics in
// the payload (so conditions stay smart); a `once` rule fires a single employee-less firing (for
// notifyAudience / apiCall broadcasts). Returns how many firings ran their actions. Never throws.
export async function runScheduledAutomations(deps: Deps): Promise<number> {
  const now = deps.clock.now();
  const today = new Date(+now);
  const todayStr = today.toISOString().slice(0, 10);
  const scheduled = (await loadEnabled(deps)).filter((r) => r.triggerType === SCHEDULE_TRIGGER && r.scheduleJson);
  let fired = 0;
  // Metrics + roster are shared across perEmployee rules and computed lazily (only if one is actually due).
  let roster: { uuid: string; managerId: string | null }[] | null = null;
  let metrics: Awaited<ReturnType<typeof computeEmployeeMetrics>> | null = null;

  for (const row of scheduled) {
    let automation: Automation;
    let schedule: Schedule;
    try {
      automation = parseAutomation(row);
      schedule = JSON.parse(row.scheduleJson!) as Schedule;
    } catch (e) {
      console.error(`[automationEngine] scheduled rule ${row.uuid} malformed (skipped)`, e);
      continue;
    }
    if (!scheduleDueOn(schedule, today)) continue;
    // Atomically claim the day: the guarded update wins at most once per rule per date.
    const claimed = await deps.db
      .update(schema.automations)
      .set({ lastScheduledOn: todayStr, updatedAt: new Date() })
      .where(and(eq(schema.automations.uuid, row.uuid), or(isNull(schema.automations.lastScheduledOn), ne(schema.automations.lastScheduledOn, todayStr))))
      .returning({ uuid: schema.automations.uuid });
    if (!claimed.length) continue;

    const base = { weekday: today.getUTCDay(), dayOfMonth: today.getUTCDate() };
    const run = async (event: DomainEvent) => {
      const ctx = contextOf(event);
      if (!evalCondition(automation.condition, ctx)) return;
      const start = +deps.clock.now();
      const outcomes = await runActions(deps, ctx, event, automation.actions, 0);
      await recordRun(deps, row.uuid, null, event, start, outcomes);
      fired++;
    };

    if ((schedule.scope ?? "once") === "once") {
      await run({ type: SCHEDULE_TRIGGER, subject: null, actorId: null, employeeId: null, payload: base, occurredAt: now });
      continue;
    }

    // perEmployee: compute the roster + metrics once, then fan out one firing per active employee.
    if (!roster) {
      const emps = await deps.db.select({ uuid: schema.employees.uuid, managerId: schema.employees.managerId, deleteTime: schema.employees.deleteTime, status: schema.employees.status }).from(schema.employees);
      roster = emps.filter((e) => !e.deleteTime && e.status === "active").map((e) => ({ uuid: e.uuid, managerId: e.managerId }));
    }
    if (!metrics) metrics = await computeEmployeeMetrics(deps, roster);
    for (const emp of roster) {
      const m = metrics.get(emp.uuid);
      await run({
        type: SCHEDULE_TRIGGER,
        subject: `employees/${emp.uuid}`,
        actorId: null,
        employeeId: emp.uuid,
        payload: { ...base, pendingApprovals: m?.pendingApprovals ?? 0, daysSinceLastLeave: m?.daysSinceLastLeave ?? NEVER_TAKEN_LEAVE, leaveBalanceDays: m?.leaveBalanceDays ?? 0, goalsDueSoon: m?.goalsDueSoon ?? 0, goalsOverdue: m?.goalsOverdue ?? 0 },
        occurredAt: now,
      });
    }
  }
  return fired;
}

// Run a deferred (`wait`) automation payload - called by the cron drain when the job's runAfter has passed.
export async function runDeferredActions(deps: Deps, payload: { actions: Action[]; event: DomainEvent; ctx?: EvalContext; depth: number; correlationId?: string }): Promise<void> {
  const event = { ...payload.event, occurredAt: new Date(payload.event.occurredAt) };
  const ctx = payload.ctx ?? contextOf(event);
  deps.trace = payload.correlationId ?? undefined; // resume under the original workflow's trace (fresh Deps per cron job)
  try { await runActions(deps, ctx, event, payload.actions, payload.depth); } finally { deps.trace = undefined; }
}

// Fire a durable timer arm of a suspended workflow - called by the cron drain for a `workflow.timer` job.
export async function runWorkflowTimer(deps: Deps, payload: { instanceId: string; armIndex: number }): Promise<void> {
  const inst = (await deps.db.select().from(schema.workflowInstances).where(eq(schema.workflowInstances.uuid, payload.instanceId)).limit(1))[0];
  if (!inst || inst.status !== "waiting") return; // already resumed by another arm (race resolved)
  let arms: WaitArm[];
  try { arms = JSON.parse(inst.armsJson) as WaitArm[]; } catch { return; }
  const arm = arms[payload.armIndex];
  if (!arm || !("timer" in arm)) return;
  if (!(await claim(deps, inst.uuid))) return; // lost the race
  const ctx = ctxFromInstance(inst);
  const event: DomainEvent = { type: inst.originType ?? "", subject: inst.subject, actorId: null, employeeId: inst.employeeId, payload: {}, occurredAt: deps.clock.now() };
  deps.trace = inst.correlationId ?? undefined; // resume under the original saga trace (fresh Deps per cron job)
  try { await runActions(deps, ctx, event, arm.then, inst.depth); } finally { deps.trace = undefined; }
}
