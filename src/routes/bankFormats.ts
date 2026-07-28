import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { customMethod } from "../http/customMethod";
import { listBankFormats, getBankFormat, saveBankFormat, storeBankTemplate, type BankFormat } from "../services/bankFormats";
import { notFound } from "../lib/errors";

// Per-bank bulk-payment Excel formats: column mappings (settings table key `bank-formats`) + the bank's blank
// .xlsx template (R2). Gated to HR + super by the `bank-formats` access rules. The sensitive debit
// account/currency live behind /v1/payroll-debit (super only), never here.
const patchSchema = z
  .object({
    template_name: z.string().nullable().optional(),
    r2_key: z.string().nullable().optional(),
    sheet: z.string().optional(),
    header_row: z.number().int().optional(),
    data_start_row: z.number().int().optional(),
    columns: z.array(z.record(z.any())).optional(),
  })
  .strict();

const toResource = (f: BankFormat & { bank: string }) => ({ path: `bank-formats/${f.bank}`, ...f });

export const bankFormats = new Hono<AppEnv>()
  .get("/", async (c) => c.json({ results: (await listBankFormats(c.get("deps"))).map(toResource), next_page_token: undefined }))
  .get("/:bank", async (c) => {
    const f = await getBankFormat(c.get("deps"), c.req.param("bank"));
    if (!f) throw notFound("bank format not found");
    return c.json(toResource(f));
  })
  .patch("/:bank", zValidator("json", patchSchema), async (c) =>
    c.json(toResource(await saveBankFormat(c.get("deps"), c.get("user"), c.req.param("bank"), c.req.valid("json") as Partial<BankFormat>))),
  )
  // `bank-formats/<bank>:uploadTemplate` stores the bank's blank template .xlsx in R2.
  .post("/:bank", async (c) => {
    const { id: bank, verb } = customMethod(c);
    if (verb === "uploadTemplate") {
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      const out = await storeBankTemplate(c.get("deps"), c.get("user"), bank, bytes, c.req.query("file_name"));
      return c.json(out);
    }
    return c.notFound();
  });
