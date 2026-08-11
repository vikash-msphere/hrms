import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { backgroundCheckSpec, listBackgroundChecks } from "../services/backgroundChecks";
import { toBackgroundCheckResource } from "../http/serialize";
import { clampPageSize } from "../http/pagination";

// Background-verification tracking. NO access checks - the middleware gates the path by grants (private by
// default; sensitive). Standard CRUD + soft-delete/restore, with a scope-filtered list.
const writeSchema = z
  .object({
    employee: z.string().optional(),
    check_type: z.enum(["identity", "address", "education", "employment", "criminal", "reference", "credit", "other"]).optional(),
    status: z.enum(["pending", "in_progress", "clear", "discrepancy", "failed"]).optional(),
    vendor: z.string().nullable().optional(),
    reference_no: z.string().nullable().optional(),
    initiated_date: z.string().nullable().optional(),
    completed_date: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
  })
  .strict();

export const backgroundChecks = collectionRoutes({
  ...backgroundCheckSpec,
  param: "background_check_id",
  writeSchema,
  serialize: toBackgroundCheckResource,
  list: (c) =>
    listBackgroundChecks(
      c.get("deps"),
      c.get("scope"),
      clampPageSize(Number(c.req.query("max_page_size")) || undefined),
      c.req.query("page_token"),
      c.req.query("show_deleted") === "true",
    ),
});
