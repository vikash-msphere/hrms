import { z } from "zod";
import { Hono } from "hono";
import * as schema from "../db/schema";
import type { AppEnv } from "../env";
import { collectionRoutes } from "../http/collectionRoute";
import { jsonBody } from "../http/jsonRequest";
import { nonNegativeMoney } from "../http/moneyField";
import { importStatement, reconcileCardStatement, setCardTransactionMatch } from "../services/cardStatements";
import { toCardTransactionResource } from "../http/serialize";

// Corporate card charges, imported from a statement and matched to the claims that account for them.
//
// NO CREATE and no DELETE: a row here is a fact the card issuer reported, so it arrives through `:import` and
// not through a POST somebody could invent one with. The table has no `delete_time`, so the factory mounts no
// DELETE either - a charge that happened cannot be un-happened, and a statement re-import is idempotent
// rather than destructive.
//
// The one editable thing is the MATCH, because the matcher is a rule and a person has to be able to overrule
// it. That is a PATCH of `expense` alone.
const updateSchema = z.object({ expense: z.string().nullable().optional() }).strict();

const transactions = collectionRoutes({
  table: schema.cardTransactions,
  collection: "card-transactions",
  auditName: "card_transaction",
  notFound: "card transaction not found",
  param: "card_transaction_id",
  updateSchema,
  serialize: toCardTransactionResource,
  // Newest charge first: a statement is read from the end.
  sort: (a, b) => +new Date(b.postedOn) - +new Date(a.postedOn),
  overrides: {
    update: (deps, actor, id, patch) => setCardTransactionMatch(deps, actor, id, (patch as { expense?: string | null }).expense ?? null),
  },
});

const importSchema = z.object({
  rows: z.array(z.object({
    posted_on: z.string(),
    amount: nonNegativeMoney(),
    merchant: z.string().nullable().optional(),
    reference: z.string().nullable().optional(),
    card_last4: z.string().nullable().optional(),
    employee: z.string().nullable().optional(),
  }).strict()).min(1),
}).strict();

// `:import` takes rows already parsed out of the issuer's file - the SPA reads the CSV. A per-issuer parser
// belongs beside services/bankFormats.ts, which holds exactly this kind of column mapping for the outbound
// direction; writing one with no real statement to test against would be inventing a format.
//
// `:reconcile` is separate from the import on purpose: importing is a fact, matching is a judgement, and
// somebody re-running the matcher after filing the missing claims should not have to re-upload anything.
export const cardTransactions = new Hono<AppEnv>()
  .post("/:import", async (c) => {
    const parsed = importSchema.safeParse(await jsonBody(c));
    if (!parsed.success) return c.json({ error: { message: "invalid statement body" } }, 400);
    return c.json(await importStatement(c.get("deps"), c.get("user"), parsed.data.rows));
  })
  .post("/:reconcile", async (c) => c.json(await reconcileCardStatement(c.get("deps"), c.get("user"))))
  .route("/", transactions);
