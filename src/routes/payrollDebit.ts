import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { listPayrollDebit, getPayrollDebitFor, savePayrollDebitFor, type DebitView } from "../services/bankFormats";
import { notFound } from "../lib/errors";

// The employer's bulk-payment debit account + currency, per bank (settings table key `payroll-debit`). This
// namespace has NO grant in any role, so it is private-by-default: only super_admin's `**` reaches it. The
// account number is encrypted at rest and returned only masked (last 4) - like employee bank accounts.
const patchSchema = z.object({ debit_account_number: z.string().optional(), currency_code: z.string().optional() }).strict();

const toResource = (e: DebitView) => ({ path: `payroll-debit-accounts/${e.bank}`, ...e });

export const payrollDebit = new Hono<AppEnv>()
  .get("/", async (c) => c.json({ results: (await listPayrollDebit(c.get("deps"))).map(toResource), next_page_token: undefined }))
  .get("/:bank", async (c) => {
    const e = await getPayrollDebitFor(c.get("deps"), c.req.param("bank"));
    if (!e) throw notFound("debit config not found");
    return c.json(toResource(e));
  })
  .patch("/:bank", zValidator("json", patchSchema), async (c) =>
    c.json(toResource(await savePayrollDebitFor(c.get("deps"), c.get("user"), c.req.param("bank"), c.req.valid("json")))),
  );
