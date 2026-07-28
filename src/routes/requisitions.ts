import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import {
  listRequisitions, getRequisition, createRequisition, updateRequisition,
  deleteRequisition, restoreRequisition, purgeRequisition, applicantCountsByRequisition,
} from "../services/ats";
import { toRequisitionResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";

const COL = "job-requisitions";

const writeSchema = z
  .object({
    title: z.string().nullable().optional(),
    department: z.string().nullable().optional(),
    hiring_manager: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
    employment_type: z.string().nullable().optional(),
    openings: z.number().int().positive().nullable().optional(),
    description: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    opened_date: z.string().nullable().optional(),
    closed_date: z.string().nullable().optional(),
  })
  .strict();

export const requisitions = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listRequisitions(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("status"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    const counts = await applicantCountsByRequisition(c.get("deps"));
    return c.json({ results: items.map((r) => withAccess(toRequisitionResource({ ...r, applicantCount: counts.get(r.uuid) ?? 0 }), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:requisition_id", async (c) => {
    const row = await getRequisition(c.get("deps"), c.req.param("requisition_id"));
    return c.json(withAccess(toRequisitionResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createRequisition(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(withAccess(toRequisitionResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .patch("/:requisition_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateRequisition(c.get("deps"), c.get("user"), c.req.param("requisition_id"), c.req.valid("json"), c.req.header("If-Match"));
    return c.json(withAccess(toRequisitionResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .delete("/:requisition_id", async (c) => {
    const id = c.req.param("requisition_id");
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") await purgeRequisition(c.get("deps"), c.get("user"), id, ifMatch);
    else await deleteRequisition(c.get("deps"), c.get("user"), id, ifMatch);
    return c.body(null, 204);
  })
  .post("/:requisition_id", async (c) => {
    const { id, verb } = customMethod(c);
    const deps = c.get("deps");
    const user = c.get("user");
    const hint = (row: any) => withAccess(toRequisitionResource(row), user, COL, row?.code, c.get("objectGrant"));
    if (verb === "restore") return c.json(hint(await restoreRequisition(deps, user, id)));
    return c.notFound();
  });
