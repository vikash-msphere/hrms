import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { listBenefitEnrollments, getBenefitEnrollment, createBenefitEnrollment, updateBenefitEnrollment, deleteBenefitEnrollment, restoreBenefitEnrollment, purgeBenefitEnrollment } from "../services/benefitEnrollments";
import { toBenefitEnrollmentResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";

const COL = "benefit-enrollments";
const writeSchema = z.object({
  employee: z.string().nullable().optional(),
  plan: z.string().nullable().optional(),
  status: z.enum(["enrolled", "waived"]).optional(),
  effective_date: z.string().nullable().optional(),
  dependents: z.array(z.string()).optional(),
}).strict();

export const benefitEnrollments = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listBenefitEnrollments(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("employee"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toBenefitEnrollmentResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:enrollment_id", async (c) => {
    const row = await getBenefitEnrollment(c.get("deps"), c.get("user"), c.req.param("enrollment_id")!);
    return c.json(withAccess(toBenefitEnrollmentResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createBenefitEnrollment(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(withAccess(toBenefitEnrollmentResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .patch("/:enrollment_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateBenefitEnrollment(c.get("deps"), c.get("user"), c.req.param("enrollment_id")!, c.req.valid("json"), c.req.header("If-Match"));
    return c.json(withAccess(toBenefitEnrollmentResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .delete("/:enrollment_id", async (c) => {
    const id = c.req.param("enrollment_id")!;
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") await purgeBenefitEnrollment(c.get("deps"), c.get("user"), id, ifMatch);
    else await deleteBenefitEnrollment(c.get("deps"), c.get("user"), id, ifMatch);
    return c.body(null, 204);
  })
  .post("/:enrollment_id", async (c) => {
    const { id, verb } = customMethod(c);
    if (verb !== "restore") return c.notFound();
    const row = await restoreBenefitEnrollment(c.get("deps"), c.get("user"), id);
    return c.json(withAccess(toBenefitEnrollmentResource(row), c.get("user"), COL, row?.code as string | null | undefined, c.get("objectGrant")));
  });
