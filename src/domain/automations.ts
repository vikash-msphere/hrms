// Automation rules as data (PURE - no I/O). A rule is `when <triggerType> [if <condition>] then <actions[]>`.
// The condition is a JSON PREDICATE TREE, never code (Worker security: no eval / no dynamic import), so a rule
// authored in the UI can't become an RCE vector. The action list is a discriminated union with a fixed kind
// set; the engine (services/automationEngine.ts) owns the I/O handlers, this file owns the shapes + the pure
// evaluator + validation.
import { isKnownEventType, fieldsForEventType } from "./events";

// ---- Conditions ----
export const COMPARE_OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "contains", "exists", "notExists"] as const;
export type CompareOp = (typeof COMPARE_OPS)[number];
// Recipient kinds a notify action can target (the builder's recipient dropdown reads this).
export const RECIPIENT_KINDS = ["subject", "actor", "managerOf", "ref"] as const;
export type Comparison = { field: string; op: CompareOp; value?: unknown };
export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | Comparison;

const isComparison = (c: Condition): c is Comparison => typeof (c as Comparison).field === "string";

// Flat evaluation context the engine builds from a DomainEvent: the common fields at top level, the payload,
// and the `results` bag (outputs captured by earlier actions via apiCall `captureAs`, for data-passing chains).
export type EvalContext = {
  type: string;
  subject?: string | null;
  actorId?: string | null;
  employeeId?: string | null;
  payload: Record<string, unknown>;
  results?: Record<string, unknown>;
  now?: string; // execution-time ISO instant, for {{now}} in templates (set by the engine)
  today?: string; // execution-time date (YYYY-MM-DD), for {{today}} - e.g. an apiCall's award_date/effective date
};

// Resolve a field/template path to a value. Roots: `type`/`subject`/`actorId`/`employeeId`/`payload`/`results`;
// a bare name (or dotted path with no known root) indexes into the payload (e.g. "days", "meta.reason"); a
// `results.x.y` path walks the results bag (e.g. "results.emp.path"). Missing = undefined.
export function resolveField(ctx: EvalContext, path: string): unknown {
  const roots: Record<string, unknown> = { type: ctx.type, subject: ctx.subject, actorId: ctx.actorId, employeeId: ctx.employeeId, payload: ctx.payload, results: ctx.results ?? {}, now: ctx.now, today: ctx.today };
  const parts = path.split(".");
  let cur: unknown;
  if (parts[0]! in roots) { cur = roots[parts[0]!]; parts.shift(); }
  else cur = ctx.payload; // bare name(s) index into the payload
  for (const p of parts) {
    // own-property only: never walk the prototype chain (so `constructor`/`__proto__` resolve to undefined,
    // not to Object internals).
    if (cur && typeof cur === "object" && Object.prototype.hasOwnProperty.call(cur, p)) cur = (cur as Record<string, unknown>)[p];
    else return undefined;
  }
  return cur;
}

function evalComparison(c: Comparison, ctx: EvalContext): boolean {
  const actual = resolveField(ctx, c.field);
  switch (c.op) {
    case "exists": return actual !== undefined && actual !== null;
    case "notExists": return actual === undefined || actual === null;
    case "eq": return actual === c.value;
    case "ne": return actual !== c.value;
    case "gt": return typeof actual === "number" && typeof c.value === "number" && actual > c.value;
    case "gte": return typeof actual === "number" && typeof c.value === "number" && actual >= c.value;
    case "lt": return typeof actual === "number" && typeof c.value === "number" && actual < c.value;
    case "lte": return typeof actual === "number" && typeof c.value === "number" && actual <= c.value;
    case "in": return Array.isArray(c.value) && (c.value as unknown[]).includes(actual);
    case "contains":
      if (typeof actual === "string") return actual.includes(String(c.value));
      if (Array.isArray(actual)) return (actual as unknown[]).includes(c.value);
      return false;
    default: return false;
  }
}

// Evaluate a condition tree against the event context. A null/undefined condition = always true (unconditional).
export function evalCondition(cond: Condition | null | undefined, ctx: EvalContext): boolean {
  if (!cond) return true;
  if (isComparison(cond)) return evalComparison(cond, ctx);
  if ("all" in cond) return cond.all.every((c) => evalCondition(c, ctx));
  if ("any" in cond) return cond.any.some((c) => evalCondition(c, ctx));
  if ("not" in cond) return !evalCondition(cond.not, ctx);
  return false;
}

