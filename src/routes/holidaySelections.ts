import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import {
  listHolidaySelections,
  getHolidaySelection,
  createHolidaySelection,
  deleteHolidaySelection,
} from "../services/holidaySelections";
import { toHolidaySelectionResource } from "../http/serialize";
import { clampPageSize } from "../http/pagination";

const writeSchema = z.object({ holiday: z.string().optional() }).strict();

// An employee's optional-holiday picks: create = select, delete = deselect. Every method is the service's own,
// because each carries a rule the generic lane has no opinion about - the create is idempotent and capped by
// settings/holidays.max_optional, the get and the delete are owner-only, and a deselect is permanent (the row
// IS the selection, so leaving a deleted one behind would keep the holiday looking picked).
export const holidaySelections = collectionRoutes({
  table: schema.holidaySelections,
  collection: "holiday-selections",
  auditName: "holiday",
  notFound: "selection not found",
  param: "selection_id",
  createSchema: writeSchema,
  serialize: toHolidaySelectionResource,
  softDelete: false,
  overrides: {
    get: getHolidaySelection,
    create: (deps, actor, input: { holiday?: string }) => createHolidaySelection(deps, actor, input.holiday),
    remove: (deps, actor, id) => deleteHolidaySelection(deps, actor, id),
  },
  list: (c) =>
    listHolidaySelections(
      c.get("deps"),
      c.get("user"),
      clampPageSize(Number(c.req.query("max_page_size")) || undefined),
      c.req.query("page_token"),
    ),
});
