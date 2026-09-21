// Propose how a goal could be measured, as three fields somebody accepts.
//
// ONE GENERATION, ON A BUTTON. About 120 neurons, paid by the person who pressed it, on the one screen where
// the answer is worth that: a goal being written or proposed. Nothing runs on a list, on a save, or on a
// cron.
//
// WHAT THE MODEL IS SHOWN is the goal's own title and description - text the caller is looking at, on a
// collection that is not on the denylist - and nothing else. No progress, no owner, no review, no history.
// It cannot form a view about the person because it is never told there is one.
//
// WHAT COMES BACK is parsed into exactly three nullable fields and rejected outright otherwise, and lands as
// a SUGGESTION in the form. Accepting it is the ordinary goal update with the ordinary validation and audit
// row, so a proposed target is the same as a typed one by the time it reaches the database.
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { failedPrecondition, invalidArgument, notFound, resourceExhausted } from "../lib/errors";
import { fence } from "../domain/aiPolicy";
import { MEASURE_PROMPT_VERSION, MEASURE_SYSTEM } from "../domain/goalMeasure";
import { aiFeatureOn, aiGenerate } from "./ai";

/**
 * The shape the model must answer in, and the only shape this accepts.
 *
 * `.strict()` so an extra key is a parse failure rather than a field that quietly rides along, and every
 * value is nullable because "this goal does not say" is the normal answer for at least one of the three.
 */
const proposal = z
  .object({
    unit: z.string().max(40).nullable(),
    baseline_value: z.number().finite().nullable(),
    target_value: z.number().finite().nullable(),
  })
  .partial()
  .strict();

export type MeasureProposal = { unit?: string | null; baseline_value?: number | null; target_value?: number | null; cached: boolean };

export async function proposeGoalMeasure(deps: Deps, user: AppUser, goalId: string): Promise<MeasureProposal> {
  const goal = (await deps.db
    .select({ title: schema.goals.title, description: schema.goals.description })
    .from(schema.goals)
    .where(and(eq(schema.goals.uuid, goalId), isNull(schema.goals.deleteTime)))
    .limit(1))[0];
  if (!goal) throw notFound("goal not found");

  // Throws rather than returning a refusal, for the same reason drafting does: somebody pressed a button and
  // is waiting, so "switched off" has to be an answer they can read.
  if (!deps.ai) throw failedPrecondition("AI is not available on this deployment");
  if (!(await aiFeatureOn(deps, "goals.measure"))) throw failedPrecondition("measure suggestions are switched off for this organisation");

  const text = [goal.title, goal.description].filter(Boolean).join("\n\n").trim();
  if (!text) throw invalidArgument("this goal has no title or description to read");

  const out = await aiGenerate(
    deps,
    { feature: "goals.measure", userId: user.uuid, subject: `goals/${goalId}`, collection: "goals" },
    {
      system: MEASURE_SYSTEM,
      user: fence("the goal", text),
      promptVersion: MEASURE_PROMPT_VERSION,
      maxTokens: 200,
    },
  );

  if (!out.ok) {
    if (out.reason === "rate") throw resourceExhausted("you have used your AI allowance for this hour");
    if (out.reason === "budget") throw resourceExhausted("the organisation's AI budget for today is spent; it resets at midnight UTC");
    if (out.reason === "unavailable") throw failedPrecondition("AI is not available on this deployment");
    throw failedPrecondition("the model could not be reached just now");
  }

  return { ...parseProposal(out.value), cached: out.cached };
}

/**
 * The model's answer, or nothing.
 *
 * A model that returns prose, a fenced block or a fourth key has failed the contract, and the honest thing is
 * to say so rather than to pick the parts that parsed: a half-read answer would put a number in a field with
 * no idea what the other two were meant to be.
 */
export function parseProposal(raw: string): { unit?: string | null; baseline_value?: number | null; target_value?: number | null } {
  const text = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw failedPrecondition("the model did not answer with a measure");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw failedPrecondition("the model did not answer with a measure");
  }
  const result = proposal.safeParse(parsed);
  if (!result.success) throw failedPrecondition("the model did not answer with a measure");

  const unit = result.data.unit?.trim() || null;
  const baseline = result.data.baseline_value ?? null;
  const target = result.data.target_value ?? null;
  // A target equal to its baseline is not a goal, and offering it would have somebody accept a measure that
  // reads 100% done the moment it is saved.
  if (baseline != null && target != null && baseline === target) {
    return { unit, baseline_value: null, target_value: null };
  }
  return { unit, baseline_value: baseline, target_value: target };
}
