// What changed on a board, in a sentence, over the top of numbers the board already had.
//
// SAME SHAPE AS services/analyticsNarrate.ts, and deliberately: the detection is arithmetic, the model is
// handed only the movements the arithmetic found, and a sentence containing a figure nobody computed is
// discarded in favour of the plain one. A model that cannot see the data cannot invent an anomaly in it.
//
// WHAT IS COMPARED: this board's flow over the chosen window against the window of equal length immediately
// before it - throughput, cycle time, lead time and how much work is in flight. Those four are the board's
// own vital signs, they are already computed for the analytics tab, and the comparison costs one extra pass
// over rows already read rather than a second query.
//
// NOTHING PERSONAL IS SENT. Four labels and two numbers each. No card title, no assignee, no department: a
// board narration is about flow, and the model is never told there are people involved.
import { and, eq, isNull } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { UNTRUSTED_PREAMBLE } from "../domain/aiPolicy";
import { findMovements, groundedIn, plainSummary, type Finding } from "../domain/narrate";
import type { MetricDef } from "../domain/peopleAnalytics";
import { computeBoardMetrics, type BoardMetrics } from "../domain/boardMetrics";
import { deliveryKey, parseColumns } from "../domain/boards";
import { aiFeatureOn, aiGenerate } from "./ai";

const DAY = 86_400_000;
const PROMPT_VERSION = "v1";

/**
 * The board's vital signs, in the shape `findMovements` compares.
 *
 * `direction` is stated rather than inferred, the same way the people report states it: faster delivery is
 * better, more delivered is better, and work in flight has NO good direction - a board with less of it is
 * either focused or starved, and the numbers cannot tell which.
 */
export const BOARD_MEASURES: MetricDef[] = [
  { key: "throughput", label: "Tasks delivered", short: "Delivered", group: "Flow", collection: "cards", unit: "count", agg: "sum", direction: "up" },
  { key: "cycle_time", label: "Cycle time (median)", short: "Cycle", group: "Flow", collection: "cards", unit: "days", agg: "avg", direction: "down" },
  { key: "lead_time", label: "Lead time (median)", short: "Lead", group: "Flow", collection: "cards", unit: "days", agg: "avg", direction: "down" },
  { key: "wip", label: "Tasks in flight", short: "WIP", group: "Flow", collection: "cards", unit: "count", agg: "sum", direction: "none" },
] as unknown as MetricDef[];

export type BoardNarration = {
  text: string;
  findings: Finding[];
  /** `plain` means the model was not used or its answer was rejected, so the caller can say so rather than
   *  presenting a deterministic list as though somebody wrote it. */
  source: "model" | "plain";
  cached: boolean;
  days: number;
};

const valuesOf = (m: BoardMetrics, doneKey: string | null): Record<string, number | null> => ({
  throughput: m.throughput.delivered,
  cycle_time: m.cycle_time.count > 0 ? m.cycle_time.p50 : null,
  lead_time: m.lead_time.count > 0 ? m.lead_time.p50 : null,
  // The last day of the diagram is the board as it stands: every column's count, LESS the one the board
  // flags as its delivery point, is what is actually in flight.
  //
  // Dropping that column is the whole measure. The diagram counts a card wherever it sits, done included, so
  // summing every column makes "tasks in flight" a number that can only rise - and a board that delivered
  // anything this period would then be told, every single time, that its work in flight went up.
  wip: m.cfd.length
    ? Object.entries(m.cfd[m.cfd.length - 1]!.counts)
      .filter(([key]) => key !== doneKey)
      .reduce((sum, [, n]) => sum + n, 0)
    : null,
});

/**
 * Narrate this board's last `days` against the `days` before them.
 *
 * Never throws for an unavailable model: nobody asked for prose, they asked what changed, and the numbers
 * answer that with or without one.
 */
