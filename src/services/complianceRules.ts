// Recurring compliance obligations: CRUD over `compliance_rules` + the occurrence generator that fills
// `compliance_events` from active rules. Flat company-wide; NO access control here (middleware gates by path +
// grants, private by default). Generation is idempotent (dedupe by rule + due_date) so it's safe to run on
// every rule edit AND on the daily cron roll-forward.
import { eq } from "drizzle-orm";
import { allocFlatCode } from "./codeAlloc";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { invalidArgument } from "../lib/errors";
import { crudService, has, type CrudSpec } from "./crud";
import { idFromPath } from "./documentsCommon";
import { dueDatesInRange, periodLabelFor } from "../domain/complianceRecurrence";

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

const startOfTodayUTC = (deps: Deps): number => {
  const d = new Date(+deps.clock.now());
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

// Create the rule's upcoming occurrences within the horizon that don't already exist (dedupe by due date,
// including soft-deleted ones so a deleted occurrence isn't resurrected). Returns how many were created.
export async function generateForRule(deps: Deps, rule: RuleRow): Promise<number> {
  if (!rule.active || rule.deleteTime) return 0;
  const from = startOfTodayUTC(deps);
  const due = dueDatesInRange({ frequency: rule.frequency, dueDay: rule.dueDay, anchorMonth: rule.anchorMonth }, from, from + HORIZON_MS);
  if (due.length === 0) return 0;
  const existing = await deps.db.select({ dueDate: schema.complianceEvents.dueDate }).from(schema.complianceEvents).where(eq(schema.complianceEvents.ruleId, rule.uuid));
  const have = new Set(existing.map((e) => +new Date(e.dueDate)));
  let created = 0;
  for (const ms of due) {
    if (have.has(ms)) continue;
    await deps.db.insert(schema.complianceEvents).values({
      code: await allocFlatCode(deps, schema.complianceEvents),
      title: rule.title,
      category: rule.category,
      frequency: rule.frequency,
      dueDate: new Date(ms),
      periodLabel: periodLabelFor({ frequency: rule.frequency, dueDay: rule.dueDay, anchorMonth: rule.anchorMonth }, ms),
      status: "pending",
      assigneeId: rule.assigneeId,
      notes: rule.notes,
      ruleId: rule.uuid,
    });
    have.add(ms);
    created++;
  }
  return created;
}

// Roll the horizon forward for every active rule (the daily cron + post-edit top-up). Returns total created.
export async function generateComplianceOccurrences(deps: Deps): Promise<number> {
  const rules = await deps.db.select().from(schema.complianceRules);
  let total = 0;
  for (const r of rules) if (r.active && !r.deleteTime) total += await generateForRule(deps, r);
  return total;
}

function validate(input: ComplianceRuleInput) {
  if (input.frequency && !FREQUENCIES.includes(input.frequency)) throw invalidArgument("frequency must be monthly|quarterly|annual");
  if (input.due_day !== undefined && (typeof input.due_day !== "number" || input.due_day < 1 || input.due_day > 31)) throw invalidArgument("due_day must be 1-31");
  if (input.anchor_month != null && (typeof input.anchor_month !== "number" || input.anchor_month < 1 || input.anchor_month > 12)) throw invalidArgument("anchor_month must be 1-12");
}

export const complianceRuleSpec: CrudSpec<ComplianceRuleInput> = {
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
      category: input.category ?? null,
      frequency: input.frequency ?? "monthly",
      dueDay: input.due_day,
      anchorMonth: input.anchor_month ?? null,
      assigneeId: idFromPath(input.assignee) ?? null,
      notes: input.notes ?? null,
      active: input.active ?? true,
    };
  },
  patch: (patch) => {
    validate(patch);
    const set: Record<string, unknown> = {};
    if (has(patch, "title")) { if (!patch.title) throw invalidArgument("title cannot be empty"); set.title = patch.title; }
    if (has(patch, "category")) set.category = patch.category ?? null;
    if (has(patch, "frequency")) set.frequency = patch.frequency;
    if (has(patch, "due_day") && patch.due_day) set.dueDay = patch.due_day;
    if (has(patch, "anchor_month")) set.anchorMonth = patch.anchor_month ?? null;
    if (has(patch, "assignee")) set.assigneeId = idFromPath(patch.assignee) ?? null;
    if (has(patch, "notes")) set.notes = patch.notes ?? null;
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

export const {
  list: listComplianceRules,
  get: getComplianceRule,
  create: createComplianceRule,
  update: updateComplianceRule,
  remove: deleteComplianceRule,
  restore: restoreComplianceRule,
  purge: purgeComplianceRule,
} = crudService(complianceRuleSpec);
