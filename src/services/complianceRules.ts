// Recurring compliance obligations: CRUD over `compliance_rules` + the occurrence generator that fills
// `compliance_events` from active rules. Flat company-wide; NO access control here (middleware gates by path +
// grants, private by default). Generation is idempotent (dedupe by rule + due_date) so it's safe to run on
// every rule edit AND on the daily cron roll-forward.
import { inArray } from "drizzle-orm";
import { allocFlatCodes } from "./codeAlloc";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { invalidArgument } from "../lib/errors";
import { byIdChunks, insertBatches, runBatch } from "../lib/dbBatch";
import { has, type CrudSpec, type SetOf } from "./crud";
import { idFromPath } from "./documentsCommon";
import { dueDatesInRange, periodLabelFor } from "../domain/complianceRecurrence";
import { orgToday, dayStartMs } from "./orgDay";

const FREQUENCIES = ["monthly", "quarterly", "annual"] as const;
type Frequency = (typeof FREQUENCIES)[number];
const HORIZON_MS = 366 * 86_400_000; // generate ~12 months ahead

export type ComplianceRuleInput = {
  title?: string;
  category?: string | null;
  frequency?: Frequency;
  due_day?: number;
  anchor_month?: number | null;
  assignee?: string | null;
  notes?: string | null;
  active?: boolean;
};

type RuleRow = typeof schema.complianceRules.$inferSelect;

// The ORG's today, at the UTC midnight every date-only column in the schema stores a day at - not the day
// UTC happens to be in. `compliance_events.due_date` is such a column and the horizon below is measured from
// here, so reading "today" in UTC is the shape services/orgDay.ts exists to end: the nightly tick fires at
// 02:00 UTC, which is still the previous evening west of UTC, so `from` sat a day ahead of the org's own
// calendar and an obligation due TODAY was outside the window that materialises it. The daily roll-forward
// usually filed that date the night before, which is exactly why this could sit here unnoticed - but a rule
// created or edited today generates from this same function, with no earlier pass to cover for it.
const startOfOrgToday = async (deps: Deps): Promise<number> => dayStartMs(await orgToday(deps));

/**
 * Materialise the missing occurrences of every rule given, within the horizon (dedupe by rule + due date,
 * including soft-deleted ones so a deleted occurrence isn't resurrected). Returns how many were created.
 *
 * BATCHED, NOT LOOPED, and the whole point of the shape. A D1 query is a Worker subrequest against a
 * per-invocation ceiling (lib/dbBatch.ts), and this used to spend two of them PER OCCURRENCE - a counter take
 * and an insert - inside a per-rule loop that also read that rule's existing events. bootstrap.sql seeds eight
 * rules, six of them monthly, so the FIRST nightly tick had ~77 occurrences to write: about 163 sequential
 * round trips, in the one invocation shared with twenty-one other subtasks, several of which (`sendReminders`,
 * `flushDigests`, `creditHolidayCompOff`) run after it and would have found the budget already spent. The same
 * loop ran synchronously on every rule create and edit, where a single monthly rule cost ~25 subrequests on
 * top of the write that triggered it.
 *
 * So: ONE read for every rule's existing occurrences, ONE counter take for every code, ONE insert batch. The
 * cost is a constant handful of subrequests whatever the horizon holds. The batch is atomic (db.batch is an
 * implicit transaction), so a night either files its whole horizon or files none of it and is retried by the
 * next tick - which is the safe direction for an idempotent generator.
 */
