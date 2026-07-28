import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { listPositions, getPosition, changeRole } from "../services/positions";
import { toPositionResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";

const COL = "positions";

// Effective-dated role history. POST records a promotion/transfer (closes the current row, opens a new one).
const changeSchema = z
  .object({
    employee: z.string(),
    job_title: z.string().nullable().optional(),
    department: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    effective_from: z.string(),
  })
  .strict();

export const positions = new Hono<AppEnv>()
  .get("/", async (c) => {
    // Optional ?employee=employees/<token> filter. The inbound edge (decodeWireIds) already decoded the
    // query ref to its internal id, so just take the id segment - do NOT decode again (that fails, dropping the filter).
    const emp = c.req.query("employee");
    const employeeId = emp ? emp.split("/").pop()! : undefined;
    const rows = await listPositions(c.get("deps"), c.get("scope"), employeeId);
    const user = c.get("user");
    return c.json({ results: rows.map((r) => withAccess(toPositionResource(r), user, COL, r.code)) });
  })
  .get("/:position_id", async (c) => {
    const row = await getPosition(c.get("deps"), c.req.param("position_id"));
    return c.json(withAccess(toPositionResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", changeSchema), async (c) => {
    const row = await changeRole(c.get("deps"), c.get("user"), c.req.valid("json"));
    return c.json(withAccess(toPositionResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  });
