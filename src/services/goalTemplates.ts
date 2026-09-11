// Goal templates: the blueprints HR keeps so the same twelve goals are not retyped by forty people every
// quarter, badly. Reference data (flat-coded, curated in Settings) plus one verb that turns a blueprint into
// real goals - which is the whole point of it existing.
import { and, eq, inArray, isNull } from "drizzle-orm";
import * as schema from "../db/schema";
import { has, type CrudSpec, type SetOf } from "./crud";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, auditMany, createdMeta } from "../lib/audit";
import { byIdChunks, insertBatches, runBatch } from "../lib/dbBatch";
import { genId } from "../lib/idCodec";
import { invalidArgument, notFound } from "../lib/errors";
import { allocOwnedCodesFor } from "./codeAlloc";
import { goalApprovalOn, measuredProgress } from "./goals";
import { notifyMany } from "./notifications";
import { orgDayFromToday } from "./orgDay";

export type GoalTemplateInput = {
  title?: string;
  description?: string | null;
  weight?: number;
  due_in_days?: number | null;
  unit?: string | null;
  baseline_value?: number | null;
  target_value?: number | null;
  department?: string | null;
  group_name?: string | null;
  disabled?: boolean;
};

const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const clampPct = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export const goalTemplateSpec: CrudSpec<GoalTemplateInput, typeof schema.goalTemplates> = {
  table: schema.goalTemplates,
  collection: "goal-templates",
  auditName: "goal_template",
  notFound: "goal template not found",
  insert: (input) => {
    if (!input.title?.trim()) throw invalidArgument("title is required");
    return {
      title: input.title.trim(),
      description: input.description?.trim() || null,
      weight: input.weight != null ? clampPct(input.weight) : 0,
      dueInDays: input.due_in_days ?? null,
      unit: input.unit?.trim() || null,
      baselineValue: input.baseline_value ?? null,
      targetValue: input.target_value ?? null,
      departmentId: idFromPath(input.department) ?? null,
      groupName: input.group_name?.trim() || null,
      disabled: input.disabled ?? false,
    };
  },
  patch: (patch) => {
    const set: SetOf<typeof schema.goalTemplates> = {};
    if (has(patch, "title")) {
      if (!patch.title?.trim()) throw invalidArgument("title cannot be blank");
      set.title = patch.title.trim();
    }
    if (has(patch, "description")) set.description = patch.description?.trim() || null;
    if (has(patch, "weight")) set.weight = clampPct(patch.weight ?? 0);
    if (has(patch, "due_in_days")) set.dueInDays = patch.due_in_days ?? null;
    if (has(patch, "unit")) set.unit = patch.unit?.trim() || null;
    if (has(patch, "baseline_value")) set.baselineValue = patch.baseline_value ?? null;
    if (has(patch, "target_value")) set.targetValue = patch.target_value ?? null;
    if (has(patch, "department")) set.departmentId = idFromPath(patch.department) ?? null;
    if (has(patch, "group_name")) set.groupName = patch.group_name?.trim() || null;
    if (has(patch, "disabled")) set.disabled = patch.disabled;
    return set;
  },
  sort: (a, b) => String(a.groupName ?? "").localeCompare(String(b.groupName ?? "")) || String(a.title).localeCompare(String(b.title)),
};

/**
 * The `apply` verb: stamp this blueprint out as a real goal for each named employee.
 *
 * `dueInDays` becomes a real date HERE, against the day of application: the template holds the interval
 * ("30 days in"), the goal holds the date, and nobody re-dates the catalogue every quarter.
 *
 * Skips an employee who already has an open goal from this template in the same cycle. Applying a set twice
 * is the most likely mistake in the whole flow - a mis-click on a team of thirty - and the second press
 * should be a no-op rather than forty duplicate goals nobody can tell apart.
 *
 * FANNED OUT, NOT LOOPED. This used to call `createGoal` once per employee, which is the honest way to say
 * "an applied goal is an ordinary goal" and cost 16 D1 round trips a head - 15 inside `createGoal` (the
 * settings read, the owned-code allocation, the insert, the audit row, and `notify`'s own five) plus one read
 * to de-duplicate. Every round trip is a Worker SUBREQUEST, the ceiling is 1,000 per invocation, and the
 * schema lets this verb name 200 employees: about 3,200. So the press failed partway through on any real
 * team, having already created goals for the first sixty, and the only reason it looked fine is that nobody
 * had applied a template to more than a handful.
 *
 * Each of those costs is now paid ONCE for the whole run, using the same primitives the asset bulk-add uses
 * (see services/assets.ts createAssetsBatch): one settings read, one de-duplicating read, one owned-code
 * fan-out through the SAME counters `allocOwnedCode` takes from, one batched insert, one `auditMany`, one
 * `notifyMany`. What a goal ROW looks like still has to match `createGoal`, so test/goalTemplates.test.ts
 * compares the two field by field and caps the statement count - that drift is the real cost of not going
 * through it.
 */