async function generateForRules(deps: Deps, rules: RuleRow[]): Promise<number> {
  const active = rules.filter((r) => r.active && !r.deleteTime);
  if (!active.length) return 0;
  const from = await startOfOrgToday(deps);

  // Every rule's existing due dates in one read, chunked for the D1 parameter cap. Soft-deleted rows count:
  // an occurrence somebody deleted must not come back on the next roll-forward.
  const existing = await byIdChunks(active.map((r) => r.uuid), (group) =>
    deps.db
      .select({ ruleId: schema.complianceEvents.ruleId, dueDate: schema.complianceEvents.dueDate })
      .from(schema.complianceEvents)
      .where(inArray(schema.complianceEvents.ruleId, group)));
  const have = new Map<string, Set<number>>();
  for (const e of existing) {
    if (!e.ruleId) continue;
    const seen = have.get(e.ruleId) ?? new Set<number>();
    seen.add(+new Date(e.dueDate));
    have.set(e.ruleId, seen);
  }

  // What is missing, decided in full before anything is written - the codes below are reserved as one run, so
  // the count has to be final first.
  const pending: { rule: RuleRow; ms: number }[] = [];
  for (const rule of active) {
    const seen = have.get(rule.uuid) ?? new Set<number>();
    const due = dueDatesInRange({ frequency: rule.frequency, dueDay: rule.dueDay, anchorMonth: rule.anchorMonth }, from, from + HORIZON_MS);
    for (const ms of due) {
      if (seen.has(ms)) continue;
      seen.add(ms); // a recurrence that names one due date twice must still write it once
      pending.push({ rule, ms });
    }
    have.set(rule.uuid, seen);
  }
  if (!pending.length) return 0;

  const codes = await allocFlatCodes(deps, schema.complianceEvents, pending.length);
  const rows = pending.map(({ rule, ms }, i) => ({
    code: codes[i]!,
    title: rule.title,
    category: rule.category,
    frequency: rule.frequency,
    dueDate: new Date(ms),
    periodLabel: periodLabelFor({ frequency: rule.frequency, dueDay: rule.dueDay, anchorMonth: rule.anchorMonth }, ms),
    status: "pending" as const,
    assigneeId: rule.assigneeId,
    notes: rule.notes,
    ruleId: rule.uuid,
  }));
  await runBatch(deps.db, insertBatches(rows, (group) => deps.db.insert(schema.complianceEvents).values(group)));
  return rows.length;
}

// Create ONE rule's upcoming occurrences within the horizon that don't already exist. Returns how many.
export async function generateForRule(deps: Deps, rule: RuleRow): Promise<number> {
  return generateForRules(deps, [rule]);
}

// Roll the horizon forward for every active rule (the daily cron + post-edit top-up). Returns total created.
export async function generateComplianceOccurrences(deps: Deps): Promise<number> {
  return generateForRules(deps, await deps.db.select().from(schema.complianceRules));
}

function validate(input: ComplianceRuleInput) {
  if (input.frequency && !FREQUENCIES.includes(input.frequency)) throw invalidArgument("frequency must be monthly|quarterly|annual");
  if (input.due_day !== undefined && (typeof input.due_day !== "number" || input.due_day < 1 || input.due_day > 31)) throw invalidArgument("due_day must be 1-31");
  if (input.anchor_month != null && (typeof input.anchor_month !== "number" || input.anchor_month < 1 || input.anchor_month > 12)) throw invalidArgument("anchor_month must be 1-12");
}

export const complianceRuleSpec: CrudSpec<ComplianceRuleInput, typeof schema.complianceRules> = {
  table: schema.complianceRules,
  collection: "compliance-rules",
  auditName: "compliance-rule",
  notFound: "compliance rule not found",
  insert: (input) => {
    if (!input.title) throw invalidArgument("title is required");
    if (!input.due_day) throw invalidArgument("due_day is required");
    validate(input);
    return {
      title: input.title,
      category: input.category?.trim() || null,
      frequency: input.frequency ?? "monthly",
      dueDay: input.due_day,
      anchorMonth: input.anchor_month ?? null,
      assigneeId: idFromPath(input.assignee) ?? null,
      notes: input.notes?.trim() || null,
      active: input.active ?? true,
    };
  },
  patch: (patch) => {
    validate(patch);
    const set: SetOf<typeof schema.complianceRules> = {};
    if (has(patch, "title")) { if (!patch.title) throw invalidArgument("title cannot be empty"); set.title = patch.title; }
    if (has(patch, "category")) set.category = patch.category?.trim() || null;
    if (has(patch, "frequency")) set.frequency = patch.frequency;
    if (has(patch, "due_day") && patch.due_day) set.dueDay = patch.due_day;
    if (has(patch, "anchor_month")) set.anchorMonth = patch.anchor_month ?? null;
    if (has(patch, "assignee")) set.assigneeId = idFromPath(patch.assignee) ?? null;
    if (has(patch, "notes")) set.notes = patch.notes?.trim() || null;
    if (has(patch, "active")) set.active = !!patch.active;
    return set;
  },
  // A new rule immediately materialises its horizon of occurrences.
  afterCreate: async (deps, _actor, row) => {
    await generateForRule(deps, row);
  },
  // Top up occurrences for the (possibly changed) schedule. Existing future occurrences are left as-is; only
  // missing ones are added - editing a rule never silently rewrites or deletes already-generated events.
  afterUpdate: async (deps, _actor, row) => {
    await generateForRule(deps, row);
  },
};

