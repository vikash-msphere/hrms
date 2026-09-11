import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import * as schema from "../db/schema";
import type { AppEnv } from "../env";
import { collectionRoutes } from "../http/collectionRoute";
import { listBonuses, recordBonus, awardBonus, type BonusInput } from "../services/bonuses";
import { toBonusResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";

const COL = "bonuses";

// One-off awards (bonus/incentive). POST records a single-employee award.
const recordSchema = z
  .object({
    employee: z.string(),
    amount: z.number().positive(),
    currency_code: z.string().optional(),
    kind: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
    award_date: z.string(),
  })
  .strict();

// Scoped award: company-wide / a department / a single employee, materialized one row per in-scope employee.
const awardSchema = z
  .object({
    scope: z.enum(["company", "department", "individual"]),
    department: z.string().nullable().optional(),
    employee: z.string().nullable().optional(),
    amount: z.number().positive(),
    currency_code: z.string().optional(),
    kind: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
    award_date: z.string(),
  })
  .strict();

// Collection-level custom method `bonuses:award` (mounted at the full path in index.ts, before the bonuses
// mount, like announcements:post). Authz resolves it to the `bonuses.award` verb (grantable via the ACL). It
// answers with a page of rows rather than one resource, so it stays outside the item-verb lane the factory
// owns - `verbs` there is keyed by the verb on an item path.
export const bonusAward = new Hono<AppEnv>().post("/", zValidator("json", awardSchema), async (c) => {
  const user = c.get("user");
  const rows = await awardBonus(c.get("deps"), user, c.req.valid("json"));
  return c.json({ results: rows.map((r) => withAccess(toBonusResource(r), user, COL, r.code)) });
});

// A recorded award is an immutable payable: payroll (or an FnF settlement) pays it, and the row is the
// evidence of what was paid. Hence no PATCH, and no delete_time on the table - so no DELETE, no `:restore`.
export const bonuses = collectionRoutes<BonusInput, typeof schema.bonuses>({
  table: schema.bonuses,
  collection: COL,
  auditName: "bonus",
  notFound: "bonus record not found",
  param: "bonus_id",
  createSchema: recordSchema,
  serialize: toBonusResource,
  overrides: {
    // The create carries the double-submit guard (an identical unpaid award within two minutes is REUSED, not
    // inserted again) and notifies the employee, so it stays the service's own.
    create: (deps, actor, input) => recordBonus(deps, actor, input),
  },
  list: (c, page) => {
    // The inbound edge (decodeWireIds) already decoded the query ref to its internal id; just take the id.
    const emp = c.req.query("employee");
    return listBonuses(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, emp ? emp.split("/").pop()! : undefined);
  },
});
