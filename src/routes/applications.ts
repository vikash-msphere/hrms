import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import {
  listApplications, getApplication, createApplication, updateApplication,
  deleteApplication, restoreApplication, purgeApplication, advanceApplication, rejectApplication,
} from "../services/ats";
import { toApplicationResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";

const COL = "applications";

const writeSchema = z
  .object({
    candidate: z.string().nullable().optional(),
    requisition: z.string().nullable().optional(),
    stage: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    referral: z.string().nullable().optional(),
    applied_date: z.string().nullable().optional(),
  })
  .strict();

export const applications = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listApplications(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), {
      requisition: c.req.query("requisition"),
      candidate: c.req.query("candidate"),
      stage: c.req.query("stage"),
      status: c.req.query("status"),
      showDeleted: c.req.query("show_deleted") === "true",
    });
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toApplicationResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:application_id", async (c) => {
    const row = await getApplication(c.get("deps"), c.req.param("application_id"));
    return c.json(withAccess(toApplicationResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createApplication(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(withAccess(toApplicationResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .patch("/:application_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateApplication(c.get("deps"), c.get("user"), c.req.param("application_id"), c.req.valid("json"), c.req.header("If-Match"));
    return c.json(withAccess(toApplicationResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .delete("/:application_id", async (c) => {
    const id = c.req.param("application_id");
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") await purgeApplication(c.get("deps"), c.get("user"), id, ifMatch);
    else await deleteApplication(c.get("deps"), c.get("user"), id, ifMatch);
    return c.body(null, 204);
  })
  .post("/:application_id", async (c) => {
    const { id, verb } = customMethod(c);
    const deps = c.get("deps");
    const user = c.get("user");
    const hint = (row: any) => withAccess(toApplicationResource(row), user, COL, row?.code, c.get("objectGrant"));
    const body = await c.req.json().catch(() => ({}) as any);
    if (verb === "advance") return c.json(hint(await advanceApplication(deps, user, id, body?.stage)));
    if (verb === "reject") return c.json(hint(await rejectApplication(deps, user, id, body?.reason)));
    if (verb === "restore") return c.json(hint(await restoreApplication(deps, user, id)));
    return c.notFound();
  });
