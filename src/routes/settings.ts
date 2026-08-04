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
  // Asset tag printing config. Guarded lightly: a malformed category_codes map or digits value would make
  // every generated tag wrong (and PATCHed onto real assets), so reject the shapes the printer can't use.
  if (key === "asset-tags" && value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if ("digits" in v && v.digits != null && (typeof v.digits !== "number" || !Number.isInteger(v.digits) || v.digits < 1 || v.digits > 6)) {
      throw invalidArgument("asset-tags.digits must be an integer in [1, 6]");
    }
    if ("category_codes" in v && v.category_codes != null) {
      if (typeof v.category_codes !== "object" || Array.isArray(v.category_codes)) throw invalidArgument("asset-tags.category_codes must be an object mapping category to a short code");
      for (const [cat, code] of Object.entries(v.category_codes as Record<string, unknown>)) {
        if (typeof code !== "string" || !code.trim() || code.trim().length > 6) throw invalidArgument(`asset-tags.category_codes.${cat} must be a 1-6 character code`);
      }
    }
    if ("code_type" in v && v.code_type != null && v.code_type !== "qr" && v.code_type !== "code128") {
      throw invalidArgument('asset-tags.code_type must be "qr" or "code128"');
    }
    if ("label" in v && v.label != null && typeof v.label === "object") {
      const footer = (v.label as Record<string, unknown>).footer;
      if (footer != null && (typeof footer !== "string" || footer.length > 120)) throw invalidArgument("asset-tags.label.footer must be a string of at most 120 characters");
    }
    // The public lost-and-found page: enabling it exposes org name + tag + contact to anyone with the
    // sticker's URL, so keep its shape strict.
    if ("found_page" in v && v.found_page != null) {
      const fp = v.found_page as Record<string, unknown>;
      if (typeof fp !== "object" || Array.isArray(fp)) throw invalidArgument("asset-tags.found_page must be an object");
      if (fp.enabled != null && typeof fp.enabled !== "boolean") throw invalidArgument("asset-tags.found_page.enabled must be a boolean");
      if (fp.show_name != null && typeof fp.show_name !== "boolean") throw invalidArgument("asset-tags.found_page.show_name must be a boolean");
      if (fp.contact != null && (typeof fp.contact !== "string" || fp.contact.length > 200)) throw invalidArgument("asset-tags.found_page.contact must be a string of at most 200 characters");
    }
    if ("custom_formats" in v && v.custom_formats != null) {
      if (!Array.isArray(v.custom_formats)) throw invalidArgument("asset-tags.custom_formats must be an array");
      for (const f of v.custom_formats as unknown[]) {
        const fmt = f as Record<string, unknown>;
        if (!fmt || typeof fmt !== "object" || typeof fmt.id !== "string" || !fmt.id.trim()) throw invalidArgument("asset-tags.custom_formats entries need a string id");
        for (const k of ["cols", "rows", "w", "h", "marginX", "marginY", "gapX", "gapY"]) {
          if (typeof fmt[k] !== "number" || !Number.isFinite(fmt[k] as number) || (fmt[k] as number) < 0) throw invalidArgument(`asset-tags.custom_formats.${fmt.id}.${k} must be a non-negative number`);
        }
        if ((fmt.cols as number) < 1 || (fmt.rows as number) < 1 || (fmt.w as number) <= 0 || (fmt.h as number) <= 0) throw invalidArgument(`asset-tags.custom_formats.${fmt.id} needs cols/rows >= 1 and positive label w/h`);
      }
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
