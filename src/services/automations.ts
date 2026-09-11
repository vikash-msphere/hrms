// Automation rules CRUD (the data-defined "when/if/then"). Authoring is the privileged act - the route gates
// it to hr_admin/super - because actions run with system authority. Every write validates the rule via the
// pure domain validator and invalidates the engine's rule cache so a change takes effect immediately.
import { eq } from "drizzle-orm";
import { allocFlatCode } from "./codeAlloc";
import * as schema from "../db/schema";
import type { SetOf } from "./crud";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, createdMeta, removedMeta, diffMeta } from "../lib/audit";
import { invalidArgument, notFound, aborted, forbidden } from "../lib/errors";
import { isSuperGrant } from "../domain/grants";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import { paginate } from "../http/pagination";
import { etagOf } from "../http/serialize";
import { assertNotLocked } from "./lifecycle";
import { validateAutomation, evalCondition, isScheduled, type Automation, type Condition, type Action, type Schedule } from "../domain/automations";
import { invalidateAutomationCache } from "./automationEngine";
import type { DomainEvent } from "../domain/events";

export type AutomationInput = {
  name?: string;
  description?: string | null;
  trigger_type?: string;
  condition?: Condition | null;
  actions?: Action[];
  enabled?: boolean;
  schedule?: Schedule | null;
};

// Build the pure Automation shape (for validation) from a create/update body.
function toAutomation(body: AutomationInput, base?: { triggerType: string; actions: Action[]; schedule?: Schedule | null }): Automation {
  return {
    name: body.name ?? "",
    triggerType: body.trigger_type ?? base?.triggerType ?? "",
    condition: body.condition ?? null,
    actions: body.actions ?? base?.actions ?? [],
    schedule: body.schedule !== undefined ? body.schedule : (base?.schedule ?? null),
  };
}

function assertValid(a: Automation): void {
  const errs = validateAutomation(a);
  if (errs.length) throw invalidArgument(`invalid automation: ${errs.join("; ")}`);
}

// Actions that run with SYSTEM (super) authority or reach the network: authoring one is equivalent to holding
// super, so only a super_admin may author them. hr_admin keeps the safe action kinds (notify/emitEvent/wait).
// Recurses into wait/waitFor continuations so a privileged action can't hide inside a `then`/arm.
const PRIVILEGED_ACTION_KINDS = new Set(["apiCall", "webhook", "email", "emailAudience"]);
function collectActionKinds(actions: Action[] | undefined, acc: Set<string> = new Set()): Set<string> {
  for (const a of actions ?? []) {
    if (a && typeof (a as Action).kind === "string") acc.add((a as Action).kind);
    const any = a as { then?: Action[]; on?: { then?: Action[] }[] };
    if (Array.isArray(any?.then)) collectActionKinds(any.then, acc);
    if (Array.isArray(any?.on)) for (const arm of any.on) if (Array.isArray(arm?.then)) collectActionKinds(arm.then, acc);
  }
  return acc;
}
function assertMayAuthorActions(actor: AppUser, actions: Action[] | undefined): void {
  if (isSuperGrant(actor.grant)) return;
  const privileged = [...collectActionKinds(actions)].filter((k) => PRIVILEGED_ACTION_KINDS.has(k));
  if (privileged.length) throw forbidden(`only a super admin may author automations with ${privileged.join("/")} action(s)`);
}

// The caller's list scope is BOUND, like every other list in the app, rather than assumed away.
//
// Authoring automations is admin-only today, and that was the argument for reading the table unfiltered - which
// makes the guarantee a property of the current grant data rather than of this code. The middleware decides a
// scope for every collection request; a list that ignores it answers the whole table to whoever the decision let
// through, so the day someone grants `automations` read at a department or own breadth (a team lead who should
// see their own rules), that grant silently means "every rule in the org". `applyScope` decides nothing - it
// binds what the middleware already settled - so for the admin case it is the same query it always was.
export async function listAutomations(deps: Deps, _actor: AppUser, scope: ListScope | undefined, maxPageSize: number, pageToken?: string) {
  const all = await deps.db.select().from(schema.automations).where(applyScope(scope, schema.automations.code, undefined));
  return paginate(all, maxPageSize, pageToken, (r) => +new Date(r.createdAt), (r) => r.uuid, "desc", { codec: deps.idCodec, collection: "automations" });
}

// Not exported: the factory's generic get answers the item read (services/crud.ts); this is the internal
// fetch :test shares.
async function getAutomation(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.automations).where(eq(schema.automations.uuid, id)).limit(1))[0];
  if (!row) throw notFound("automation not found");
  return row;
}

export async function createAutomation(deps: Deps, actor: AppUser, input: AutomationInput, id?: string) {
  const a = toAutomation(input);
  assertValid(a);
  assertMayAuthorActions(actor, a.actions);
  const row = (await deps.db
    .insert(schema.automations)
    .values({
      code: await allocFlatCode(deps, schema.automations),
      ...(id ? { uuid: id } : {}),
      name: a.name,
      description: input.description?.trim() || null,
      triggerType: a.triggerType,
      conditionJson: a.condition ? JSON.stringify(a.condition) : null,
      actionsJson: JSON.stringify(a.actions),
      scheduleJson: isScheduled(a) && a.schedule ? JSON.stringify(a.schedule) : null,
      disabled: input.enabled === false,
      createdBy: actor.uuid === "system" ? null : actor.uuid,
    })
    .returning())[0]!;
  await audit(deps, actor, "automation.create", "automations", row.uuid, createdMeta(row, "automations"), row);
  invalidateAutomationCache();
  return row;
}

