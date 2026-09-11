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
import { evalCondition, hasPrivilegedAction, privilegedActionKinds, resolveField, scheduleDueOn, SCHEDULE_TRIGGER } from "../domain/automations";
import { computeEmployeeMetrics, NEVER_TAKEN_LEAVE } from "./scheduledMetrics";
import { orgToday, dayStartMs } from "./orgDay";
import { assertPublicHttpsUrl } from "../lib/urlGuard";
import { buildBankFile } from "./bankFile";
import { renderEmail, loadEmailBrand, escapeHtml } from "../lib/emailLayout";
import { fanOutEmail } from "./emailFanOut";

export { systemActor };

// A chain of `emitEvent` actions can re-trigger rules; refuse to recurse past this so a mis-authored loop can
// never self-fire forever (each hop increments depth). Carried across a durable suspend/resume too.
const MAX_EVENT_DEPTH = 5;

// Hard ceiling on the TOTAL number of automation dispatches per originating request. The per-event `depth`
// guard only bounds emitEvent->emitEvent chains; an `apiCall` re-dispatches a real request that emits its own
// events at depth 0, so without this a rule whose apiCall re-triggers its own trigger would loop forever as
// super. The counter lives on the shared Deps (reused by apiCall re-dispatch), so it accumulates across the
// whole synchronous fan-out and fails closed once exhausted.
//
// The unit it bounds is ONE ORIGINATING ACTION - a request, or one cron subtask, or one drained job. That
// distinction matters because the scheduled handler builds a single Deps for the whole nightly tick, so an
// unreset counter made this a budget for the entire NIGHT: past the fiftieth event, every later per-employee
// emission (probation, anniversary, document expiry, asset custody) and every subtask after the one that
// exhausted it were dropped. `withDispatchBudget` below is what re-arms it.
//
// WHY 250, AND WHAT IT MUST STAY ABOVE. This guard exists to stop a RUNAWAY - a rule that re-triggers itself
// without bound. It must never refuse a fan-out the app itself authored with a known ceiling. At 50 it did:
// `assets:batchCreate` accepts up to `ASSET_BATCH_MAX` (100) assets in one act and emits one `asset.created`
// per asset, so with any rule on that trigger the first fifty assets fired the rule and the last fifty were
// silently dropped - a 200 response, the full inventory written, and half the automations missing. The number
// therefore has to sit above the largest BOUNDED bulk act in the app; test/dispatchBudget.test.ts pins that
// relationship so a new bulk verb with a bigger ceiling cannot quietly reintroduce it. Exported for that test.
//
// It is still a hard bound, and the runaway case it was written for is unaffected: a self-triggering apiCall
// loop hits 250 as surely as it hit 50, one tick later.
export const MAX_TOTAL_DISPATCHES = 250;

/**
 * WHICH RULE THESE ACTIONS BELONG TO, and whether a super admin wrote it.
 *
 * `emitEvent` re-emits a domain event under the system principal with a type and payload the rule's author
 * chose, while the event's SUBJECT is inherited from whatever triggered that rule. A privileged rule whose
 * action templates the subject into its path - `POST /v1/{{subject}}:approve` is a shipped seed - therefore
 * acts on whichever record the RELAYING author pointed it at. Authoring `apiCall` is super-only, but authoring
 * `emitEvent` deliberately is not, so without this an hr_admin could reach the same super authority one hop
 * removed: trigger on an event carrying the subject they want, relay it as the type a privileged rule listens
 * for, and have that rule run as super against it.
 *
 * The rule's OWN action list cannot answer "was this authored by a super admin" - the seeded milestone relays
 * (`transition.completed` -> emitEvent `employee.onboarded`) hold nothing privileged and must keep driving the
 * privileged rules downstream of them - so the answer is stored per rule (`automations.super_authored`) and
 * carried here through every continuation: a deferred `wait`, a suspended `waitFor`, a resumed timer.
 *
 * `trusted: false` never blocks the rule's own actions. It only means the events this rule RELAYS may not
 * trigger a rule holding a privileged action (dispatchAutomations / resumeWaiting).
 */
type RuleOrigin = { automationId: string | null; trusted: boolean };

/** Fail-closed origin: no rule to attribute the actions to, so nothing it relays is trusted. */
const UNTRUSTED: RuleOrigin = { automationId: null, trusted: false };