// ---- Actions ----
// Who an action targets, resolved by the engine to an employee uuid: the event's primary employee ("subject"),
// the actor, the subject's manager ("managerOf"), or an employee ref carried in a payload field ("ref").
// Who an action targets. subject/actor/managerOf/ref resolve to an EMPLOYEE (the only kinds notify can use).
// `address` is an email-only literal (templated) - it targets no employee, so notify/notifyManager ignore it
// and only the `email` action honours it (for a finance/HR distro or an external address).
export type RecipientSpec =
  | { of: "subject" | "actor" | "managerOf" | "ref"; field?: string }
  | { of: "address"; address: string };

// An email attachment. Two sources, resolved to file bytes by the engine (best-effort - unresolved = skipped):
//  - `document`: a STORED doc by templated wire path "<collection>/<id>" (e.g. "{{subject}}" -> "payslips/<id>").
//    Only doc-bearing collections on the engine's allowlist resolve (payslips / personal-documents /
//    org-documents / attachments).
//  - `bankFile`: GENERATED on demand - the payroll bank-transfer file for a run + bank format.
// `filename` optionally overrides the resolved/generated file name.
export type EmailAttachmentSpec =
  | { document: string; filename?: string }
  | { bankFile: { run: string; bank: string }; filename?: string };

// A branch of a `waitFor` selector: resume on a matching EVENT, or after a durable TIMER. `then` is the
// continuation run when this arm fires. Omit every timer arm = wait forever (durably). No hardcoded timeout.
export type WaitArm =
  | { event: string; match?: string; then: Action[] } // resume when `event` is emitted with matching correlation
  | { timer: { days?: number; hours?: number }; then: Action[] }; // resume after a durable timer

export type Action =
  // In-app notification to one resolved recipient.
  | { kind: "notify"; recipient: RecipientSpec; title: string; type?: string; body?: string; link?: string; action?: string }
  // Notify the event employee's manager (the natural approver), pointing at the Approvals inbox.
  | { kind: "notifyManager"; noun: string; type?: string }
  // Broadcast to an audience (everyone / a department / an explicit list).
  | { kind: "notifyAudience"; audience: { kind: "everyone" } | { kind: "department"; department: string } | { kind: "employees"; employees: string[] }; title: string; type?: string; body?: string; link?: string }
  // Call any endpoint through the app's own middleware (authz + validation + wire codec), as the system
  // principal. `path`/`body` support {{...}} templating over the context + results bag; `captureAs` stores the
  // response body into the bag for later actions to consume. This is how an action chains off another's output.
  | { kind: "apiCall"; method: string; path: string; body?: unknown; captureAs?: string }
  // Chain another domain event (loop-guarded by the engine's depth cap).
  | { kind: "emitEvent"; type: string; payload?: Record<string, unknown> }
  // Defer the wrapped actions by a fixed delay (enqueued on the jobs queue, run by the cron drain).
  | { kind: "wait"; delayDays?: number; delayHours?: number; then: Action[] }
  // Durable SUSPEND: pause the workflow until one of the arms fires (a matching event, or a timer). First arm
  // wins. Persisted as a workflow_instances row; survives restarts. `waitFor` must be the last action in a list
  // (continuation lives in each arm's `then`).
  | { kind: "waitFor"; on: WaitArm[] }
  // Outbound HTTP POST to an allowlisted URL (egress; off unless the webhook port is configured).
  | { kind: "webhook"; url: string; includeFields?: string[] }
  // Transactional email to one resolved recipient's work email. `subject`/`html` support {{...}} templating
  // over the context + results bag. `attachments` reference stored documents by wire path (e.g. the event
  // subject "payslips/<id>"), resolved to file bytes by the engine. Sent via the email port (best-effort; a
  // no-op if no provider is configured).
  | { kind: "email"; to: RecipientSpec; subject: string; html: string; attachments?: EmailAttachmentSpec[] }
  // Broadcast email to an audience (everyone / a department / an explicit list) - the email twin of
  // notifyAudience. Each active member with a work email gets one message. `subject`/`html` are templated.
  | { kind: "emailAudience"; audience: { kind: "everyone" } | { kind: "department"; department: string } | { kind: "employees"; employees: string[] }; subject: string; html: string };

export type Automation = {
  name: string;
  description?: string;
  triggerType: string;
  condition?: Condition | null;
  actions: Action[];
  enabled?: boolean;
  schedule?: Schedule | null;
};

