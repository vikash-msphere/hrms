import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { listSettlements, getSettlement, computeAndStoreSettlement } from "../services/settlements";
import { toSettlementResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";

const COL = "settlements";

// Full-and-final settlement (FnF). POST computes + stores a snapshot from the employee's data + exit inputs.
const computeSchema = z
  .object({
    employee: z.string(),
    settlement_date: z.string().optional(),
    leave_days: z.number().min(0).optional(),
    notice_shortfall_days: z.number().min(0).optional(),
  })
  .strict();

export const settlements = new Hono<AppEnv>()
  .get("/", async (c) => {
    // The inbound edge (decodeWireIds) already decoded the query ref to its internal id; just take the id.
    const emp = c.req.query("employee");
    const employeeId = emp ? emp.split("/").pop()! : undefined;
    const rows = await listSettlements(c.get("deps"), c.get("scope"), employeeId);
    const user = c.get("user");
    return c.json({ results: rows.map((r) => withAccess(toSettlementResource(r), user, COL, r.code)) });
  })
  .get("/:settlement_id", async (c) => {
    const row = await getSettlement(c.get("deps"), c.req.param("settlement_id"));
    return c.json(withAccess(toSettlementResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", computeSchema), async (c) => {
    const row = await computeAndStoreSettlement(c.get("deps"), c.get("user"), c.req.valid("json"));
    return c.json(withAccess(toSettlementResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  });
