import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { MAX_CYCLE_WEEKS, workPatternSpec, type WorkPatternInput } from "../services/workPatterns";
import { toWorkPatternResource } from "../http/serialize";

const writeSchema = z.object({
  name: z.string().optional(),
  cycle_weeks: z.number().int().min(1).max(MAX_CYCLE_WEEKS).optional(),
  // A cycle entry is a shift path or null for a rest day, so null is a VALUE here and the array is not
  // `.nullable()` as a whole: an absent `days` leaves the cycle alone, an array of nulls is a pattern of rest
  // days, and the two are different requests.
  days: z.array(z.string().nullable()).optional(),
  color: z.string().nullable().optional(),
}).strict();

// The schedule catalog: named cycles the roster hands out. Plain CRUD plus soft delete/restore - the shared
// lane. Retiring one leaves everybody already on it working (services/workPatterns.ts#assignedCount).
export const workPatterns = collectionRoutes<WorkPatternInput, typeof schema.workPatterns>({
  ...workPatternSpec,
  param: "pattern_id",
  writeSchema,
  serialize: toWorkPatternResource,
});
