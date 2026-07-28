import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { customMethod } from "../http/customMethod";
import {
  listComplianceRules, getComplianceRule, createComplianceRule, updateComplianceRule,
  deleteComplianceRule, restoreComplianceRule, purgeComplianceRule,
} from "../services/complianceRules";
import { toComplianceRuleResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";

// Recurring compliance obligations (auto-generate compliance-events). NO access checks - middleware gates the
// path by grants (private by default). Standard CRUD + soft-delete/restore; create/update also generate
// occurrences (in the service).
const writeSchema = z
  .object({
    title: z.string().min(1).optional(),
    category: z.string().nullable().optional(),
    frequency: z.enum(["monthly", "quarterly", "annual"]).optional(),
    due_day: z.number().int().min(1).max(31).optional(),
    anchor_month: z.number().int().min(1).max(12).nullable().optional(),
    assignee: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict();

export const complianceRules = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listComplianceRules(c.get("deps"), maxPageSize, c.req.query("page_token"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toComplianceRuleResource(r), user, "compliance-rules", r.code)), next_page_token: nextPageToken });
  })
  .get("/:compliance_rule_id", async (c) => {
    const row = await getComplianceRule(c.get("deps"), c.req.param("compliance_rule_id")!);
    return c.json(withAccess(toComplianceRuleResource(row), c.get("user"), "compliance-rules", row.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createComplianceRule(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(toComplianceRuleResource(row));
  })
  .patch("/:compliance_rule_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateComplianceRule(c.get("deps"), c.get("user"), c.req.param("compliance_rule_id")!, c.req.valid("json"), c.req.header("If-Match"));
    return c.json(toComplianceRuleResource(row));
  })
  .delete("/:compliance_rule_id", async (c) => {
    const id = c.req.param("compliance_rule_id")!;
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") await purgeComplianceRule(c.get("deps"), c.get("user"), id, ifMatch);
    else await deleteComplianceRule(c.get("deps"), c.get("user"), id, ifMatch);
    return c.body(null, 204);
  })
  .post("/:compliance_rule_id", async (c) => {
    const { id, verb } = customMethod(c);
    if (verb !== "restore") return c.notFound();
    const row = await restoreComplianceRule(c.get("deps"), c.get("user"), id);
    return c.json(toComplianceRuleResource(row));
  });
