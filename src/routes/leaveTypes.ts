import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { customMethod } from "../http/customMethod";
import { lifecycleVerb } from "../http/lifecycleRoute";
import * as schema from "../db/schema";
import { listLeaveTypes, getLeaveType, createLeaveType, updateLeaveType, deleteLeaveType, restoreLeaveType, purgeLeaveType } from "../services/leaveTypes";
import { toLeaveTypeResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";

const writeSchema = z.object({
  display_name: z.string().min(1).optional(),
  accrual_days_per_year: z.number().min(0).optional(),
  accrual_frequency: z.enum(["monthly", "semi_monthly"]).optional(),
  paid: z.boolean().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  available_during_probation: z.boolean().optional(),
  probation_accrual_days_per_year: z.number().min(0).optional(),
  probation_cap_days: z.number().min(0).nullable().optional(),
  encashable: z.boolean().optional(),
  encashment_cap_days_per_year: z.number().min(0).nullable().optional(),
  min_balance_retained_days: z.number().min(0).optional(),
  carry_forward: z.boolean().optional(),
  carry_forward_cap_days: z.number().min(0).nullable().optional(),
}).strict();

export const leaveTypes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listLeaveTypes(c.get("deps"), c.get("user"), maxPageSize, c.req.query("page_token"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toLeaveTypeResource(r), user, "leave-types", r.code)), next_page_token: nextPageToken });
  })
  .get("/:leave_type_id", async (c) => {
    const row = await getLeaveType(c.get("deps"), c.get("user"), c.req.param("leave_type_id")!);
    return c.json(toLeaveTypeResource(row));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createLeaveType(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(toLeaveTypeResource(row));
  })
  .patch("/:leave_type_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateLeaveType(c.get("deps"), c.get("user"), c.req.param("leave_type_id")!, c.req.valid("json"), c.req.header("If-Match"));
    return c.json(toLeaveTypeResource(row));
  })
  .delete("/:leave_type_id", async (c) => {
    const id = c.req.param("leave_type_id")!;
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") {
      await purgeLeaveType(c.get("deps"), c.get("user"), id, ifMatch);
    } else {
      await deleteLeaveType(c.get("deps"), c.get("user"), id, ifMatch);
    }
    return c.body(null, 204);
  })
  .post("/:leave_type_id", async (c) => {
    const lc = await lifecycleVerb(c, { table: schema.leaveTypes, singular: "leave-type", collection: "leave-types", serialize: toLeaveTypeResource });
    if (lc) return lc;
    const { id, verb } = customMethod(c);
    if (verb !== "restore") return c.notFound();
    const row = await restoreLeaveType(c.get("deps"), c.get("user"), id);
    return c.json(toLeaveTypeResource(row));
  });