export async function applyGoalTemplate(
  deps: Deps,
  actor: AppUser,
  id: string,
  employeeRefs: string[],
  cycleRef?: string | null,
) {
  const tpl = (await deps.db.select().from(schema.goalTemplates).where(eq(schema.goalTemplates.uuid, id)).limit(1))[0];
  if (!tpl || tpl.deleteTime) throw notFound("goal template not found");
  const ids = [...new Set(employeeRefs.map(idFromPath).filter(Boolean) as string[])];
  if (!ids.length) throw invalidArgument("select at least one employee");

  const cycleId = idFromPath(cycleRef) ?? null;
  // Validated once for the run, not once per employee: it is the same cycle for all of them. Same rule as
  // goals.ts resolveCycleId - a CLOSED cycle is a legal target, a deleted one is not.
  if (cycleId) {
    const cyc = (await deps.db
      .select({ uuid: schema.reviewCycles.uuid, deleteTime: schema.reviewCycles.deleteTime })
      .from(schema.reviewCycles)
      .where(eq(schema.reviewCycles.uuid, cycleId))
      .limit(1))[0];
    if (!cyc || cyc.deleteTime) throw invalidArgument("review cycle not found");
  }

  // "N days from today" counted from the ORG's calendar day, so a template applied late in the local evening
  // does not quietly land its due date a day out for anyone west of UTC.
  const due = tpl.dueInDays != null ? await orgDayFromToday(deps, tpl.dueInDays) : undefined;

  // ONE de-duplicating read for the whole selection, chunked for the parameter cap. The per-employee version
  // of this was a read a head and asked the same question.
  const holders = new Set(
    (await byIdChunks(ids, (group) =>
      deps.db
        .select({ employeeId: schema.goals.employeeId, cycleId: schema.goals.cycleId })
        .from(schema.goals)
        .where(and(inArray(schema.goals.employeeId, group), eq(schema.goals.title, tpl.title), isNull(schema.goals.deleteTime))),
    ))
      .filter((g) => (g.cycleId ?? null) === cycleId)
      .map((g) => g.employeeId),
  );
  const targets = ids.filter((e) => !holders.has(e));
  const skipped = ids.length - targets.length;
  if (!targets.length) {
    await audit(deps, actor, "goal-template.apply", "goal-templates", id, {
      fields: ids.slice(0, 12).map((e) => `employees/${e}`),
      note: `created 0 goals, skipped ${skipped} already holding it`,
    }, tpl);
    return { ...tpl, _applied: 0, _skipped: skipped };
  }

  // Where each goal starts on the agreement ladder. The org flag is read once; the per-employee half of the
  // rule (a goal somebody writes for THEMSELVES needs submitting, one written for them does not) still decides
  // per row, because an employee may apply a template to their own list.
  const approvalOn = await goalApprovalOn(deps);
  const now = deps.clock.now();
  // A measured template starts at its baseline, not at nothing: "churn from 8%" begins at 8.
  const currentValue = tpl.targetValue != null ? tpl.baselineValue ?? 0 : null;
  const measured = measuredProgress({ baselineValue: tpl.baselineValue, targetValue: tpl.targetValue, currentValue });
  // The SAME per-(table, owner) counters `allocOwnedCode` takes from, for every owner at once - see
  // codeAlloc.ts allocOwnedCodesFor for why composing them from a sibling read instead loses rows.
  const codes = await allocOwnedCodesFor(deps, schema.goals, schema.goals.employeeId, targets);
  const rows = targets.map((employeeId) => {
    const stage: NonNullable<typeof schema.goals.$inferSelect["stage"]> = approvalOn && employeeId === actor.employeeId ? "DRAFT" : "AGREED";
    return {
      uuid: genId(), // minted here so the audit + notification rows can name each goal without reading the inserts back
      code: codes.get(employeeId)!,
      employeeId,
      cycleId,
      title: tpl.title,
      description: tpl.description,
      weight: tpl.weight != null ? clampPct(tpl.weight) : 0,
      progress: measured ?? 0,
      status: "not_started" as const,
      kind: "objective" as const,
      stage,
      ...(stage === "AGREED" ? { agreedAt: now, agreedById: actor.employeeId ?? null } : {}),
      dueDate: due ? new Date(Date.parse(`${due}T00:00:00Z`)) : null,
      unit: tpl.unit,
      baselineValue: tpl.baselineValue,
      targetValue: tpl.targetValue,
      currentValue,
    };
  });
  // One atomic batch: either the whole set landed or none of it did. A half-applied template is the state this
  // verb's own idempotence check cannot describe - the second press would skip the ones that made it and the
  // reader has no way to see that the first press was partial.
  await runBatch(deps.db, insertBatches(rows, (group) => deps.db.insert(schema.goals).values(group)));
  // Each goal keeps its OWN creation entry: its activity feed is per record, exactly as a hand-written goal's is.
  await auditMany(deps, actor, rows.map((row) => ({
    action: "goal.create",
    entity: "goals",
    entityId: row.uuid,
    meta: createdMeta(row, "goals"),
    snapshot: row,
  })));
  // A goal assigned TO someone else notifies the owner. Per-recipient subject, because thirty people are being
  // told about thirty different goals - a shared one would point them all at the first.
  const goalByEmployee = new Map(rows.map((r) => [r.employeeId, r.uuid]));
  await notifyMany(deps, targets.filter((e) => e !== actor.employeeId), {
    type: "goal.assigned",
    title: "New goal assigned",
    body: tpl.title,
    link: "goals",
    actorId: actor.employeeId,
    subjectFor: (rid) => `goals/${goalByEmployee.get(rid)}`,
  });
  await audit(deps, actor, "goal-template.apply", "goal-templates", id, {
    fields: ids.slice(0, 12).map((e) => `employees/${e}`),
    note: `created ${rows.length} goal${rows.length === 1 ? "" : "s"}${skipped ? `, skipped ${skipped} already holding it` : ""}`,
  }, tpl);
  // The template row is the resource the verb answers with (AEP), so what the press actually DID rides on it:
  // "12 goals created, 3 already had it" is the only part of this the page can use.
  return { ...tpl, _applied: rows.length, _skipped: skipped };
}
