import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { listCompensation, getCompensation, reviseCompensation } from "../services/compensation";
import { toCompensationResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";

const COL = "compensation";

// Effective-dated base pay. POST is a salary revision/increment (closes the current row, opens a new one).
// Compensation is entered as an annual CTC; the service derives the monthly basic + Special Allowance plug.
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

export const compensation = new Hono<AppEnv>()
  .get("/", async (c) => {
    // Optional ?employee=employees/<token> filter. The inbound edge (decodeWireIds) already decoded the
    // query ref to its internal id, so just take the id segment - do NOT decode again (that fails, dropping the filter).
    const emp = c.req.query("employee");
    const employeeId = emp ? emp.split("/").pop()! : undefined;
    const rows = await listCompensation(c.get("deps"), c.get("scope"), employeeId);
    const user = c.get("user");
    return c.json({ results: rows.map((r) => withAccess(toCompensationResource(r), user, COL, r.code)) });
  })
  .get("/:compensation_id", async (c) => {
    const row = await getCompensation(c.get("deps"), c.req.param("compensation_id"));
    return c.json(withAccess(toCompensationResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", reviseSchema), async (c) => {
    const row = await reviseCompensation(c.get("deps"), c.get("user"), c.req.valid("json"));
    return c.json(withAccess(toCompensationResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  });
