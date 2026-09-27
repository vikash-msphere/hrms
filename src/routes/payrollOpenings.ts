import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { jsonBody } from "../http/jsonRequest";
import { nonNegativeMoney } from "../http/moneyField";
import { toPayrollOpeningResource } from "../http/serialize";
import { invalidArgument } from "../lib/errors";
import {
  createPayrollOpening, importPayrollOpenings, listPayrollOpenings, updatePayrollOpening,
  PAYROLL_OPENING_BATCH_MAX, type PayrollOpeningInput,
} from "../services/payrollOpenings";

// Pay and tax already paid this financial year before HRMS ran payroll (services/payrollOpenings.ts). One live
// entry per person per year; create and update are the service's own because both check the figures against
// the year and against HRMS's own finalized runs. Delete is the factory's soft delete.
const fields = {
  employee: z.string(),
  financial_year: z.string(),
  paid_through: z.string(),
  gross: nonNegativeMoney(),
  taxable_gross: nonNegativeMoney().optional(),
  tds: nonNegativeMoney().optional(),
  pt: nonNegativeMoney().optional(),
  esi_contributing: z.boolean().optional(),
  note: z.string().nullable().optional(),
};
const createSchema = z.object(fields).strict();
const updateSchema = z.object(fields).partial().strict();

export const payrollOpenings = collectionRoutes<PayrollOpeningInput, typeof schema.payrollOpenings>({
  table: schema.payrollOpenings,
  collection: "payroll-openings",
  auditName: "payroll_opening",
  notFound: "payroll opening not found",
  param: "payroll_opening_id",
  createSchema,
  updateSchema,
  serialize: toPayrollOpeningResource,
  overrides: {
    create: (deps, actor, input) => createPayrollOpening(deps, actor, input),
    update: (deps, actor, id, patch, ifMatch) => updatePayrollOpening(deps, actor, id, patch, ifMatch),
  },
  list: (c, page) =>
    listPayrollOpenings(
      c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken,
      c.req.query("employee"), c.req.query("financial_year"), page.showDeleted, page.deletedOnly,
    ),
});

const importSchema = z
  .object({ items: z.array(createSchema).min(1).max(PAYROLL_OPENING_BATCH_MAX), dry_run: z.boolean().optional() })
  .strict();

// Collection-level custom method `payroll-openings:importOpenings` (mounted at the full path in index.ts, before
// the collection mount). `{ items: [...] }` is the bulk envelope the authz middleware gates per item, so every
// `employee` in it is checked against the caller's write on that employee's entry (the owner ref), exactly as
// a single create is. The default is the SAFE one: a body that forgets `dry_run` previews rather than applies.
export const payrollOpeningImport = new Hono<AppEnv>().post("/", async (c) => {
  const parsed = importSchema.safeParse(await jsonBody(c));
  if (!parsed.success) {
    throw invalidArgument(`send up to ${PAYROLL_OPENING_BATCH_MAX} rows as { items: [{ employee, financial_year, paid_through, gross, taxable_gross?, tds?, pt?, esi_contributing?, note? }] }`);
  }
  return c.json(await importPayrollOpenings(c.get("deps"), c.get("user"), parsed.data.items, parsed.data.dry_run !== false));
});
