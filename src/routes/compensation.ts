import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { listCompensation, getCompensation, reviseCompensation, updateCompensation, deleteCompensation, decorateCompensation, type CompensationInput } from "../services/compensation";
import { toCompensationResource } from "../http/serialize";

// Effective-dated base pay. Compensation is entered as an annual CTC; the service derives the monthly basic +
// Special Allowance plug. Every method is the service's, because every one of them is a write to the employee's
// TIMELINE rather than to a row on its own:
//   POST   - add a revision at any effective date, including into the middle of the history.
//   PATCH  - correct one that was entered wrong (CTC, grade, structure, currency, date within its slot).
//   DELETE - take one out of the timeline; the revision before it absorbs the window and reopens if needed.
// The delete is soft (the row is kept and marked, so audit links and past payslips still resolve) but it is
// NOT restorable through the API and takes no `?force` purge, so the factory mounts neither `:restore` nor the
// hard delete: `softDelete: false` plus an `overrides.remove`. The whole set is audited, before and after.
const reviseSchema = z
  .object({
    employee: z.string(),
    annual_ctc: z.number().positive(),
    variable_pay_target: z.number().min(0).nullable().optional(),
    currency_code: z.string().optional(),
    pay_grade: z.string().nullable().optional(),
    salary_structure: z.string().nullable().optional(),
    effective_from: z.string(),
  })
  .strict();

// A correction names only what it corrects; `employee` is not among them - a revision cannot be moved to
// another person, and asking for that is a create on the other timeline plus a delete on this one.
const correctSchema = reviseSchema
  .omit({ employee: true })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "send at least one field to change" });

export const compensation = collectionRoutes<CompensationInput, typeof schema.compensation>({
  table: schema.compensation,
  collection: "compensation",
  auditName: "compensation",
  notFound: "compensation record not found",
  param: "compensation_id",
  createSchema: reviseSchema,
  updateSchema: correctSchema,
  serialize: toCompensationResource,
  softDelete: false,
  // Prices the current row's CTC build-up and hides the grade/band from a self-service reader - see
  // decorateCompensation. On the factory's shared decorate hook, so the item read and the list agree.
  decorate: decorateCompensation,
  // Both reads carry the row's pay grade (withGrades); the writes are all timeline operations.
  overrides: {
    get: (deps, _actor, id) => getCompensation(deps, id),
    create: (deps, actor, input) => reviseCompensation(deps, actor, input),
    update: (deps, actor, id, patch, ifMatch) => updateCompensation(deps, actor, id, patch, ifMatch),
    remove: (deps, actor, id, ifMatch) => deleteCompensation(deps, actor, id, ifMatch),
  },
  list: (c, page) => {
    // Optional ?employee=employees/<token> filter. The inbound edge (decodeWireIds) already decoded the query
    // ref to its internal id, so just take the id segment - do NOT decode again (that drops the filter).
    const emp = c.req.query("employee");
    return listCompensation(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, emp ? emp.split("/").pop()! : undefined, page.showDeleted, page.deletedOnly);
  },
});
