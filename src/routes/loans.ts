import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import {
  listLoans, getLoan, createLoan, updateLoan,
  approveLoan, rejectLoan, disburseLoan, recordLoanRepayment,
  deleteLoan, restoreLoan, purgeLoan,
} from "../services/loans";
import { toLoanResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";

const COL = "loans";
const writeSchema = z.object({
  employee: z.string().nullable().optional(),
  kind: z.enum(["loan", "advance"]).optional(),
  principal: z.number().optional(),
  installments: z.number().optional(),
  reason: z.string().nullable().optional(),
  start_date: z.string().nullable().optional(),
}).strict();

export const loans = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listLoans(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("employee"), c.req.query("status"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toLoanResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:loan_id", async (c) => {
    const row = await getLoan(c.get("deps"), c.get("user"), c.req.param("loan_id")!);
    return c.json(withAccess(toLoanResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createLoan(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(withAccess(toLoanResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .patch("/:loan_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateLoan(c.get("deps"), c.get("user"), c.req.param("loan_id")!, c.req.valid("json"), c.req.header("If-Match"));
    return c.json(withAccess(toLoanResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .delete("/:loan_id", async (c) => {
    const id = c.req.param("loan_id")!;
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") await purgeLoan(c.get("deps"), c.get("user"), id, ifMatch);
    else await deleteLoan(c.get("deps"), c.get("user"), id, ifMatch);
    return c.body(null, 204);
  })
  .post("/:loan_id", async (c) => {
    const { id, verb } = customMethod(c);
    const deps = c.get("deps");
    const user = c.get("user");
    const hint = (row: { code: string | null } | undefined) => withAccess(toLoanResource(row), user, COL, row?.code, c.get("objectGrant"));
    if (verb === "approve") return c.json(hint(await approveLoan(deps, user, id)));
    if (verb === "reject") return c.json(hint(await rejectLoan(deps, user, id)));
    if (verb === "disburse") return c.json(hint(await disburseLoan(deps, user, id)));
    if (verb === "recordRepayment") {
      const { amount } = z.object({ amount: z.number() }).strict().parse(await c.req.json().catch(() => ({})));
      return c.json(hint(await recordLoanRepayment(deps, user, id, amount)));
    }
    if (verb === "restore") return c.json(hint((await restoreLoan(deps, user, id)) as unknown as { code: string | null }));
    return c.notFound();
  });
