import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { holidaySpec } from "../services/holidays";
import { toHolidayResource } from "../http/serialize";

const writeSchema = z
  .object({
    display_name: z.string().min(1).optional(),
    date: z.string().optional(),
    kind: z.enum(["fixed", "optional"]).optional(),
    // null/"" = company-wide; a value scopes the holiday to employees whose current position location matches.
    location: z.string().nullish(),
    half_day: z.boolean().optional(),
  })
  .strict();

// Lifecycle + restore are config.write. (Selecting an optional holiday is POST /holiday-selections.)
export const holidays = collectionRoutes({ ...holidaySpec, param: "holiday_id", writeSchema, serialize: toHolidayResource });
