import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import {
  listInterviews, getInterview, createInterview, updateInterview,
  deleteInterview, restoreInterview, purgeInterview, completeInterview, cancelInterview,
} from "../services/ats";
import { toInterviewResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";

const COL = "interviews";

const writeSchema = z
  .object({
    application: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    mode: z.string().nullable().optional(),
    scheduled_start_time: z.string().nullable().optional(),
    scheduled_end_time: z.string().nullable().optional(),
    interviewers: z.array(z.string()).nullable().optional(),
    location: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
  })
  .strict();

export const interviews = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listInterviews(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), {
      application: c.req.query("application"),
      status: c.req.query("status"),
      showDeleted: c.req.query("show_deleted") === "true",
    });
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toInterviewResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:interview_id", async (c) => {
    const row = await getInterview(c.get("deps"), c.req.param("interview_id"));
    return c.json(withAccess(toInterviewResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createInterview(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(withAccess(toInterviewResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .patch("/:interview_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateInterview(c.get("deps"), c.get("user"), c.req.param("interview_id"), c.req.valid("json"), c.req.header("If-Match"));
    return c.json(withAccess(toInterviewResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .delete("/:interview_id", async (c) => {
    const id = c.req.param("interview_id");
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") await purgeInterview(c.get("deps"), c.get("user"), id, ifMatch);
    else await deleteInterview(c.get("deps"), c.get("user"), id, ifMatch);
    return c.body(null, 204);
  })
  .post("/:interview_id", async (c) => {
    const { id, verb } = customMethod(c);
    const deps = c.get("deps");
    const user = c.get("user");
    const hint = (row: any) => withAccess(toInterviewResource(row), user, COL, row?.code, c.get("objectGrant"));
    if (verb === "complete") return c.json(hint(await completeInterview(deps, user, id)));
    if (verb === "cancel") return c.json(hint(await cancelInterview(deps, user, id)));
    if (verb === "restore") return c.json(hint(await restoreInterview(deps, user, id)));
    return c.notFound();
  });
