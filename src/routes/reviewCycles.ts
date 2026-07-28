import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv, AppUser } from "../env";
import {
  listReviewCycles, getReviewCycle, createReviewCycle, updateReviewCycle,
  launchReviewCycle, addRevieweesToCycle, setReviewCycleState,
  deleteReviewCycle, restoreReviewCycle, purgeReviewCycle, reviewCountsFor,
} from "../services/reviewCycles";
import { toReviewCycleResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";
import type { Grant } from "../domain/permissions";

const COL = "review-cycles";

const writeSchema = z.object({
  name: z.string().min(1).optional(),
  period_start: z.string().nullable().optional(),
  period_end: z.string().nullable().optional(),
  self_due_date: z.string().nullable().optional(),
  manager_due_date: z.string().nullable().optional(),
}).strict();
const employeesSchema = z.object({ employees: z.array(z.string()).min(1) }).strict();

async function serialize(deps: any, user: AppUser, row: any, grant?: Grant) {
  const counts = await reviewCountsFor(deps, [row.uuid]);
  row._reviewCount = counts.get(row.uuid) ?? 0;
  return withAccess(toReviewCycleResource(row), user, COL, row?.code, grant);
}

export const reviewCycles = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listReviewCycles(c.get("deps"), c.get("user"), maxPageSize, c.req.query("page_token"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    const counts = await reviewCountsFor(c.get("deps"), items.map((r) => r.uuid));
    const results = items.map((r) => {
      (r as any)._reviewCount = counts.get(r.uuid) ?? 0;
      return withAccess(toReviewCycleResource(r), user, COL, r.code);
    });
    return c.json({ results, next_page_token: nextPageToken });
  })
  .get("/:cycle_id", async (c) => {
    const row = await getReviewCycle(c.get("deps"), c.get("user"), c.req.param("cycle_id")!);
    return c.json(await serialize(c.get("deps"), c.get("user"), row, c.get("objectGrant")));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createReviewCycle(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(await serialize(c.get("deps"), c.get("user"), row, c.get("objectGrant")));
  })
  .patch("/:cycle_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateReviewCycle(c.get("deps"), c.get("user"), c.req.param("cycle_id")!, c.req.valid("json"), c.req.header("If-Match"));
    return c.json(await serialize(c.get("deps"), c.get("user"), row, c.get("objectGrant")));
  })
  .delete("/:cycle_id", async (c) => {
    const id = c.req.param("cycle_id")!;
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") await purgeReviewCycle(c.get("deps"), c.get("user"), id, ifMatch);
    else await deleteReviewCycle(c.get("deps"), c.get("user"), id, ifMatch);
    return c.body(null, 204);
  })
  .post("/:cycle_id", async (c) => {
    const { id, verb } = customMethod(c);
    const deps = c.get("deps");
    const user = c.get("user");
    const out = (row: any) => serialize(deps, user, row, c.get("objectGrant")).then((r) => c.json(r));
    if (verb === "launch") {
      const { employees } = employeesSchema.parse(await c.req.json().catch(() => ({})));
      return out(await launchReviewCycle(deps, user, id, employees));
    }
    if (verb === "enroll") {
      const { employees } = employeesSchema.parse(await c.req.json().catch(() => ({})));
      return out(await addRevieweesToCycle(deps, user, id, employees));
    }
    if (verb === "close") return out(await setReviewCycleState(deps, user, id, "CLOSED"));
    if (verb === "reopen") return out(await setReviewCycleState(deps, user, id, "ACTIVE"));
    if (verb === "restore") return out(await restoreReviewCycle(deps, user, id));
    return c.notFound();
  });
