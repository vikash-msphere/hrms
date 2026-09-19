// A sentence or two about what changed in a team report, over the top of numbers that were already there.
//
// The detection is `findMovements`, which is arithmetic. This file runs the SAME report over two equal
// windows, hands the differences to a model, and checks what comes back before showing it. Three properties
// hold it together:
//
//   THE MODEL CANNOT INVENT AN ANOMALY. It never sees the data, only a list of movements the comparison
//   already found. There is nothing for it to notice that the arithmetic did not.
//   THE MODEL CANNOT INVENT A NUMBER. `groundedIn` rejects a narration containing any figure that was not in
//   the findings, and the caller falls back to the plain summary. A fabricated figure beside a real
//   dashboard is worse than no sentence.
//   NOTHING PERSONAL IS SENT. The prompt is built from TEAM aggregates: measure labels and two numbers each.
//   No employee, no name, no row. The report's own per-person rows are never touched here.
//
// The window comparison is against the immediately preceding window of equal length, which is the comparison
// a reader assumes when they are shown "up 18%" and the only one that needs no explaining.
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import type { ListScope } from "../domain/access";
import { failedPrecondition, invalidArgument, resourceExhausted } from "../lib/errors";
import { UNTRUSTED_PREAMBLE } from "../domain/aiPolicy";
import { MAX_FINDINGS, findMovements, groundedIn, plainSummary, type Finding } from "../domain/narrate";
import { peopleAnalytics, type AnalyticsQuery } from "./peopleAnalytics";
import { aiFeatureOn, aiGenerate } from "./ai";

// v2: the system prompt forbids restating the dates and the user prompt labels them as context. Bumped with
// that edit, because `aiGenerate` caches on (feature, promptVersion, inputs) - left at v1 every window that had
// already been narrated would keep serving the paragraph the OLD prompt produced, which is the one the
// grounding check throws away.
const PROMPT_VERSION = "v2";

export type Narration = {
  text: string;
  findings: Finding[];
  /** How the text was produced. `plain` means the model was not used or its answer was rejected - the caller
   *  can say so rather than presenting a deterministic list as if it were written. */
  source: "model" | "plain";
  cached: boolean;
  window: { from: string; to: string };
  compared_to: { from: string; to: string };
};

/**
 * Narrate the change between `q`'s window and the one before it.
 *
 * Returns the plain summary rather than throwing when the feature is off or the budget is spent: unlike a
 * draft, nobody asked for prose specifically - they asked what changed, and the numbers answer that whether
 * or not a model is available. Only a malformed request throws.
 */
export async function narrateAnalytics(
  deps: Deps,
  user: AppUser,
  scopes: Map<string, ListScope>,
  q: AnalyticsQuery,
): Promise<Narration> {
  const prior = priorWindow(q.from, q.to);
  if (!prior) throw invalidArgument("from must be a date on or before to");

  // The same report twice. `employeeId`/`series` are dropped: a narration is about the team, and running the
  // per-person series for a comparison window would be work nobody reads.
  const base = { ...q, series: false, employeeId: undefined };
  const [now, before] = await Promise.all([
    peopleAnalytics(deps, scopes, base),
    peopleAnalytics(deps, scopes, { ...base, from: prior.from, to: prior.to }),
  ]);

  const findings = findMovements(now.metrics, before.team, now.team);
  const windows = { window: { from: q.from, to: q.to }, compared_to: prior };

  // Nothing moved: say so without spending an inference. This is the common answer on a quiet week, and it is
  // the one case where the deterministic sentence is exactly as good as a written one.
  if (findings.length === 0) return { text: plainSummary(findings), findings, source: "plain", cached: false, ...windows };

  if (!deps.ai || !(await aiFeatureOn(deps, "analytics.narrate"))) {
    return { text: plainSummary(findings), findings, source: "plain", cached: false, ...windows };
  }

  const out = await aiGenerate(
    deps,
    { feature: "analytics.narrate", userId: user.uuid },
    {
      system: SYSTEM,
      user: promptFor(findings, q, prior),
      promptVersion: PROMPT_VERSION,
      maxTokens: 300,
    },
  );

  if (!out.ok) {
    // A refusal is not an error here. The reader gets the same facts, plainly written.
    if (out.reason === "rate") throw resourceExhausted("you have used your AI allowance for this hour");
    return { text: plainSummary(findings), findings, source: "plain", cached: false, ...windows };
  }

  const text = out.value.trim();
  // THE GROUNDING CHECK. A narration containing a number nobody computed is discarded, silently and in
  // favour of the true one. Logged rather than surfaced: it is a model quality signal, not the reader's
  // problem.
  if (!text || !groundedIn(text, findings)) {
    if (text) console.error("analytics narration rejected: contained a number not in the findings");
    return { text: plainSummary(findings), findings, source: "plain", cached: false, ...windows };
  }

  return { text, findings, source: "model", cached: out.cached, ...windows };
}

