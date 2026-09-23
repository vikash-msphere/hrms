import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { shiftSpec } from "../services/shifts";
import { toShiftResource } from "../http/serialize";

const writeSchema = z.object({
  name: z.string().min(1).optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  break_minutes: z.number().optional(),
  color: z.string().nullable().optional(),
}).strict();

export const shifts = collectionRoutes({ ...shiftSpec, param: "shift_id", writeSchema, serialize: toShiftResource });
