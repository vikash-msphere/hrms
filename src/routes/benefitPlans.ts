import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { listBenefitPlans, getBenefitPlan, createBenefitPlan, updateBenefitPlan, deleteBenefitPlan, restoreBenefitPlan, purgeBenefitPlan } from "../services/benefitPlans";
import { toBenefitPlanResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";

const COL = "benefit-plans";
const writeSchema = z.object({
  name: z.string().min(1).optional(),
  category: z.enum(["health", "dental", "vision", "life", "disability", "retirement", "other"]).optional(),
  description: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  employee_cost: z.number().optional(),
  employer_cost: z.number().optional(),
  cost_period: z.enum(["month", "year"]).optional(),
  allows_dependents: z.boolean().optional(),
  auto_enroll: z.boolean().optional(),
}).strict();

export const benefitPlans = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listBenefitPlans(c.get("deps"), c.get("user"), maxPageSize, c.req.query("page_token"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toBenefitPlanResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:plan_id", async (c) => {
    const row = await getBenefitPlan(c.get("deps"), c.get("user"), c.req.param("plan_id")!);
    return c.json(withAccess(toBenefitPlanResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createBenefitPlan(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(withAccess(toBenefitPlanResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .patch("/:plan_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateBenefitPlan(c.get("deps"), c.get("user"), c.req.param("plan_id")!, c.req.valid("json"), c.req.header("If-Match"));
    return c.json(withAccess(toBenefitPlanResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .delete("/:plan_id", async (c) => {
    const id = c.req.param("plan_id")!;
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") await purgeBenefitPlan(c.get("deps"), c.get("user"), id, ifMatch);
    else await deleteBenefitPlan(c.get("deps"), c.get("user"), id, ifMatch);
    return c.body(null, 204);
  })
  .post("/:plan_id", async (c) => {
    const { id, verb } = customMethod(c);
    if (verb !== "restore") return c.notFound();
    const row = await restoreBenefitPlan(c.get("deps"), c.get("user"), id);
    return c.json(withAccess(toBenefitPlanResource(row), c.get("user"), COL, row?.code as string | null | undefined, c.get("objectGrant")));
  });