/** The stored trust of one rule, off the engine's own cache where it can be (a resume is not a hot path, but
 *  it already costs a read per waiting instance). A rule that no longer exists is not trusted. */
async function originOf(deps: Deps, automationId: string | null): Promise<RuleOrigin> {
  if (!automationId) return UNTRUSTED;
  const cached = (await loadEnabled(deps)).find((r) => r.uuid === automationId);
  if (cached) return { automationId, trusted: !!cached.superAuthored };
  const row = (await deps.db.select({ superAuthored: schema.automations.superAuthored }).from(schema.automations).where(eq(schema.automations.uuid, automationId)).limit(1))[0];
  return { automationId, trusted: !!row?.superAuthored };
}

/**
 * Run `fn` with a FRESH dispatch budget, and report how many events the budget refused.
 *
 * Callers that own an originating action rather than a request (the cron subtasks) wrap themselves in this, so
 * each gets the full allowance and a rule loop inside one subtask cannot starve the next. The drop count comes
 * back so the caller can put it on the cron_runs row - the old behaviour logged a console.warn and left the
 * tick stamped `done`, which is how a night of skipped automations stayed green in the Operations UI.
 */
export async function withDispatchBudget<T>(deps: Deps, fn: () => Promise<T>): Promise<{ result: T; dropped: number }> {
  const prev = deps.automationBudget;
  const budget = { n: 0, dropped: 0 };
  deps.automationBudget = budget;
  try {
    return { result: await fn(), dropped: budget.dropped };
  } finally {
    deps.automationBudget = prev;
  }
}

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

/**
 * The same templating for a value that is going into an email's HTML BODY, with every substitution escaped.
 *
 * The markup is the rule author's, and authoring a rule is super-only - but the values folded into it are
 * ordinary user data: a person's own name, a ticket title they typed, the reason on a leave request. Through
 * plain `template` those arrive as markup, so anyone who can fill in one of those fields could write a link
 * (or a tracking image) into a mail the company sends under its own brand, to an audience the rule chooses.
 * The author's HTML is left exactly as written; only what is substituted in is escaped.
 */
function templateHtml(value: string, ctx: EvalContext): string {
  return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, e: string) => {
    const v = resolveField(ctx, e.trim());
    return v == null ? "" : escapeHtml(String(v));
  });
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
      // Only two of these four branches test soft-delete, and that is correct rather than an oversight:
      // `payslips` and `attachments` carry no `delete_time` column at all (see schema.ts - a payslip is
      // deleted with its run, an attachment with its parent row), so there is no deleted state for them to
      // be in. The two document collections do, and check it.
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
// `origin` is the rule these actions came from - carried so `emitEvent` can say whether what it relays is
// allowed to reach a privileged rule, and so a suspended continuation remembers whose it was (see RuleOrigin).
async function runAction(deps: Deps, ctx: EvalContext, event: DomainEvent, action: Action, depth: number, origin: RuleOrigin): Promise<ActionOutcome> {
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
      // `relayed` when the rule doing the relaying was not authored by a super admin: the event is real and is
      // logged and dispatched exactly as any other, but it may not trigger a rule holding a privileged action.
      await emitEvent(deps, systemActor(), action.type, {
        subject: event.subject,
        employeeId: event.employeeId,
        payload: template(action.payload ?? event.payload, ctx) as Record<string, unknown>,
        depth: depth + 1,
        relayedUntrusted: !origin.trusted,
      });
      return { kind: action.kind, status: "done" };
    }
    case "wait": {
      const delayMs = (action.delayDays ?? 0) * 86_400_000 + (action.delayHours ?? 0) * 3_600_000;
      const runAfter = new Date(+deps.clock.now() + delayMs);
      await deps.db.insert(schema.jobs).values({
        code: await allocFlatCode(deps, schema.jobs),
        kind: "automation.action",
        // `origin` rides with the continuation: a deferred relay is still its rule's relay when it runs hours
        // later, and a payload without it resumes untrusted rather than guessing (runDeferredActions).
        payload: JSON.stringify({ actions: action.then, event, ctx, depth, correlationId: deps.trace, origin }),
        employeeId: ctx.employeeId ?? null,
        runAfter,
      });
      return { kind: action.kind, status: "done", detail: `deferred to ${runAfter.toISOString()}` };
    }
    case "waitFor": {
      await suspend(deps, ctx, event, action.on, depth, origin);
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
      const html = renderEmail({ heading: subject, preheader: subject, bodyHtml: templateHtml(action.html, ctx) }, await loadEmailBrand(deps));
      await deps.email.send(to, subject, html, atts);
      return { kind: action.kind, status: "done", detail: `emailed ${to}${atts.length ? ` (+${atts.length} attachment)` : ""}` };
    }
    case "emailAudience": {
      const audience = template(action.audience, ctx) as typeof action.audience;
      const ids = await audienceEmployeeIds(deps, audience);
      if (!ids.length) return { kind: action.kind, status: "skipped", detail: "empty audience" };
      const subject = String(template(action.subject, ctx));
      // Wrap the body in the branded shell once (same message for every recipient); load the brand once.
      const html = renderEmail({ heading: subject, preheader: subject, bodyHtml: templateHtml(action.html, ctx) }, await loadEmailBrand(deps));
      // BOUNDED per invocation, remainder to the queue. `{kind:"everyone"}` is the whole active roster, and
      // every send is an outbound fetch off this invocation's subrequest budget - so a rule with an org-wide
      // audience used to run the budget out mid-roster and take the rest of the action list down with it.
      // See services/emailFanOut.ts.
      const sent = await fanOutEmail(deps, { recipients: ids, subject, html, label: `emailAudience ${event.type}` });
      const queued = ids.length - sent;
      return { kind: action.kind, status: "done", detail: `emailed ${sent} recipient(s)${queued > 0 ? `, ${queued} queued` : ""}` };
    }
    default:
      return { kind: (action as Action).kind, status: "error", detail: "unknown action kind" };
  }
}