export async function narrateBoard(deps: Deps, user: AppUser, boardId: string, days = 30): Promise<BoardNarration> {
  const window = Math.max(7, Math.min(90, days));
  const board = (await deps.db
    .select({ uuid: schema.boards.uuid, columnsJson: schema.boards.columnsJson })
    .from(schema.boards)
    .where(and(eq(schema.boards.uuid, boardId), isNull(schema.boards.deleteTime)))
    .limit(1))[0];
  if (!board) return { text: plainSummary([]), findings: [], source: "plain", cached: false, days: window };

  const parsed = parseColumns(board.columnsJson);
  // Which column IS delivery, kept rather than mapped away: `valuesOf` has to take it out of work-in-flight.
  const doneKey = deliveryKey(parsed);
  const cols = parsed.map((c) => ({ key: c.key, label: c.label }));
  const cardRows = await deps.db
    .select({ uuid: schema.cards.uuid, committedAt: schema.cards.committedAt, startedAt: schema.cards.startedAt, deliveredAt: schema.cards.deliveredAt })
    .from(schema.cards)
    .where(and(eq(schema.cards.boardId, boardId), isNull(schema.cards.deleteTime)));
  const live = new Set(cardRows.map((c) => c.uuid));
  const moveRows = await deps.db
    .select({ cardId: schema.cardMovements.cardId, toColumn: schema.cardMovements.toColumn, at: schema.cardMovements.at })
    .from(schema.cardMovements)
    .where(eq(schema.cardMovements.boardId, boardId));

  const cards = cardRows.map((c) => ({
    committedAt: c.committedAt ? +new Date(c.committedAt) : null,
    startedAt: c.startedAt ? +new Date(c.startedAt) : null,
    deliveredAt: c.deliveredAt ? +new Date(c.deliveredAt) : null,
  }));
  const movements = moveRows.filter((m) => live.has(m.cardId)).map((m) => ({ cardId: m.cardId, toColumn: m.toColumn, at: +new Date(m.at) }));

  const now = deps.clock.now().getTime();
  // ONE PASS OVER THE SAME ROWS, TWICE, EACH AS OF ITS OWN WINDOW. `computeBoardMetrics` takes its own clock
  // but counts every delivery at or after the window's start with no upper bound - right for a dashboard
  // whose window ends now, and wrong for a comparison, where the earlier half would otherwise count this
  // week's deliveries as its own and report that nothing changed. `asOf` is what makes the two halves like
  // for like: each sees the board as it stood at the end of its own window.
  const cut = now - window * DAY;
  const current = computeBoardMetrics(cols, ...asOf(cards, movements, cut, now), { days: window, now });
  const before = computeBoardMetrics(cols, ...asOf(cards, movements, cut - window * DAY, cut), { days: window, now: cut });

  const findings = findMovements(BOARD_MEASURES, valuesOf(before, doneKey), valuesOf(current, doneKey));
  // A quiet fortnight is the common answer, and the deterministic sentence is exactly as good as a written
  // one for it. No inference is spent saying nothing happened.
  if (findings.length === 0) return { text: plainSummary(findings), findings, source: "plain", cached: false, days: window };

  if (!deps.ai || !(await aiFeatureOn(deps, "boards.narrate"))) {
    return { text: plainSummary(findings), findings, source: "plain", cached: false, days: window };
  }

  const out = await aiGenerate(
    deps,
    // No `collection` is declared: nothing from `cards` is in this prompt. The four labels are this file's
    // own words and the numbers are aggregates.
    { feature: "boards.narrate", userId: user.uuid, subject: `boards/${boardId}` },
    { system: SYSTEM, user: promptFor(findings, window), promptVersion: PROMPT_VERSION, maxTokens: 220 },
  );

  if (!out.ok) return { text: plainSummary(findings), findings, source: "plain", cached: false, days: window };

  const text = out.value.trim();
  // THE GROUNDING CHECK, as on the team report: a figure nobody computed, beside a real diagram, is worse
  // than no sentence. Logged as a model-quality signal rather than surfaced to the reader.
  if (!text || !groundedIn(text, findings)) {
    if (text) console.error("board narration rejected: contained a number not in the findings");
    return { text: plainSummary(findings), findings, source: "plain", cached: false, days: window };
  }
  return { text, findings, source: "model", cached: out.cached, days: window };
}

/**
 * The board as it stood at the end of one window, and the deliveries that happened inside it.
 *
 * A card delivered outside the window is not un-delivered - it is simply not this window's delivery, so its
 * stamp is dropped for this computation and it contributes to neither the count nor the cycle-time
 * percentiles. Movements after the window's end are dropped whole, which is what makes work-in-flight read
 * as it did then rather than as it does now.
 */
function asOf(
  cards: { committedAt: number | null; startedAt: number | null; deliveredAt: number | null }[],
  movements: { cardId: string; toColumn: string; at: number }[],
  from: number,
  to: number,
): [typeof cards, typeof movements] {
  const within = cards.map((c) => (c.deliveredAt != null && (c.deliveredAt < from || c.deliveredAt >= to)
    ? { ...c, deliveredAt: null }
    : c));
  return [within, movements.filter((m) => m.at < to)];
}

const SYSTEM = [
  "You write one short paragraph about how a team's board changed between two periods of equal length.",
  "You are given the changes that were already found. Write about those and nothing else.",
  "Do NOT introduce any number that is not in the list. Do not total them, average them or work anything out.",
  "Do not mention any date, month, year, or how long the period is. Refer to them as this period and the previous one.",
  "Do not speculate about causes. Do not recommend anything. Do not praise or criticise anyone, and do not mention any person: you have not been told about any.",
  "Write in plain British English, at most three sentences, no bullet points, no heading, no em dashes.",
  "Where a measure has a good direction, you may say whether the movement was in it. Work in flight has no good direction: describe the change without judging it.",
  "",
  UNTRUSTED_PREAMBLE,
].join("\n");

/** The findings as a compact list. Every fact the model may state is on it, which is what makes the
 *  grounding check a fair test rather than a trap. */
export function promptFor(findings: readonly Finding[], days: number): string {
  const lines = findings.map((f) => {
    const good = f.direction === "none" ? "neither good nor bad" : `${f.direction} is the good direction`;
    const pct = f.changePct === null ? "no previous value to compare as a percentage" : `${Math.abs(f.changePct)}% ${f.movement}`;
    return `- ${f.label} (${f.unit}, ${good}): was ${f.previous}, now ${f.current}, ${pct}`;
  });
  return [
    `Context, not to be restated. Each period is ${days} days long.`,
    "Changes found:",
    ...lines,
  ].join("\n");
}