export async function updateAutomation(deps: Deps, actor: AppUser, id: string, patch: AutomationInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.automations).where(eq(schema.automations.uuid, id)).limit(1))[0];
  if (!row) throw notFound("automation not found");
  assertNotLocked(row);
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const has = (k: keyof AutomationInput) => Object.prototype.hasOwnProperty.call(patch, k);
  // Validate the merged result so a partial patch can't produce an invalid rule.
  const merged = toAutomation(
    {
      name: has("name") ? patch.name : row.name,
      trigger_type: has("trigger_type") ? patch.trigger_type : row.triggerType,
      condition: has("condition") ? patch.condition : (row.conditionJson ? JSON.parse(row.conditionJson) : null),
      actions: has("actions") ? patch.actions : (JSON.parse(row.actionsJson) as Action[]),
      schedule: has("schedule") ? patch.schedule : (row.scheduleJson ? (JSON.parse(row.scheduleJson) as Schedule) : null),
    },
    { triggerType: row.triggerType, actions: JSON.parse(row.actionsJson) as Action[], schedule: row.scheduleJson ? (JSON.parse(row.scheduleJson) as Schedule) : null },
  );
  assertValid(merged);
  assertMayAuthorActions(actor, merged.actions);
  const set: SetOf<typeof schema.automations> = { updatedAt: new Date() };
  if (has("name")) set.name = merged.name;
  if (has("description")) set.description = patch.description?.trim() || null;
  if (has("trigger_type")) set.triggerType = merged.triggerType;
  if (has("condition")) set.conditionJson = merged.condition ? JSON.stringify(merged.condition) : null;
  if (has("actions")) set.actionsJson = JSON.stringify(merged.actions);
  if (has("enabled")) set.disabled = !patch.enabled;
  // Trigger or schedule changed: keep scheduleJson consistent with the merged rule (clear it if the rule is
  // no longer scheduled). Also clear the idempotency stamp so a re-timed rule fires on its next due date.
  if (has("schedule") || has("trigger_type")) {
    set.scheduleJson = isScheduled(merged) && merged.schedule ? JSON.stringify(merged.schedule) : null;
    set.lastScheduledOn = null;
  }
  const updated = (await deps.db.update(schema.automations).set(set).where(eq(schema.automations.uuid, id)).returning())[0]!;
  await audit(deps, actor, "automation.update", "automations", id, diffMeta(row, updated, set, "automations"), updated);
  invalidateAutomationCache();
  return updated;
}

export async function deleteAutomation(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.automations).where(eq(schema.automations.uuid, id)).limit(1))[0];
  if (!row) throw notFound("automation not found");
  assertNotLocked(row);
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  // Bottom-up, because both children are foreign keys SQLite refuses the delete over - which is what made
  // removing any rule that had ever fired a 500. Neither outlives the rule: a suspended workflow instance is
  // runtime state that can never resume without the rule to resume INTO, and a run row exists only to explain
  // one of that rule's firings. What the rule WAS survives in the audit entry written below.
  await deps.db.delete(schema.workflowInstances).where(eq(schema.workflowInstances.automationId, id));
  await deps.db.delete(schema.automationRuns).where(eq(schema.automationRuns.automationId, id));
  await deps.db.delete(schema.automations).where(eq(schema.automations.uuid, id));
  // A hard delete: the rule and its trigger/action wiring survive only as this entry.
  await audit(deps, actor, "automation.delete", "automations", id, removedMeta(row, "automations"), row);
  invalidateAutomationCache();
}

// The :enable / :disable verbs, kept as the collection's OWN (the factory answers a collection's verb before the
// shared lifecycle lane). They write the same `disabled` column the shared verb would and record the same audit
// stem - what they add is `invalidateAutomationCache()`, without which a rule the operator just switched off
// keeps firing until the engine's cache expires.
export async function setAutomationEnabled(deps: Deps, actor: AppUser, id: string, enabled: boolean) {
  const row = (await deps.db.select().from(schema.automations).where(eq(schema.automations.uuid, id)).limit(1))[0];
  if (!row) throw notFound("automation not found");
  const updated = (await deps.db.update(schema.automations).set({ disabled: !enabled, updatedAt: new Date() }).where(eq(schema.automations.uuid, id)).returning())[0]!;
  // A rule silently switched off is the hardest automation bug to find, so record the flip explicitly.
  await audit(deps, actor, `automation.${enabled ? "enable" : "disable"}`, "automations", id, { diff: { disabled: { from: row.disabled, to: !enabled } } }, updated);
  invalidateAutomationCache();
  return updated;
}

// Dry-run: evaluate the rule's condition against a sample event and report which actions WOULD run, WITHOUT
// executing any side effect. Powers the builder UI's "Test" button.
export async function testAutomation(deps: Deps, actor: AppUser, id: string, sample: { employeeId?: string | null; payload?: Record<string, unknown> }) {
  const row = await getAutomation(deps, actor, id);
  const event: DomainEvent = {
    type: row.triggerType,
    subject: null,
    actorId: actor.uuid === "system" ? null : actor.uuid,
    employeeId: sample.employeeId ?? null,
    payload: sample.payload ?? {},
    occurredAt: deps.clock.now(),
  };
  const condition: Condition | null = row.conditionJson ? JSON.parse(row.conditionJson) : null;
  const matched = evalCondition(condition, { type: event.type, subject: event.subject, actorId: event.actorId, employeeId: event.employeeId, payload: event.payload });
  const actions = JSON.parse(row.actionsJson) as Action[];
  return { matched, would_run: matched ? actions.map((a) => ({ kind: a.kind })) : [] };
}