// Run a list of actions in order (best-effort per action). Stops after a `waitFor` (terminal - it suspends).
async function runActions(deps: Deps, ctx: EvalContext, event: DomainEvent, actions: Action[], depth: number, origin: RuleOrigin): Promise<ActionOutcome[]> {
  const outcomes: ActionOutcome[] = [];
  for (const action of actions) {
    try {
      const outcome = await runAction(deps, ctx, event, action, depth, origin);
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
async function suspend(deps: Deps, ctx: EvalContext, event: DomainEvent, arms: WaitArm[], depth: number, origin: RuleOrigin): Promise<void> {
  const awaitedTypes = arms.filter((a): a is Extract<WaitArm, { event: string }> => "event" in a).map((a) => a.event);
  const [inst] = await deps.db
    .insert(schema.workflowInstances)
    .values({
      code: await allocFlatCode(deps, schema.workflowInstances),
      // WHICH RULE SUSPENDED, which the column has always had room for and nothing ever wrote - so the
      // Workflows UI rendered every instance with no rule against it (http/serialize.ts drops a null ref), and
      // a resumed continuation had no way back to its author's trust (originOf, read in resumeWaiting).
      automationId: origin.automationId,
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
        // The timer belongs to the act that armed it, like every other enqueued job (see cron processOneJob).
        payload: JSON.stringify({ instanceId: inst!.uuid, armIndex: i, correlationId: deps.trace }),
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
async function resumeWaiting(deps: Deps, event: DomainEvent, depth: number, relayedUntrusted: boolean): Promise<number> {
  const waiting = await deps.db.select().from(schema.workflowInstances).where(eq(schema.workflowInstances.status, "waiting"));
  let resumed = 0;
  for (const inst of waiting) {
    if (inst.awaitedTypes && !inst.awaitedTypes.split(",").includes(event.type)) continue; // cheap prefilter
    let arms: WaitArm[];
    try { arms = JSON.parse(inst.armsJson) as WaitArm[]; } catch { continue; }
    const arm = arms.find((a): a is Extract<WaitArm, { event: string }> => "event" in a && armMatches(inst, a, event));
    if (!arm) continue;
    // The same gate dispatchAutomations applies to a rule, applied to a suspended continuation: an arm whose
    // `then` holds a privileged action is super-authored work, and an untrusted relay may not be what wakes
    // it. NOT claimed first - a refused resume must leave the instance waiting for a real event.
    if (relayedUntrusted && hasPrivilegedAction(arm.then)) {
      console.warn(`[automationEngine] workflow ${inst.uuid} not resumed by a relayed ${event.type}: its continuation holds a privileged action`);
      continue;
    }
    if (!(await claim(deps, inst.uuid))) continue; // lost the race (another arm/timer already fired)
    const ctx = ctxFromInstance(inst, event);
    const prevTrace = deps.trace;
    deps.trace = inst.correlationId ?? prevTrace; // the continuation belongs to the original saga's trace
    const origin = await originOf(deps, inst.automationId);
    try { await runActions(deps, ctx, event, arm.then, inst.depth, origin); } finally { deps.trace = prevTrace; }
    resumed++;
  }
  return resumed;
}

/**
 * The one automation_runs row that names no automation: the dispatch budget was exhausted, so events after
 * this one went unprocessed and no rule was even loaded to blame. Written once per originating action (see
 * the call site) and, like recordRun, never allowed to throw - an observability write must not turn a
 * degraded fan-out into a failed request.
 */
async function recordDroppedRun(deps: Deps, eventId: string | null, event: DomainEvent): Promise<void> {
  const now = deps.clock.now();
  try {
    await deps.db.insert(schema.automationRuns).values({
      code: await allocFlatCode(deps, schema.automationRuns),
      automationId: null,
      eventId,
      eventType: event.type,
      subject: event.subject ?? null,
      employeeId: event.employeeId ?? null,
      correlationId: deps.trace ?? null,
      status: "dropped",
      resultJson: JSON.stringify([
        { kind: "dispatch", status: "dropped", detail: `Dispatch budget of ${MAX_TOTAL_DISPATCHES} exhausted; ${event.type} and any later events in this action were not processed.` },
      ]),
      startedAt: now,
      finishedAt: now,
    });
  } catch (e) {
    console.error("[automationEngine] dropped-run insert failed (non-fatal)", e);
  }
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

/**
 * Is ANYTHING listening for `type`? Asked once by a batched emit (eventBus.emitEvents) before it dispatches a
 * run of events one by one.
 *
 * A "no" is the common case for a bulk create - most orgs have no rule on `asset.created` - and it is what
 * turns a hundred dispatches (each of which would re-read the waiting workflows) into a single read. It is only
 * ever a fast path: a "yes" dispatches every event individually, so a rule still fires once per event.
 */
export async function anyAutomationInterest(deps: Deps, type: string): Promise<boolean> {
  if ((await loadEnabled(deps)).some((r) => r.triggerType === type)) return true;
  const waiting = await deps.db
    .select({ awaitedTypes: schema.workflowInstances.awaitedTypes })
    .from(schema.workflowInstances)
    .where(eq(schema.workflowInstances.status, "waiting"));
  return waiting.some((w) => !w.awaitedTypes || w.awaitedTypes.split(",").includes(type));
}

// Entry point called by emitEvent: run every enabled rule that matches, then resume any waiting workflows. Never throws.
//
// `relayedUntrusted` says this event was produced by an `emitEvent` action of a rule no super admin authored
// (see RuleOrigin). Such an event runs the ordinary rules exactly as any other - what it may not do is trigger
// a rule holding a privileged action, because that rule runs as super against a subject the relayer chose.
export async function dispatchAutomations(deps: Deps, event: DomainEvent, eventId: string | null, depth: number, relayedUntrusted = false): Promise<void> {
  if (depth > MAX_EVENT_DEPTH) return;
  const budget = (deps.automationBudget ??= { n: 0, dropped: 0 });
  if (budget.n >= MAX_TOTAL_DISPATCHES) {
    // Counted, not just logged: withDispatchBudget hands the total back to the cron subtask so an exhausted
    // budget lands on the cron_runs row instead of only in Workers Logs.
    budget.dropped++;
    console.warn(`[automationEngine] dispatch budget exhausted (${MAX_TOTAL_DISPATCHES}); dropping ${event.type}`);
    // ...and once per originating action, a `dropped` run row, so it also reaches the Workflows UI, which is
    // where someone actually looks. Only on the FIRST drop: a row per dropped event would be a second runaway
    // of exactly the kind this guard exists to stop, and the row already says the cap was hit. Whoever wired
    // the rules can see that events went unprocessed without reading Workers Logs.
    if (budget.dropped === 1) await recordDroppedRun(deps, eventId, event);
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
    // Refused BEFORE the actions, and recorded as a run rather than only logged: "my rule did not fire" is a
    // question someone asks in the Workflows UI, and a privileged rule silently skipped is the same shape of
    // mystery the dispatch-budget drop row exists to prevent.
    if (relayedUntrusted && hasPrivilegedAction(automation.actions)) {
      await recordRun(deps, row.uuid, eventId, event, start, [{
        kind: "dispatch",
        status: "skipped",
        detail: `${event.type} was relayed by an automation no super admin authored, so it may not trigger a rule with ${privilegedActionKinds(automation.actions).join("/")} action(s).`,
      }]);
      continue;
    }
    // Name the rule for the duration of its actions, so every audit entry they write says which automation
    // did it rather than "System". Parked on Deps like `trace`, so it survives the apiCall re-dispatch (which
    // reuses this Deps) and is restored afterwards - a rule must not be blamed for the next rule's writes.
    const prevActing = deps.actingAs;
    deps.actingAs = { kind: "automation", name: automation.name || row.uuid, ref: `automations/${row.uuid}` };
    let outcomes: ActionOutcome[];
    try {
      outcomes = await runActions(deps, ctx, event, automation.actions, depth, { automationId: row.uuid, trusted: !!row.superAuthored });
    } finally {
      deps.actingAs = prevActing;
    }
    await recordRun(deps, row.uuid, eventId, event, start, outcomes);
  }
  try {
    await resumeWaiting(deps, event, depth, relayedUntrusted);
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
  // The org's calendar day, anchored at UTC midnight. `scheduleDueOn` and the `weekday`/`dayOfMonth` payload
  // below read this Date with getUTC*, so anchoring the ORG-LOCAL day here makes those read the day the org is
  // actually living in - the tick fires at 02:00 UTC, which is the previous evening west of UTC, and a
  // UTC-derived day therefore ran every "every Monday" rule on Sunday for those orgs. `todayStr` is also the
  // per-day claim stamp, so it has to name the same day the rule was judged against.
  const todayStr = await orgToday(deps);
  const today = new Date(dayStartMs(todayStr));
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
      const outcomes = await runActions(deps, ctx, event, automation.actions, 0, { automationId: row.uuid, trusted: !!row.superAuthored });
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
        payload: {
          ...base,
          pendingApprovals: m?.pendingApprovals ?? 0,
          daysSinceLastLeave: m?.daysSinceLastLeave ?? NEVER_TAKEN_LEAVE,
          leaveBalanceDays: m?.leaveBalanceDays ?? 0,
          goalsDueSoon: m?.goalsDueSoon ?? 0,
          goalsOverdue: m?.goalsOverdue ?? 0,
          goalsAtRisk: m?.goalsAtRisk ?? 0,
          goalsStale: m?.goalsStale ?? 0,
          tasksDueSoon: m?.tasksDueSoon ?? 0,
          tasksOverdue: m?.tasksOverdue ?? 0,
          tasksBlocked: m?.tasksBlocked ?? 0,
          selfReviewsDue: m?.selfReviewsDue ?? 0,
          teamReviewsDue: m?.teamReviewsDue ?? 0,
          goalSettingMissing: m?.goalSettingMissing ?? 0,
          teamGoalSettingMissing: m?.teamGoalSettingMissing ?? 0,
        },
        occurredAt: now,
      });
    }
  }
  return fired;
}

// Run a deferred (`wait`) automation payload - called by the cron drain when the job's runAfter has passed.
export async function runDeferredActions(deps: Deps, payload: { actions: Action[]; event: DomainEvent; ctx?: EvalContext; depth: number; correlationId?: string; origin?: RuleOrigin }): Promise<void> {
  const event = { ...payload.event, occurredAt: new Date(payload.event.occurredAt) };
  const ctx = payload.ctx ?? contextOf(event);
  deps.trace = payload.correlationId ?? undefined; // resume under the original workflow's trace (fresh Deps per cron job)
  // The rule's trust is re-read rather than taken from the payload: a `wait` can be days long, and the rule
  // may have been edited by someone with less authority in between. A payload that names no rule (one enqueued
  // before this field existed) resumes untrusted, which costs a relay nothing but the privileged hop.
  const origin = payload.origin?.automationId ? await originOf(deps, payload.origin.automationId) : UNTRUSTED;
  try { await runActions(deps, ctx, event, payload.actions, payload.depth, origin); } finally { deps.trace = undefined; }
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
  const origin = await originOf(deps, inst.automationId);
  try { await runActions(deps, ctx, event, arm.then, inst.depth, origin); } finally { deps.trace = undefined; }
}
