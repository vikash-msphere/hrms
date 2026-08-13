import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { listCompensation, getCompensation, reviseCompensation, type CompensationInput } from "../services/compensation";
import { toCompensationResource } from "../http/serialize";

// Effective-dated base pay. POST is a salary revision/increment (closes the current row, opens a new one), so
// the create is the service's `reviseCompensation`. Compensation is entered as an annual CTC; the service
// derives the monthly basic + Special Allowance plug. Like positions: no PATCH, and no DELETE - a revision
// supersedes, and salary history is never removed (the table's delete_time exists for the employee cascade).
const reviseSchema = z
  .object({
    employee: z.string(),
    annual_ctc: z.number().positive(),
    currency_code: z.string().optional(),
    pay_grade: z.string().nullable().optional(),
    salary_structure: z.string().nullable().optional(),
    effective_from: z.string(),
  })
  .strict();

export const compensation = collectionRoutes<CompensationInput, typeof schema.compensation>({
  table: schema.compensation,
  collection: "compensation",
  auditName: "compensation",
  notFound: "compensation record not found",
  param: "compensation_id",
  createSchema: reviseSchema,
  serialize: toCompensationResource,
  softDelete: false,
  // Both reads carry the row's pay grade (withGrades), and the create is the revision itself.
  overrides: {
    get: (deps, _actor, id) => getCompensation(deps, id),
    create: (deps, actor, input) => reviseCompensation(deps, actor, input),
  },
  list: (c) => {
    // Optional ?employee=employees/<token> filter. The inbound edge (decodeWireIds) already decoded the query
    // ref to its internal id, so just take the id segment - do NOT decode again (that drops the filter).
    const emp = c.req.query("employee");
    return listCompensation(c.get("deps"), c.get("scope"), emp ? emp.split("/").pop()! : undefined).then((items) => ({ items, nextPageToken: undefined }));
  },
});
