import { Hono } from "hono";
import { z } from "zod";
import { positiveMoney } from "../http/moneyField";
import type { AppEnv } from "../env";
import { jsonBody } from "../http/jsonRequest";
import { previewIncrementBatch, applyIncrementBatch, MAX_INCREMENT_BATCH } from "../services/compensation";
import { invalidArgument } from "../lib/errors";

// Collection-level custom method `compensation:increment` (mounted at the full path in index.ts, for the same
// Hono reason `compensation:reapplySplit` is). An increment round: price a team's proposed raises, or apply
// them.
//
// ONE VERB WITH `dry_run`, exactly as `reapplySplit` does it, rather than a second `:previewIncrement`. The
// two are the same question asked before and after a decision, and the capability that may price a round is
// the capability that may commit one - splitting them would invent a grant nobody wants to hold separately.
const lineSchema = z.object({
  employee: z.string(),
  annual_ctc: positiveMoney(),
  effective_from: z.string(),
  pay_grade: z.string().nullable().optional(),
  salary_structure: z.string().nullable().optional(),
});

const bodySchema = z
  .object({
    increments: z.array(lineSchema).min(1).max(MAX_INCREMENT_BATCH),
    dry_run: z.boolean().optional(),
  })
  .strict();

export const compensationIncrement = new Hono<AppEnv>().post("/", async (c) => {
  const parsed = bodySchema.safeParse(await jsonBody(c));
  if (!parsed.success) {
    throw invalidArgument(`increments must be a list of at most ${MAX_INCREMENT_BATCH} people, each with an employee, an annual_ctc and an effective_from`);
  }
  const deps = c.get("deps");
  // The default is the SAFE one: a body that forgets `dry_run` prices the round rather than committing it.
  // `reapplySplit` defaults the other way because its verb name already says what it does; "increment" does
  // not, and a batch of salary revisions is not something to apply because a flag was omitted.
  if (parsed.data.dry_run === false) {
    return c.json(await applyIncrementBatch(deps, c.get("user"), parsed.data.increments));
  }
  // The totals are the one camelCase thing in the answer, spelled for the wire here rather than in the
  // service. The per-row previews pass through as the single-revision preview already shapes them.
  const { rows, totals } = await previewIncrementBatch(deps, parsed.data.increments);
  return c.json({
    rows,
    totals: {
      people: totals.people,
      priced: totals.priced,
      annual_ctc_delta: totals.annualCtcDelta,
      monthly_gross_delta: totals.monthlyGrossDelta,
      arrears: totals.arrears,
      crossings: totals.crossings,
    },
  });
});
