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
import { keysetPage } from "./keysetPage";
import { etagOf } from "../http/serialize";
import { assertNotLocked } from "./lifecycle";
import { validateAutomation, evalCondition, isScheduled, privilegedActionKinds, type Automation, type Condition, type Action, type Schedule } from "../domain/automations";
import { invalidateAutomationCache } from "./automationEngine";
import { sensitiveFieldsInCondition, type DomainEvent } from "../domain/events";
import { atVersion, checkEtag, updateAtVersion, versionConflict } from "./versionGuard";

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
// The kind list and the recursion into wait/waitFor continuations live in domain/automations.ts, because the
// dispatch-side gate asks the same question and two copies would be two answers.
//
// "AUTHOR" MEANS EVERY WRITE THAT DECIDES WHETHER THE RULE RUNS, not only the one that types the actions. The
// gate used to sit on create/update alone, so an hr_admin could not write an `apiCall` rule - and could still
// switch one ON. That is the same act with fewer steps: `bootstrap.sql` ships privileged rules DISABLED on
// purpose ("Auto-approve small salary advances", whose own description says it moves money with no human
// decision), and arming one is exactly the authority the create gate withholds. Delete is here for the
// converse reason: silently removing a control a super admin installed is not a lesser act than installing one.
function assertMayAuthorActions(actor: AppUser, actions: Action[] | undefined): void {
  if (isSuperGrant(actor.grant)) return;
  const privileged = privilegedActionKinds(actions);
  if (privileged.length) throw forbidden(`only a super admin may author automations with ${privileged.join("/")} action(s)`);
}

// A CONDITION IS A READ. A rule no super admin authored is templated over a payload with its money masked
// (services/automationEngine.ts), but its condition is evaluated against the real event - so "notify me when
// netPay > 150000" would read each payslip one bit at a time. Such a rule may not test those fields at all.
function assertMayConditionOn(actor: AppUser, a: Automation): void {
  if (isSuperGrant(actor.grant)) return;
  const fields = sensitiveFieldsInCondition(a.triggerType, a.condition);
  if (fields.length) throw forbidden(`only a super admin may write a condition on ${fields.join(", ")}`);
}

/** The same gate, asked about a rule as it is STORED - for the verbs that act on an existing rule rather than
 *  on a submitted body (enable / disable / delete). A malformed `actions_json` fails closed. */
function assertMayActOnStored(actor: AppUser, row: { actionsJson: string }): void {
  if (isSuperGrant(actor.grant)) return;
  let actions: Action[];
  try {
    actions = JSON.parse(row.actionsJson) as Action[];
  } catch {
    throw forbidden("this automation's actions cannot be read; only a super admin may act on it");
  }
  assertMayAuthorActions(actor, actions);
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
  // Paged in SQL (services/keysetPage.ts) rather than by reading every rule the scope matches into the
  // isolate and slicing one page out of it.
  return keysetPage<typeof schema.automations.$inferSelect>(deps, schema.automations, "automations", applyScope(scope, schema.automations.code, undefined), { dir: "desc", max: maxPageSize, pageToken });
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
  assertMayConditionOn(actor, a);
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
      // What the engine consults before letting this rule's `emitEvent` reach a privileged rule (schema.ts).
      superAuthored: isSuperGrant(actor.grant),
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
  checkEtag(row, ifMatch);
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
  assertMayConditionOn(actor, merged);
  // Re-stamped on EVERY update, not only when the actions move: trust belongs to whoever last decided what
  // this rule does. A rule a super admin wrote and an hr_admin then re-pointed at a different trigger is an
  // hr_admin's rule, and its relayed events must be treated as such.
  const set: SetOf<typeof schema.automations> = { updatedAt: new Date(), superAuthored: isSuperGrant(actor.grant) };
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
  const updated = await updateAtVersion(deps, schema.automations, "automation", row, set);
  await audit(deps, actor, "automation.update", "automations", id, diffMeta(row, updated, set, "automations"), updated);
  invalidateAutomationCache();
  return updated;
}

export async function deleteAutomation(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.automations).where(eq(schema.automations.uuid, id)).limit(1))[0];
  if (!row) throw notFound("automation not found");
  assertMayActOnStored(actor, row);
  assertNotLocked(row);
  checkEtag(row, ifMatch);
  // Bottom-up, because both children are foreign keys SQLite refuses the delete over - which is what made
  // removing any rule that had ever fired a 500. Neither outlives the rule: a suspended workflow instance is
  // runtime state that can never resume without the rule to resume INTO, and a run row exists only to explain
  // one of that rule's firings. What the rule WAS survives in the audit entry written below.
  await deps.db.delete(schema.workflowInstances).where(eq(schema.workflowInstances.automationId, id));
  await deps.db.delete(schema.automationRuns).where(eq(schema.automationRuns.automationId, id));
  // GUARDED AT VERSION like every other delete (services/softDelete.ts): the children are already gone by
  // here, so a rule somebody edited between our read and this write must not be removed on the strength of the
  // version we read - it answers 409 and the operator re-reads.
  const gone = await deps.db.delete(schema.automations).where(atVersion(schema.automations, row)).returning({ uuid: schema.automations.uuid });
  if (!gone.length) await versionConflict(deps, schema.automations, "automation", id);
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
  // Arming (or silencing) a rule whose actions run as super is the authoring act - see assertMayActOnStored.
  assertMayActOnStored(actor, row);
  const updated = await updateAtVersion(deps, schema.automations, "automation", row, { disabled: !enabled, updatedAt: new Date() });
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