export const ACTION_KINDS = ["notify", "notifyManager", "notifyAudience", "apiCall", "emitEvent", "wait", "waitFor", "webhook", "email", "emailAudience"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

// ---- Scheduled (time-driven) triggers ----
// The reserved trigger a scheduled rule uses instead of a domain event type. A rule with this trigger has a
// non-null `schedule`; a daily cron scanner (services/automationEngine.ts runScheduledAutomations) fires it
// when the recurrence matches today, synthesizing the event the actions run against. Makes the engine
// proactive - weekly nudges, month-start prep, quarter-start review kickoffs - all authored as data.
export const SCHEDULE_TRIGGER = "schedule.recurring";

// Recurrence spec for a scheduled rule.
//   freq "daily"   - every day.
//   freq "weekly"  - on `day` (0=Sun..6=Sat).
//   freq "monthly" - on `day` (1..28; capped so every month has it).
// `scope` decides who each firing is about:
//   "once"        - a single firing with no bound employee (for notifyAudience / apiCall broadcasts).
//   "perEmployee" - one firing PER active employee, with employeeId + subject bound (notify / notifyManager
//                   work, and the engine enriches derived metrics into the payload for smart conditions).
export const SCHEDULE_FREQS = ["daily", "weekly", "monthly"] as const;
export type ScheduleFreq = (typeof SCHEDULE_FREQS)[number];
export type ScheduleScope = "once" | "perEmployee";
export type Schedule = { freq: ScheduleFreq; day?: number; scope?: ScheduleScope };

export const isScheduled = (a: { triggerType: string }): boolean => a.triggerType === SCHEDULE_TRIGGER;

// Validate a recurrence spec (pushes into a shared error list, mirroring validateAutomation's style).
export function validateSchedule(s: Schedule | null | undefined, errors: string[]): void {
  if (!s) { errors.push("scheduled rule needs a schedule"); return; }
  if (!SCHEDULE_FREQS.includes(s.freq)) { errors.push(`schedule.freq "${s.freq}" is not daily/weekly/monthly`); return; }
  if (s.freq === "weekly" && (typeof s.day !== "number" || s.day < 0 || s.day > 6)) errors.push("weekly schedule needs day 0-6 (Sun-Sat)");
  if (s.freq === "monthly" && (typeof s.day !== "number" || s.day < 1 || s.day > 28)) errors.push("monthly schedule needs day 1-28");
  if (s.scope && s.scope !== "once" && s.scope !== "perEmployee") errors.push(`schedule.scope "${s.scope}" is not once/perEmployee`);
}

// Does this recurrence fire on the given date? `date` is a UTC instant; weekday/day-of-month read in UTC to
// match the cron tick's clock. Monthly `day` is clamped to the month's last day so day=28..31 still fire in
// short months (a rule set to "the 31st" fires on Feb 28).
export function scheduleDueOn(s: Schedule, date: Date): boolean {
  if (s.freq === "daily") return true;
  if (s.freq === "weekly") return date.getUTCDay() === (s.day ?? 1);
  // monthly
  const dom = Math.min(Math.max(s.day ?? 1, 1), 28);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  return date.getUTCDate() === Math.min(dom, lastDay);
}

// ---- Validation ---- (used by the write route AND the drift/round-trip test)
function validateCondition(cond: Condition, trigger: string, path: string, errors: string[]): void {
  if (isComparison(cond)) {
    const known = new Set(fieldsForEventType(trigger).map((f) => f.name));
    // A dotted path digs into the payload object - only validate the top bare-name form against the catalog.
    if (!cond.field.includes(".") && known.size > 0 && !known.has(cond.field)) {
      errors.push(`${path}: field "${cond.field}" is not a known field of "${trigger}"`);
    }
    return;
  }
  if ("all" in cond) cond.all.forEach((c, i) => validateCondition(c, trigger, `${path}.all[${i}]`, errors));
  else if ("any" in cond) cond.any.forEach((c, i) => validateCondition(c, trigger, `${path}.any[${i}]`, errors));
  else if ("not" in cond) validateCondition(cond.not, trigger, `${path}.not`, errors);
  else errors.push(`${path}: malformed condition`);
}

// Bound nesting of `then` continuations (wait/waitFor arms) so a mis-authored rule can't recurse without limit.
const MAX_ACTION_DEPTH = 6;

// A `waitFor` suspends the chain, so nothing after it in the same list would ever run - the continuation must
// live in each arm's `then`. Flag a non-terminal waitFor.
function checkTerminal(list: Action[], path: string, errors: string[]): void {
  list.forEach((a, i) => { if (a?.kind === "waitFor" && i !== list.length - 1) errors.push(`${path}[${i}]: waitFor must be the last action (put continuation in an arm's then)`); });
}

function validateAction(a: Action, trigger: string, path: string, errors: string[], depth: number): void {
  if (!a || typeof (a as Action).kind !== "string") { errors.push(`${path}: action needs a kind`); return; }
  if (!(ACTION_KINDS as readonly string[]).includes(a.kind)) { errors.push(`${path}: unknown action kind "${a.kind}"`); return; }
  if (depth > MAX_ACTION_DEPTH) { errors.push(`${path}: action nesting too deep`); return; }
  switch (a.kind) {
    case "notify": if (!a.title) errors.push(`${path}: notify needs a title`); if (!a.recipient?.of) errors.push(`${path}: notify needs a recipient`); break;
    case "notifyManager": if (!a.noun) errors.push(`${path}: notifyManager needs a noun`); break;
    case "notifyAudience": if (!a.title) errors.push(`${path}: notifyAudience needs a title`); if (!a.audience?.kind) errors.push(`${path}: notifyAudience needs an audience`); break;
    case "apiCall":
      if (!a.method) errors.push(`${path}: apiCall needs a method`);
      if (!a.path) errors.push(`${path}: apiCall needs a path`);
      else if (!a.path.startsWith("/v1/")) errors.push(`${path}: apiCall path must start with /v1/`);
      break;
    case "emitEvent": if (!a.type) errors.push(`${path}: emitEvent needs a type`); else if (!isKnownEventType(a.type)) errors.push(`${path}: emitEvent type "${a.type}" is not a known event`); break;
    case "wait":
      if ((a.delayDays ?? 0) <= 0 && (a.delayHours ?? 0) <= 0) errors.push(`${path}: wait needs a positive delay`);
      if (!a.then?.length) errors.push(`${path}: wait needs at least one deferred action`);
      else { checkTerminal(a.then, `${path}.then`, errors); a.then.forEach((x, i) => validateAction(x, trigger, `${path}.then[${i}]`, errors, depth + 1)); }
      break;
    case "waitFor":
      if (!a.on?.length) { errors.push(`${path}: waitFor needs at least one arm`); break; }
      a.on.forEach((arm, i) => {
        const p = `${path}.on[${i}]`;
        const isEvent = "event" in arm;
        const isTimer = "timer" in arm;
        if (!isEvent && !isTimer) errors.push(`${p}: arm needs an event or a timer`);
        if (isEvent && !isKnownEventType((arm as { event: string }).event)) errors.push(`${p}: event "${(arm as { event: string }).event}" is not a known event`);
        if (isTimer) { const t = (arm as { timer: { days?: number; hours?: number } }).timer; if ((t.days ?? 0) <= 0 && (t.hours ?? 0) <= 0) errors.push(`${p}: timer needs a positive delay`); }
        if (!arm.then?.length) errors.push(`${p}: arm needs at least one action in then`);
        else { checkTerminal(arm.then, `${p}.then`, errors); arm.then.forEach((x, j) => validateAction(x, isEvent ? (arm as { event: string }).event : trigger, `${p}.then[${j}]`, errors, depth + 1)); }
      });
      break;
    case "webhook": if (!a.url) errors.push(`${path}: webhook needs a url`); break;
    case "email":
      if (!a.to?.of) errors.push(`${path}: email needs a recipient`);
      else if (a.to.of === "address" && !a.to.address) errors.push(`${path}: email address recipient needs an address`);
      if (!a.subject) errors.push(`${path}: email needs a subject`);
      if (!a.html) errors.push(`${path}: email needs a body`);
      if (a.attachments) a.attachments.forEach((att, i) => {
        const p = `${path}.attachments[${i}]`;
        if (att && "bankFile" in att) { if (!att.bankFile?.run) errors.push(`${p}: bankFile needs a run`); if (!att.bankFile?.bank) errors.push(`${p}: bankFile needs a bank`); }
        else if (!att?.document) errors.push(`${p}: needs a document reference`);
      });
      break;
    case "emailAudience":
      if (!a.audience?.kind) errors.push(`${path}: emailAudience needs an audience`);
      if (!a.subject) errors.push(`${path}: emailAudience needs a subject`);
      if (!a.html) errors.push(`${path}: emailAudience needs a body`);
      break;
  }
}

// Returns a list of human-readable problems; empty = valid.
export function validateAutomation(a: Automation): string[] {
  const errors: string[] = [];
  if (!a.name) errors.push("name is required");
  if (!a.triggerType) errors.push("triggerType is required");
  else if (!isKnownEventType(a.triggerType)) errors.push(`triggerType "${a.triggerType}" is not a known event type`);
  if (isScheduled(a)) validateSchedule(a.schedule, errors);
  else if (a.schedule) errors.push("schedule is only valid when trigger is a scheduled recurrence");
  if (!Array.isArray(a.actions) || a.actions.length === 0) errors.push("at least one action is required");
  if (a.condition) validateCondition(a.condition, a.triggerType, "condition", errors);
  if (Array.isArray(a.actions)) checkTerminal(a.actions, "actions", errors);
  (a.actions ?? []).forEach((x, i) => validateAction(x, a.triggerType, `actions[${i}]`, errors, 0));
  return errors;
}
