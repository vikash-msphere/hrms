import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { listBonuses, getBonus, recordBonus, awardBonus } from "../services/bonuses";
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
// mount, like announcements:post). Authz resolves it to the `bonuses.award` verb (grantable via the ACL).
export const bonusAward = new Hono<AppEnv>().post("/", zValidator("json", awardSchema), async (c) => {
  const user = c.get("user");
  const rows = await awardBonus(c.get("deps"), user, c.req.valid("json"));
  return c.json({ results: rows.map((r) => withAccess(toBonusResource(r), user, COL, r.code)) });
});

export const bonuses = new Hono<AppEnv>()
  .get("/", async (c) => {
    // The inbound edge (decodeWireIds) already decoded the query ref to its internal id; just take the id.
    const emp = c.req.query("employee");
    const employeeId = emp ? emp.split("/").pop()! : undefined;
    const rows = await listBonuses(c.get("deps"), c.get("scope"), employeeId);
    const user = c.get("user");
    return c.json({ results: rows.map((r) => withAccess(toBonusResource(r), user, COL, r.code)) });
  })
  .get("/:bonus_id", async (c) => {
    const row = await getBonus(c.get("deps"), c.req.param("bonus_id"));
    return c.json(withAccess(toBonusResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", recordSchema), async (c) => {
    const row = await recordBonus(c.get("deps"), c.get("user"), c.req.valid("json"));
    return c.json(withAccess(toBonusResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  });
