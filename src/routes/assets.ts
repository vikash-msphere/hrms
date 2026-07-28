import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { listAssets, getAsset, createAsset, updateAsset, deleteAsset } from "../services/assets";
import { toAssetResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";

const COL = "assets";

const writeSchema = z
  .object({
    asset_tag: z.string().nullable().optional(),
    name: z.string().min(1).optional(),
    category: z.string().nullable().optional(),
    serial_number: z.string().nullable().optional(),
    status: z.enum(["in_stock", "assigned", "repair", "retired"]).optional(),
    assigned_to: z.string().nullable().optional(),
    assigned_on: z.string().nullable().optional(),
    purchase_date: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
  })
  .strict();

export const assets = new Hono<AppEnv>()
  .get("/", async (c) => {
    // The inbound edge (decodeWireIds) already decoded the query ref to its internal id; just take the id.
    const emp = c.req.query("employee");
    const employeeId = emp ? emp.split("/").pop()! : undefined;
    const rows = await listAssets(c.get("deps"), c.get("scope"), employeeId);
    const user = c.get("user");
    return c.json({ results: rows.map((r) => withAccess(toAssetResource(r), user, COL, r.code)) });
  })
  .get("/:asset_id", async (c) => {
    const row = await getAsset(c.get("deps"), c.req.param("asset_id"));
    return c.json(withAccess(toAssetResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createAsset(c.get("deps"), c.get("user"), c.req.valid("json"));
    return c.json(withAccess(toAssetResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .patch("/:asset_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateAsset(c.get("deps"), c.get("user"), c.req.param("asset_id"), c.req.valid("json"), c.req.header("If-Match"));
    return c.json(withAccess(toAssetResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .delete("/:asset_id", async (c) => {
    await deleteAsset(c.get("deps"), c.get("user"), c.req.param("asset_id"), c.req.header("If-Match"));
    return c.body(null, 204);
  });
