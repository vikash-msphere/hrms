import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { listSettings, getSetting, upsertSetting, MANAGED_KEYS } from "../services/settings";
import { toSettingResource } from "../http/serialize";
import { clampPageSize } from "../http/pagination";
import { notFound, invalidArgument } from "../lib/errors";
import { parsePayslipTemplate } from "../domain/payslipTemplate";

const writeSchema = z.object({ value: z.unknown().optional(), key: z.string().optional() }).strict();

// Per-key value validation for settings whose shape the money math relies on. Generic settings accept any
// JSON; a few keys must be guarded so a bad config can't silently corrupt payroll. `ctc.basic_pct` pins basic
// at that % of CTC in the top-down split - outside (0, 100] the split produces basic <= 0 or is always
// infeasible, so reject it up front with a clear message rather than failing opaquely at revise time.
function validateSettingValue(key: string, value: unknown) {
  if (key === "ctc" && value && typeof value === "object" && "basic_pct" in value) {
    const p = (value as { basic_pct: unknown }).basic_pct;
    if (typeof p !== "number" || !Number.isFinite(p) || p <= 0 || p > 100) {
      throw invalidArgument("ctc.basic_pct must be a number in (0, 100]");
    }
  }
  if (key === "ctc" && value && typeof value === "object" && "employer_pf_in_ctc" in value) {
    if (typeof (value as { employer_pf_in_ctc: unknown }).employer_pf_in_ctc !== "boolean") throw invalidArgument("ctc.employer_pf_in_ctc must be a boolean");
  }
  if (key === "esign" && value && typeof value === "object" && "enabled" in value) {
    if (typeof (value as { enabled: unknown }).enabled !== "boolean") throw invalidArgument("esign.enabled must be a boolean");
  }
  // The payslip DESIGN (block layout). Validated here so a malformed template is rejected at save time with a
  // message naming the bad block, instead of silently falling back to the stock design at render time.
  if (key === "payslip") {
    try {
      parsePayslipTemplate(value);
    } catch (e) {
      throw invalidArgument(`payslip design: ${(e as Error).message}`);
    }
  }
  // Per-currency display/payout precision: a { [ISO code]: decimals } map. Each entry must be an integer in
  // [0, 4] - money is stored full-precision, so this only sets how many places a currency is shown and paid in.
  if (key === "organization" && value && typeof value === "object" && "currency_decimals" in value) {
    const cd = (value as { currency_decimals: unknown }).currency_decimals;
    if (cd != null) {
      if (typeof cd !== "object" || Array.isArray(cd)) throw invalidArgument("organization.currency_decimals must be an object mapping currency code to decimal places");
      for (const [code, dp] of Object.entries(cd as Record<string, unknown>)) {
        if (typeof dp !== "number" || !Number.isInteger(dp) || dp < 0 || dp > 4) throw invalidArgument(`organization.currency_decimals.${code} must be an integer in [0, 4]`);
      }
    }
  }
}

// Org-wide config. Anyone signed in can read; only config.write can change a setting.
export const settings = new Hono<AppEnv>()
  .get("/", async (c) => {
    const { items, nextPageToken } = await listSettings(c.get("deps"), clampPageSize(Number(c.req.query("max_page_size")) || undefined), c.req.query("page_token"));
    return c.json({ results: items.map(toSettingResource), next_page_token: nextPageToken });
  })
  .get("/:setting_id", async (c) => {
    // Managed keys (bank-formats, payroll-debit) are served only by their own access-gated namespaces, never
    // through the broadly-readable generic settings API.
    if (MANAGED_KEYS.has(c.req.param("setting_id"))) throw notFound("setting not found");
    const row = await getSetting(c.get("deps"), c.req.param("setting_id"));
    return c.json(toSettingResource(row));
  })
  .patch("/:setting_id", zValidator("json", writeSchema), async (c) => {
    if (MANAGED_KEYS.has(c.req.param("setting_id"))) throw notFound("setting not found");
    validateSettingValue(c.req.param("setting_id"), c.req.valid("json").value);
    const row = await upsertSetting(c.get("deps"), c.get("user"), c.req.param("setting_id"), c.req.valid("json").value);
    return c.json(toSettingResource(row));
  });
