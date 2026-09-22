// A sentence over the budget page, about how this period's spending compares with the last one.
//
// The SAME SHAPE as services/analyticsNarrate.ts, and deliberately so: arithmetic finds the movements, the
// model is handed only those movements, `groundedIn` throws away any answer containing a figure nobody
// computed, and `plainSummary` is what a reader gets when there is no model. The model cannot invent a
// movement because it never sees the data, and cannot invent a number because the check rejects one.
//
// WHY THIS ONE AND NOT THE PAYROLL EQUIVALENT (item 6): budgets are not on `NEVER_TO_MODEL`. There is no
// consented path to argue for, no policy line to edit, and nothing here is about a person - the prompt is
// four org-level totals and their labels. `payroll-runs` is denied, so the same feature there needs an
// argument this one does not, which is the whole reason the plan says build this first and see whether
// anybody reads the sentence.
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { resourceExhausted } from "../lib/errors";
import { UNTRUSTED_PREAMBLE } from "../domain/aiPolicy";
import { findMovements, groundedIn, plainSummary, type Finding } from "../domain/narrate";
import type { MetricDef } from "../domain/peopleAnalytics";
import { periodKeyFor, periodBounds, type PeriodType } from "../domain/expenses";
import { aiFeatureOn, aiGenerate } from "./ai";
import { computeBudgetSpendMany, budgetProjection, budgetPhase } from "./expenseBudgets";
import { visibleByDelete } from "./softDelete";
import * as schema from "../db/schema";

// v1. Bumped whenever the system prompt changes, because `aiGenerate` caches on (feature, promptVersion,
// inputs) - left alone, an edit to the prompt would keep serving answers the OLD one produced.
const PROMPT_VERSION = "v1";

/**
 * The four numbers a budget page is actually about.
 *
 * Deliberately NOT per-budget: a narration listing thirty caps is a table read aloud. These are the totals
 * somebody would quote in a sentence, and they are the only figures the model is allowed to use.
 */
const MEASURES: MetricDef[] = [
  { key: "budgeted", label: "Total budgeted", short: "Budgeted", group: "expenses", collection: "expense-budgets", unit: "money", agg: "sum", direction: "none", hint: "Sum of every cap in force for the period." },
  { key: "spent", label: "Total spent", short: "Spent", group: "expenses", collection: "expense-budgets", unit: "money", agg: "sum", direction: "none", hint: "Approved and paid spend charged to those caps." },
  { key: "over", label: "Budgets over their cap", short: "Over", group: "expenses", collection: "expense-budgets", unit: "count", agg: "sum", direction: "lower", hint: "Caps whose spend has already passed them." },
  { key: "trending_over", label: "Budgets forecast to go over", short: "Trending over", group: "expenses", collection: "expense-budgets", unit: "count", agg: "sum", direction: "lower", hint: "Caps whose run rate lands them over by period end." },
];

export type BudgetNarration = {
  text: string;
  findings: Finding[];
  /** `plain` means the model was not used or its answer was rejected, so a caller can say so rather than
   *  presenting a deterministic list as though somebody wrote it. */
  source: "model" | "plain";
  cached: boolean;
  period_key: string;
  compared_to: string | null;
};

/** The period key immediately before this one, for the same period type. Derived by stepping back from the
 *  period's own start rather than by string arithmetic, so a quarter and a year behave without special cases. */
export function priorPeriodKey(type: PeriodType, key: string): string | null {
  try {
    const { start } = periodBounds(type, key);
    return periodKeyFor(type, new Date(start - 86_400_000)); // the day before this period began
  } catch {
    return null;
  }
}

