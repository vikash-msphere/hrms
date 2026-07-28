import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { customMethod } from "../http/customMethod";
import { lifecycleVerb } from "../http/lifecycleRoute";
import * as schema from "../db/schema";
import {
  listVendors, getVendor, createVendor, updateVendor, deleteVendor, restoreVendor, purgeVendor,
} from "../services/vendors";
import { toVendorResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";

const COL = "vendors";
const writeSchema = z.object({
  display_name: z.string().min(1).optional(),
  contact_email: z.string().nullable().optional(),
  contact_phone: z.string().nullable().optional(),
  tax_id: z.string().nullable().optional(),
  payment_terms: z.string().nullable().optional(),
  bank_details: z.string().nullable().optional(),
  default_category: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
}).strict();

export const vendors = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listVendors(c.get("deps"), c.get("user"), maxPageSize, c.req.query("page_token"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toVendorResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:vendor_id", async (c) => {
    const row = await getVendor(c.get("deps"), c.get("user"), c.req.param("vendor_id")!);
    return c.json(toVendorResource(row));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createVendor(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(toVendorResource(row));
  })
  .patch("/:vendor_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateVendor(c.get("deps"), c.get("user"), c.req.param("vendor_id")!, c.req.valid("json"), c.req.header("If-Match"));
    return c.json(toVendorResource(row));
  })
  .delete("/:vendor_id", async (c) => {
    const id = c.req.param("vendor_id")!;
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") await purgeVendor(c.get("deps"), c.get("user"), id, ifMatch);
    else await deleteVendor(c.get("deps"), c.get("user"), id, ifMatch);
    return c.body(null, 204);
  })
  .post("/:vendor_id", async (c) => {
    const lc = await lifecycleVerb(c, { table: schema.vendors, singular: "vendor", collection: COL, serialize: toVendorResource });
    if (lc) return lc;
    const { id, verb } = customMethod(c);
    if (verb !== "restore") return c.notFound();
    const row = await restoreVendor(c.get("deps"), c.get("user"), id);
    return c.json(toVendorResource(row));
  });
