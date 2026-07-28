import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { customMethod } from "../http/customMethod";
import {
  listComplianceEvents, getComplianceEvent, createComplianceEvent, updateComplianceEvent,
  deleteComplianceEvent, restoreComplianceEvent, purgeComplianceEvent,
} from "../services/complianceEvents";
import { toComplianceEventResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";

// Statutory compliance calendar. NO access checks here - the middleware gates the path by grants (private by
// default; super-only until access is granted via the ACL). Standard CRUD + soft-delete/restore.
const writeSchema = z
  .object({
    title: z.string().min(1).optional(),
    category: z.string().nullable().optional(),
    frequency: z.enum(["one_time", "monthly", "quarterly", "annual"]).optional(),
    due_date: z.string().optional(),
    period_label: z.string().nullable().optional(),
    status: z.enum(["pending", "filed", "waived"]).optional(),
    filed_date: z.string().nullable().optional(),
    reference: z.string().nullable().optional(),
    assignee: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
  })
  .strict();

export const complianceEvents = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listComplianceEvents(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toComplianceEventResource(r), user, "compliance-events", r.code)), next_page_token: nextPageToken });
  })
  .get("/:compliance_event_id", async (c) => {
    const row = await getComplianceEvent(c.get("deps"), c.req.param("compliance_event_id")!);
    return c.json(withAccess(toComplianceEventResource(row), c.get("user"), "compliance-events", row.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createComplianceEvent(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(toComplianceEventResource(row));
  })
  .patch("/:compliance_event_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateComplianceEvent(c.get("deps"), c.get("user"), c.req.param("compliance_event_id")!, c.req.valid("json"), c.req.header("If-Match"));
    return c.json(toComplianceEventResource(row));
  })
  .delete("/:compliance_event_id", async (c) => {
    const id = c.req.param("compliance_event_id")!;
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") await purgeComplianceEvent(c.get("deps"), c.get("user"), id, ifMatch);
    else await deleteComplianceEvent(c.get("deps"), c.get("user"), id, ifMatch);
    return c.body(null, 204);
  })
  .post("/:compliance_event_id", async (c) => {
    const { id, verb } = customMethod(c);
    if (verb !== "restore") return c.notFound();
    const row = await restoreComplianceEvent(c.get("deps"), c.get("user"), id);
    return c.json(toComplianceEventResource(row));
  });