// ---------------------------------------------------------------------------------------------------------

const SYSTEM = [
  "You write one short paragraph about how a team's measures changed between two periods.",
  "You are given the changes that were already found. Write about those and nothing else.",
  "Do NOT introduce any number that is not in the list. Do not total them, average them or work anything out.",
  // THE DATES ARE CONTEXT, NOT MATERIAL, and saying so is what keeps the grounding check from rejecting almost
  // every generation. `groundedIn` (domain/narrate.ts) allows only the figures in the findings, deliberately -
  // a year or a period length beside a real dashboard is a claim nobody computed. The prompt below states the
  // window so the model knows what it is describing, and a model left to its own devices will then open with
  // "Between 1 and 7 March...", whose digits are not findings: the paragraph is discarded, the reader gets the
  // plain summary, and the neurons and the caller's hourly allowance are spent for nothing. So the one thing
  // it must not do with the dates is repeat them.
  "Do not mention any date, month, year, or how long the period is. Refer to them as this period and the previous one.",
  "Do not speculate about causes. Do not recommend anything. Do not praise or criticise anyone.",
  "Write in plain British English, at most four sentences, no bullet points, no heading, no em dashes.",
  "Where a measure has a good direction, you may say whether the movement was in it. Where it has none, describe the change without judging it.",
  "",
  UNTRUSTED_PREAMBLE,
].join("\n");

/** The findings as a compact list. Every fact the model is allowed to state is on this list, which is what
 *  makes `groundedIn` a fair check rather than a trap. */
export function promptFor(findings: readonly Finding[], window: { from: string; to: string }, prior: { from: string; to: string }): string {
  const lines = findings.slice(0, MAX_FINDINGS).map((f) => {
    const good = f.direction === "none" ? "neither good nor bad" : `${f.direction} is the good direction`;
    const pct = f.changePct === null ? "no previous value to compare as a percentage" : `${Math.abs(f.changePct)}% ${f.movement}`;
    return `- ${f.label} (${f.unit}, ${good}): was ${f.previous}, now ${f.current}, ${pct}`;
  });
  return [
    // Labelled as context so the instruction above ("do not mention any date") has something to attach to, and
    // so a reader of a logged prompt can see the window a narration was about without the model repeating it.
    `Context, not to be restated. This period: ${window.from} to ${window.to}. The previous period of equal length: ${prior.from} to ${prior.to}.`,
    "Changes found:",
    ...lines,
  ].join("\n");
}

/**
 * The window of equal length immediately before `from`.
 *
 * Inclusive dates, so a 1st-to-7th window is seven days and the one before it ends on the last day of the
 * previous week rather than overlapping it. Returns null for a reversed or unparseable pair, which the caller
 * turns into a 400.
 */
export function priorWindow(from: string, to: string): { from: string; to: string } | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  const day = 86_400_000;
  const lengthDays = Math.round((b - a) / day) + 1;
  const priorEnd = a - day;
  const priorStart = priorEnd - (lengthDays - 1) * day;
  return { from: ymd(priorStart), to: ymd(priorEnd) };
}

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