/** Cap, spend and the two counts, for every budget of one period type in one period. */
async function totalsFor(deps: Deps, type: PeriodType, key: string, now: Date): Promise<Record<string, number> | null> {
  const caps = visibleByDelete(await deps.db.select().from(schema.expenseBudgets), false)
    .filter((b) => b.periodType === type && b.periodKey === key);
  if (!caps.length) return null; // no budgets for that period: nothing to compare, rather than a fall to zero
  const spends = await computeBudgetSpendMany(deps, caps);
  let budgeted = 0;
  let spent = 0;
  let over = 0;
  let trending = 0;
  for (const b of caps) {
    const s = spends.get(b.uuid)?.spent ?? 0;
    budgeted += b.amount;
    spent += s;
    if (b.amount > 0 && s > b.amount) { over++; continue; }
    // Not double-counted: a cap already over is a fact, and listing it again as a forecast would say the same
    // thing twice - the same rule the close checklist applies.
    const projection = budgetPhase(b, now.getTime()) === "current" ? budgetProjection(b, s, now.getTime()) : null;
    if (projection && projection.projectedOverBy > 0) trending++;
  }
  return { budgeted, spent, over, trending_over: trending };
}

/**
 * Narrate this period's budgets against the previous period's.
 *
 * Returns the plain summary rather than throwing when the feature is off or the budget is spent: nobody asked
 * for prose specifically, they asked what changed, and the numbers answer that with or without a model.
 */
export async function narrateBudgets(
  deps: Deps,
  user: AppUser,
  periodType: PeriodType = "monthly",
  periodKey?: string,
  now: Date = new Date(),
): Promise<BudgetNarration> {
  const key = periodKey ?? periodKeyFor(periodType, now);
  const prior = priorPeriodKey(periodType, key);
  const [current, previous] = await Promise.all([
    totalsFor(deps, periodType, key, now),
    prior ? totalsFor(deps, periodType, prior, now) : Promise.resolve(null),
  ]);

  const shell = { period_key: key, compared_to: prior };
  // Nothing to compare against - the first period an org budgets, or a period nobody set caps for.
  if (!current || !previous) return { text: plainSummary([]), findings: [], source: "plain", cached: false, ...shell };

  const findings = findMovements(MEASURES, previous, current);
  if (findings.length === 0) return { text: plainSummary(findings), findings, source: "plain", cached: false, ...shell };

  if (!deps.ai || !(await aiFeatureOn(deps, "budgets.narrate"))) {
    return { text: plainSummary(findings), findings, source: "plain", cached: false, ...shell };
  }

  // `reads: "none"`: the findings are sums this file computed, and no budget or expense row reaches the model.
  const out = await aiGenerate(deps, { feature: "budgets.narrate", userId: user.uuid, reads: "none" }, {
    system: SYSTEM,
    user: promptFor(findings),
    promptVersion: PROMPT_VERSION,
    maxTokens: 250,
  });
  if (!out.ok) {
    if (out.reason === "rate") throw resourceExhausted("you have used your AI allowance for this hour");
    return { text: plainSummary(findings), findings, source: "plain", cached: false, ...shell };
  }

  const text = out.value.trim();
  // A paragraph containing a figure nobody computed is discarded in favour of the true one. Logged rather
  // than surfaced: it is a model quality signal, not the reader's problem.
  if (!text || !groundedIn(text, findings)) {
    if (text) console.error("budget narration rejected: contained a number not in the findings");
    return { text: plainSummary(findings), findings, source: "plain", cached: false, ...shell };
  }
  return { text, findings, source: "model", cached: out.cached, ...shell };
}

const SYSTEM = [
  "You write one short paragraph about how an organisation's expense budgets moved between two periods.",
  "You are given the changes that were already found. Write about those and nothing else.",
  "Do NOT introduce any number that is not in the list. Do not total them, average them or work anything out.",
  // The same reason analyticsNarrate gives: `groundedIn` allows only the figures in the findings, so a model
  // that opens with the month's name has its paragraph thrown away and the neurons spent for nothing.
  "Do not mention any date, month, quarter or year. Refer to them as this period and the previous one.",
  "Do not speculate about causes. Do not recommend anything. Do not name or blame any team or person.",
  "Write in plain British English, at most three sentences, no bullet points, no heading, no em dashes.",
  "",
  UNTRUSTED_PREAMBLE,
].join("\n");

/** Every fact the model may state, as a compact list - which is what makes `groundedIn` a fair check rather
 *  than a trap. */
export function promptFor(findings: readonly Finding[]): string {
  return findings
    .map((f) => `${f.label}: was ${f.previous}, now ${f.current}${f.changePct === null ? "" : ` (${f.changePct > 0 ? "+" : ""}${Math.round(f.changePct)}%)`}`)
    .join("\n");
}
