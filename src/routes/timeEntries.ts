import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import {
  listTimeEntries, getTimeEntry, createTimeEntry, updateTimeEntry,
  submitTimeEntry, approveTimeEntry, rejectTimeEntry,
  deleteTimeEntry, restoreTimeEntry, purgeTimeEntry,
} from "../services/timeEntries";
import { toTimeEntryResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";

const COL = "time-entries";
const writeSchema = z.object({
  employee: z.string().nullable().optional(),
  project: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
  hours: z.number().optional(),
  description: z.string().nullable().optional(),
  billable: z.boolean().optional(),
}).strict();

export const timeEntries = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listTimeEntries(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("employee"), c.req.query("from"), c.req.query("to"), c.req.query("status"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toTimeEntryResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:entry_id", async (c) => {
    const row = await getTimeEntry(c.get("deps"), c.get("user"), c.req.param("entry_id")!);
    return c.json(withAccess(toTimeEntryResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createTimeEntry(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(withAccess(toTimeEntryResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .patch("/:entry_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateTimeEntry(c.get("deps"), c.get("user"), c.req.param("entry_id")!, c.req.valid("json"), c.req.header("If-Match"));
    return c.json(withAccess(toTimeEntryResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .delete("/:entry_id", async (c) => {
    const id = c.req.param("entry_id")!;
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") await purgeTimeEntry(c.get("deps"), c.get("user"), id, ifMatch);
    else await deleteTimeEntry(c.get("deps"), c.get("user"), id, ifMatch);
    return c.body(null, 204);
  })
  .post("/:entry_id", async (c) => {
    const { id, verb } = customMethod(c);
    const deps = c.get("deps");
    const user = c.get("user");
    const hint = (row: { code: string | null } | undefined) => withAccess(toTimeEntryResource(row), user, COL, row?.code, c.get("objectGrant"));
    if (verb === "submit") return c.json(hint(await submitTimeEntry(deps, user, id)));
    if (verb === "approve") return c.json(hint(await approveTimeEntry(deps, user, id)));
    if (verb === "reject") return c.json(hint(await rejectTimeEntry(deps, user, id)));
    if (verb === "restore") return c.json(hint((await restoreTimeEntry(deps, user, id)) as unknown as { code: string | null }));
    return c.notFound();
  });
