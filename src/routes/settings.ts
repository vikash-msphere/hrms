import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { listSettings, getSetting, upsertSetting, MANAGED_KEYS } from "../services/settings";
import { toSettingResource } from "../http/serialize";
import { clampPageSize } from "../http/pagination";
import { notFound, invalidArgument } from "../lib/errors";
import { parsePayslipTemplate } from "../domain/payslipTemplate";
import { DOCUMENT_KINDS } from "../services/letterheads";
import { validateStateMachine, type StateMachine } from "../domain/stateMachines";
import { assertPublicHttpsUrl } from "../lib/urlGuard";
import { validateAtsConfig, orphanedStages, type AtsStage } from "../domain/ats";
import { stagesInUse } from "../services/ats";
import { getFieldDefs, identityValueCounts, purgeIdentityFields } from "../services/identityDetails";

const writeSchema = z.object({ value: z.unknown().optional(), key: z.string().optional() }).strict();

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
// The key an identity field gets when none was given, exactly as the editor derives it (web/src/pages/Settings).
const slugKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const isIntIn = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

// `ctc.basic_pct` pins basic at that % of CTC in the top-down split - outside (0, 100] the split produces
// basic <= 0 or is always infeasible, so reject it up front with a clear message rather than failing
// opaquely at revise time.
function validateCtc(value: unknown) {
  if (!isObj(value) || !("basic_pct" in value)) return;
  const p = value.basic_pct;
  if (typeof p !== "number" || !Number.isFinite(p) || p <= 0 || p > 100) throw invalidArgument("ctc.basic_pct must be a number in (0, 100]");
}

/**
 * `esign`: the master switch, and per-driver vendor config.
 *
 * THE URLS ARE THE PART THAT MATTERS, and they were the part not looked at. A driver's `api_base` is where the
 * app sends the document to be signed - carrying `x-client-id` / `x-client-secret`, i.e. the vendor credentials
 * out of env (services/esign/cashfree.ts#authHeaders). Left as free text, whoever may write this key could
 * point it at a host they control and be handed those secrets, or at an internal address the Worker can reach:
 * an SSRF primitive and a secret-exfiltration path out of a settings capability.
 *
 * `assertPublicHttpsUrl` is the guard the rest of the app already applies to every URL a person can nominate -
 * the workflow webhook action, a push subscription endpoint, and each hop of the vendor's own `signed_doc_url`.
 * The one URL that is CONFIGURED rather than vendor-supplied, and the only one that travels beside the secret,
 * had no check at all. `redirect_url` is where the SIGNER is sent when they are done, so it is judged the same
 * way rather than being left as an open redirect off the org's own domain.
 *
 * Both are validated for EVERY driver, present or future: the keys are the provider registry's own
 * (`configFields`), and a new driver that adds a URL field should not have to remember this file.
 */
const URL_CONFIG_KEYS = ["api_base", "redirect_url", "webhook_url", "callback_url"];
function validateEsign(value: unknown) {
  if (!isObj(value)) return;
  if ("enabled" in value && typeof value.enabled !== "boolean") throw invalidArgument("esign.enabled must be a boolean");
  if (value.providers == null) return;
  if (!isObj(value.providers)) throw invalidArgument("esign.providers must be an object keyed by driver id");
  for (const [driver, cfg] of Object.entries(value.providers)) {
    if (!isObj(cfg)) throw invalidArgument(`esign.providers.${driver} must be an object`);
    for (const key of URL_CONFIG_KEYS) {
      const raw = cfg[key];
      if (raw == null || raw === "") continue;
      if (typeof raw !== "string") throw invalidArgument(`esign.providers.${driver}.${key} must be a string`);
      try {
        assertPublicHttpsUrl(raw.trim());
      } catch {
        throw invalidArgument(`esign.providers.${driver}.${key} must be an https URL on the default port and on a public host (the app sends vendor credentials to it)`);
      }
    }
  }
}

/**
 * `gratuity`: what the full & final settlement pays a leaver, and the last money-shaping key with no validator.
 *
 * Every field is written straight from a number input, and `domain/settlement.ts#gratuityAmount` guards exactly
 * one of them (`divisor`). The other two fail silently in opposite directions: `days_per_year: 0` pays every
 * leaver nothing, and `min_years: 0` pays statutory gratuity to somebody who left in their first week. Both are
 * one emptied field away (`Number("")` is 0), both land on the one payout there is no later run to correct, and
 * neither says anything at the time - which is the failure shape `validateTaxConfig` and
 * `validateProfessionalTax` were added for, one notch up.
 *
 * Only checked when the policy is ON: a disabled gratuity pays nothing whatever the numbers say, and refusing
 * to store a blank form somebody has switched off would be noise.
 */
function validateGratuity(value: unknown) {
  if (!isObj(value)) throw invalidArgument("gratuity must be an object");
  if (value.enabled != null && typeof value.enabled !== "boolean") throw invalidArgument("gratuity.enabled must be a boolean");
  if (value.enabled === false) return;
  const req = (k: string, min: number, what: string) => {
    if (value[k] == null) return; // absent = the default stands (the merge is shallow, and these are flat)
    if (typeof value[k] !== "number" || !Number.isFinite(value[k] as number) || (value[k] as number) < min) {
      throw invalidArgument(`gratuity.${k} must be ${what}`);
    }
  };
  req("min_years", 1, "a number of at least 1 - a qualifying service of 0 pays statutory gratuity to someone who left in their first week");
  req("days_per_year", 0.5, "a number of at least 0.5 - 0 days per year pays every leaver nothing, without saying so");
  req("divisor", 1, "a number of at least 1 (the statutory monthly divisor is 26)");
  req("exemption_cap", 0, "a non-negative number");
}

// The payslip DESIGN (block layout). Validated here so a malformed template is rejected at save time with a
// message naming the bad block, instead of silently falling back to the stock design at render time.
function validatePayslip(value: unknown) {
  try {
    parsePayslipTemplate(value);
  } catch (e) {
    throw invalidArgument(`payslip design: ${(e as Error).message}`);
  }
}

// The public lost-and-found page: enabling it exposes org name + tag + contact to anyone with the sticker's
// URL, so keep its shape strict.
function validateTagFoundPage(fp: unknown) {
  if (!isObj(fp)) throw invalidArgument("asset-tags.found_page must be an object");
  if (fp.enabled != null && typeof fp.enabled !== "boolean") throw invalidArgument("asset-tags.found_page.enabled must be a boolean");
  if (fp.show_name != null && typeof fp.show_name !== "boolean") throw invalidArgument("asset-tags.found_page.show_name must be a boolean");
  if (fp.contact != null && (typeof fp.contact !== "string" || fp.contact.length > 200)) throw invalidArgument("asset-tags.found_page.contact must be a string of at most 200 characters");
}

// Every geometry field of a custom label sheet, in mm. All are required and non-negative.
const TAG_FORMAT_DIMENSIONS = ["cols", "rows", "w", "h", "marginX", "marginY", "gapX", "gapY"] as const;

function validateTagCustomFormats(formats: unknown) {
  if (!Array.isArray(formats)) throw invalidArgument("asset-tags.custom_formats must be an array");
  for (const f of formats as unknown[]) {
    const fmt = f as Record<string, unknown>;
    if (!isObj(fmt) || typeof fmt.id !== "string" || !fmt.id.trim()) throw invalidArgument("asset-tags.custom_formats entries need a string id");
    for (const k of TAG_FORMAT_DIMENSIONS) {
      if (typeof fmt[k] !== "number" || !Number.isFinite(fmt[k] as number) || (fmt[k] as number) < 0) throw invalidArgument(`asset-tags.custom_formats.${fmt.id}.${k} must be a non-negative number`);
    }
    if ((fmt.cols as number) < 1 || (fmt.rows as number) < 1 || (fmt.w as number) <= 0 || (fmt.h as number) <= 0) throw invalidArgument(`asset-tags.custom_formats.${fmt.id} needs cols/rows >= 1 and positive label w/h`);
  }
}

// Asset tag printing config. Guarded lightly: a malformed digits value would make every allocated tag wrong
// (and stamped onto real assets), so reject the shapes the allocator and printer can't use. The code inside a
// tag comes from the asset's category row (asset-categories), not from here.
function validateAssetTags(value: unknown) {
  if (!isObj(value)) return;
  if (value.digits != null && !isIntIn(value.digits, 1, 6)) throw invalidArgument("asset-tags.digits must be an integer in [1, 6]");
  if (value.code_type != null && value.code_type !== "qr" && value.code_type !== "code128") throw invalidArgument('asset-tags.code_type must be "qr" or "code128"');
  if (isObj(value.label)) {
    const footer = value.label.footer;
    if (footer != null && (typeof footer !== "string" || footer.length > 120)) throw invalidArgument("asset-tags.label.footer must be a string of at most 120 characters");
  }
  if (value.found_page != null) validateTagFoundPage(value.found_page);
  if (value.custom_formats != null) validateTagCustomFormats(value.custom_formats);
  if (value.custody != null) validateTagCustody(value.custody);
}

// Custody enforcement: whether a scan is required to count an asset into stock / to confirm receipt, and how
// long an unconfirmed asset waits before the nightly tick starts chasing it. A garbage window here would
// either spam every holder daily or silence the chase-up entirely, so the numbers are bounded.
function validateTagCustody(value: unknown) {
  if (!isObj(value)) throw invalidArgument("asset-tags.custody must be an object");
  for (const k of ["stock_scan_required", "ack_required", "manual_ack_allowed"] as const) {
    if (value[k] != null && typeof value[k] !== "boolean") throw invalidArgument(`asset-tags.custody.${k} must be a boolean`);
  }
  if (value.ack_reminder_days != null && !isIntIn(value.ack_reminder_days, 1, 90)) throw invalidArgument("asset-tags.custody.ack_reminder_days must be an integer in [1, 90]");
  if (value.verify_stale_days != null && !isIntIn(value.verify_stale_days, 7, 3650)) throw invalidArgument("asset-tags.custody.verify_stale_days must be an integer in [7, 3650]");
}

// The org's attendance schedule (settings/attendance) - and therefore the org's CALENDAR DAY, the LOP divisor,
// the wage LOP is docked from and the proration basis. It belongs in this table for exactly the reason the
// table exists, and it was the one such key with no validator while its timezone field is free text in the UI
// (web/src/pages/Settings.tsx). That left two failure modes, and the quiet one is the worse of them:
//
//   - A value ICU REFUSES - "Asia/Bombay", "GMT+5:30", "UTC+5:30", the shapes somebody reaches for when
//     "Asia/Kolkata" is not to hand - makes `Intl.DateTimeFormat` THROW inside `localDay`. Not a wrong day: an
//     exception, out of the attendance clock, the payroll build, and every nightly cron subtask that asks for
//     today. It is stored, so it is a 500 that persists until somebody edits the row back by hand.
//   - A value ICU ACCEPTS that is not a zone - "EST", "IST": fixed offsets carrying no daylight-saving rules -
//     errors nowhere. The org's day is silently wrong half the year, and a negative fixed offset also puts the
//     deployment west of UTC, which is the side every date-only comparison in the app is thinner on (see
//     domain/attendance.ts#utcDay).
//
// So a zone must be a real IANA NAME - "UTC", or Area/Location - and must resolve here. The rest of the blob is
// checked because it is arithmetic that fails silently: a `lop_basis` typo picks the other divisor without
// complaint, a non-numeric `full_day_minutes` makes every comparison in `lopDayUnits` false so nothing is ever
// docked, and a `work_days` that is not an array is a TypeError inside the pure day walk.
const LOP_BASES = ["working_days", "days_30"] as const;
const LOP_WAGE_BASES = ["gross", "basic"] as const;
const PRORATION_BASES = ["calendar_days", "working_days"] as const;

function validateTimezone(tz: unknown) {
  if (typeof tz !== "string" || !tz.trim()) throw invalidArgument("attendance.timezone must be a non-empty IANA timezone name, e.g. Asia/Kolkata");
  const name = tz.trim();
  // Shape first, because it is the half ICU will not refuse for us: an abbreviation ("IST", "EST") and a bare
  // "GMT" resolve to a FIXED offset with no daylight-saving rules, which is not what any of the callers mean
  // by "the org's timezone". "UTC" is the one legitimate slash-free zone.
  if (name !== "UTC" && !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){1,2}$/.test(name)) {
    throw invalidArgument(`attendance.timezone must be an IANA zone name like Asia/Kolkata - "${name}" is an abbreviation or a fixed offset, which carries no daylight-saving rules`);
  }
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: name, year: "numeric" }).format(new Date(0));
  } catch {
    throw invalidArgument(`attendance.timezone "${name}" is not a timezone this runtime knows (it must be a current IANA name, e.g. Asia/Kolkata rather than Asia/Bombay)`);
  }
}

function validateAttendance(value: unknown) {
  if (!isObj(value)) return;
  if (value.timezone != null) validateTimezone(value.timezone);
  if (value.work_days != null && (!Array.isArray(value.work_days) || value.work_days.some((d) => !isIntIn(d, 0, 6)))) {
    throw invalidArgument("attendance.work_days must be an array of weekday numbers (0=Sun..6=Sat)");
  }
  for (const k of ["full_day_minutes", "half_day_minutes"] as const) {
    if (value[k] != null && !isIntIn(value[k], 0, 1440)) throw invalidArgument(`attendance.${k} must be a whole number of minutes in [0, 1440]`);
  }
  // A half day worth more than a full one inverts the ladder in `lopDayUnits`: the 0.5 branch becomes
  // unreachable and every short day is charged as a whole absence.
  if (typeof value.full_day_minutes === "number" && typeof value.half_day_minutes === "number" && value.half_day_minutes > value.full_day_minutes) {
    throw invalidArgument("attendance.half_day_minutes must not exceed attendance.full_day_minutes");
  }
  if (value.lop_enabled != null && typeof value.lop_enabled !== "boolean") throw invalidArgument("attendance.lop_enabled must be a boolean");
  for (const [k, allowed] of [["lop_basis", LOP_BASES], ["lop_wage_basis", LOP_WAGE_BASES], ["proration_basis", PRORATION_BASES]] as const) {
    const v = value[k];
    if (v != null && (typeof v !== "string" || !(allowed as readonly string[]).includes(v))) {
      throw invalidArgument(`attendance.${k} must be one of: ${allowed.join(", ")}`);
    }
  }
}

// Per-currency display/payout precision: a { [ISO code]: decimals } map. Each entry must be an integer in
// [0, 4] - money is stored full-precision, so this only sets how many places a currency is shown and paid in.
// `document_logos` maps a generated-document kind to the letterhead it prints on; an unknown kind would be a
// silently ignored choice, so the vocabulary is closed here.
// The org's images live INSIDE the `organization` blob as data URLs, and that blob is read on essentially
// every request (services/settings.ts#MAX_SETTING_BYTES says why that matters). The SPA caps what it will
// upload - 256 KB per logo, 64 KB for the favicon (web/src/pages/Settings.tsx) - and until these checks the
// server did not, so the limit held only for people using the form. Compared against the length of the data
// URL rather than the file: base64 is 4 bytes per 3, plus the `data:image/...;base64,` prefix.
const dataUrlCap = (fileBytes: number) => Math.ceil(fileBytes / 3) * 4 + 64;
const ORG_IMAGE_CAPS: Record<string, number> = {
  logo: dataUrlCap(256 * 1024), logo_dark: dataUrlCap(256 * 1024),
  wordmark: dataUrlCap(256 * 1024), wordmark_dark: dataUrlCap(256 * 1024),
  favicon: dataUrlCap(64 * 1024),
};

function validateOrganization(value: unknown) {
  if (!isObj(value)) return;
  for (const [field, cap] of Object.entries(ORG_IMAGE_CAPS)) {
    const v = value[field];
    if (v == null) continue;
    if (typeof v !== "string") throw invalidArgument(`organization.${field} must be an image data URL`);
    if (v.length > cap) throw invalidArgument(`organization.${field} is larger than the ${Math.round(cap / 1024)} KB limit`);
  }
  if (value.document_logos != null) {
    const dl = value.document_logos;
    if (!isObj(dl)) throw invalidArgument("organization.document_logos must be an object mapping a document kind to a letterhead");
    for (const [kind, ref] of Object.entries(dl)) {
      if (!(DOCUMENT_KINDS as readonly string[]).includes(kind)) throw invalidArgument(`organization.document_logos.${kind} is not a document kind (${DOCUMENT_KINDS.join(", ")})`);
      if (typeof ref !== "string" || ref.length > 80) throw invalidArgument(`organization.document_logos.${kind} must be a letterhead ref of at most 80 characters`);
    }
  }
  // `banks` is the org's bank ENUM: it is what an employee's `bank_name` is checked against
  // (services/bankDetails.ts) and what a bank format is keyed by, and services/bankFile.ts decides a payment
  // line's intra/inter transaction type by matching the two. That match is case-insensitive, so two entries
  // differing only in case would make "which bank is this" ambiguous for every payment - hence the uniqueness
  // check alongside the shape one. Placed above the `currency_decimals` early return, or it never runs for an
  // org that has not set that key.
  if (value.banks != null) {
    const banks = value.banks;
    if (!Array.isArray(banks)) throw invalidArgument("organization.banks must be an array of bank names");
    const seen = new Set<string>();
    for (const b of banks) {
      if (typeof b !== "string" || !b.trim()) throw invalidArgument("organization.banks entries must be non-empty strings");
      if (b.length > 80) throw invalidArgument(`organization.banks entry "${b.slice(0, 20)}…" is longer than 80 characters`);
      const key = b.trim().toLowerCase();
      if (seen.has(key)) throw invalidArgument(`organization.banks lists "${b.trim()}" twice (names are compared case-insensitively)`);
      seen.add(key);
    }
  }
  if (value.currency_decimals == null) return;
  const cd = value.currency_decimals;
  if (!isObj(cd)) throw invalidArgument("organization.currency_decimals must be an object mapping currency code to decimal places");
  for (const [code, dp] of Object.entries(cd)) {
    if (!isIntIn(dp, 0, 4)) throw invalidArgument(`organization.currency_decimals.${code} must be an integer in [0, 4]`);
  }
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const nonNegative = (v: unknown): v is number => finite(v) && v >= 0;

/**
 * One regime block of `tax-config`. Every field the charge is computed from must be PRESENT and finite here,
 * because `getSettingValue` merges the stored blob over the default SHALLOWLY: a row that sets `regimes` at
 * all replaces the whole default `regimes` map, so a block written with only `slabs` has no
 * `standardDeduction`, no `rebate87A`, no `cessRate` and no `surcharge` - and none of them are defaulted.
 *
 * What that used to produce is the reason this validator exists. `gross - undefined` is NaN, `Math.max(0, NaN)`
 * is NaN rather than 0, every later step propagates it, and `payroll.ts` drops the TDS line on `tax > 0` -
 * which NaN fails. So an admin editing the Budget's slabs and omitting a sibling field shipped a month of
 * payslips with no income tax withheld: no error, no audit signal, nothing until Form 16.
 */
function validateTaxRegime(name: string, r: unknown) {
  const at = `tax-config.regimes.${name}`;
  if (!isObj(r)) throw invalidArgument(`${at} must be an object`);
  if (typeof r.label !== "string" || !r.label.trim()) throw invalidArgument(`${at}.label must be a non-empty string`);
  if (!nonNegative(r.standardDeduction)) throw invalidArgument(`${at}.standardDeduction must be a non-negative number`);
  if (!nonNegative(r.cessRate)) throw invalidArgument(`${at}.cessRate must be a non-negative number (a percent)`);
  if (!Array.isArray(r.slabs) || !r.slabs.length) throw invalidArgument(`${at}.slabs must be a non-empty array`);
  const slabs = r.slabs as unknown[];
  // ASCENDING, with exactly one open top band. `slabTax` walks the bands in order and treats `upTo: null` as
  // "the rest", so an unordered table charges the wrong rate on real income rather than failing.
  let prev = 0;
  slabs.forEach((s, i) => {
    if (!isObj(s)) throw invalidArgument(`${at}.slabs[${i}] must be an object`);
    if (!nonNegative(s.rate)) throw invalidArgument(`${at}.slabs[${i}].rate must be a non-negative number (a percent)`);
    const top = s.upTo;
    if (top === null || top === undefined) {
      if (i !== slabs.length - 1) throw invalidArgument(`${at}.slabs: only the LAST band may have a null upTo (it is the open top band)`);
      return;
    }
    if (!nonNegative(top)) throw invalidArgument(`${at}.slabs[${i}].upTo must be a non-negative number, or null on the last band`);
    if (top <= prev) throw invalidArgument(`${at}.slabs must ascend by upTo; band ${i} (${top}) does not exceed the one before it (${prev})`);
    prev = top;
  });
  const last = slabs[slabs.length - 1] as Record<string, unknown>;
  if (last.upTo !== null && last.upTo !== undefined) throw invalidArgument(`${at}.slabs must end with an open band (upTo: null), or income above the top band is untaxed`);
  const rebate = r.rebate87A;
  if (!isObj(rebate)) throw invalidArgument(`${at}.rebate87A must be an object { taxableLimit, maxRebate, marginalRelief }`);
  if (!nonNegative(rebate.taxableLimit)) throw invalidArgument(`${at}.rebate87A.taxableLimit must be a non-negative number`);
  if (!nonNegative(rebate.maxRebate)) throw invalidArgument(`${at}.rebate87A.maxRebate must be a non-negative number`);
  if (typeof rebate.marginalRelief !== "boolean") throw invalidArgument(`${at}.rebate87A.marginalRelief must be a boolean`);
  if (!Array.isArray(r.surcharge)) throw invalidArgument(`${at}.surcharge must be an array (empty when the regime has none)`);
  let over = -1;
  r.surcharge.forEach((s, i) => {
    if (!isObj(s) || !nonNegative(s.over) || !nonNegative(s.rate)) throw invalidArgument(`${at}.surcharge[${i}] must be { over: number, rate: number }`);
    if (s.over <= over) throw invalidArgument(`${at}.surcharge must ascend by over; band ${i} does not exceed the one before it`);
    over = s.over;
  });
}

// The key that decides what is withheld from every payslip, and it was the one money-shaping key with no
// validator at all.
function validateTaxConfig(value: unknown) {
  if (!isObj(value)) throw invalidArgument("tax-config must be an object");
  for (const k of ["assessmentYear", "financialYear"] as const) {
    if (value[k] != null && (typeof value[k] !== "string" || !/^\d{4}-\d{2}$/.test(value[k] as string))) {
      throw invalidArgument(`tax-config.${k} must look like "2026-27"`);
    }
  }
  if (value.regimes == null) return; // not touching the regimes: the default table stands
  if (!isObj(value.regimes)) throw invalidArgument("tax-config.regimes must be an object keyed by regime name");
  // `new` is the only regime this build can compute (domain/incomeTax.ts SUPPORTED_REGIMES), and because the
  // merge is shallow a `regimes` object that omits it leaves the app with no computable regime at all - which
  // surfaces as a 500 on every payroll build and every Tax page rather than as a bad setting.
  if (!("new" in value.regimes)) throw invalidArgument('tax-config.regimes must include "new": it is the regime this build computes, and a stored regimes object REPLACES the default one rather than merging into it');
  for (const [name, r] of Object.entries(value.regimes)) validateTaxRegime(name, r);
}

// `professional-tax`: a slab table plus an optional annual cap. Same shallow-merge hazard as tax-config, and
// the same blast radius one notch smaller - `[...cfg.slabs]` on a stored `{ annual_cap: 2500 }` is a
// TypeError, i.e. a 500 on every payroll build and every full-and-final from a settings edit.
function validateProfessionalTax(value: unknown) {
  if (!isObj(value)) throw invalidArgument("professional-tax must be an object");
  if (value.annual_cap != null && !nonNegative(value.annual_cap)) throw invalidArgument("professional-tax.annual_cap must be a non-negative number");
  if (value.slabs == null) return;
  if (!Array.isArray(value.slabs) || !value.slabs.length) throw invalidArgument("professional-tax.slabs must be a non-empty array");
  value.slabs.forEach((s, i) => {
    if (!isObj(s)) throw invalidArgument(`professional-tax.slabs[${i}] must be an object`);
    if (!nonNegative(s.amount)) throw invalidArgument(`professional-tax.slabs[${i}].amount must be a non-negative number`);
    const upTo = s.up_to;
    if (upTo !== null && upTo !== undefined && !nonNegative(upTo)) throw invalidArgument(`professional-tax.slabs[${i}].up_to must be a non-negative number, or null for the top band`);
  });
}

/**
 * The ticket lifecycle (`settings/ticket-workflow`). `validateStateMachine` has always existed and said what a
 * valid machine is - and its only caller in the repo was its own unit test, because this key was never
 * registered here. `upsertSetting` writes any JSON to any key, so a machine whose `to` names a state outside
 * `states` was accepted, cast as a ticket state and written onto a row - and `transitionFor` then found no
 * transition out of it, leaving the ticket stranded with no column and no legal move.
 */
function validateTicketWorkflow(value: unknown) {
  if (!isObj(value)) throw invalidArgument("ticket-workflow must be an object { states, initial, transitions }");
  const errors = validateStateMachine(value as unknown as StateMachine);
  if (errors.length) throw invalidArgument(`ticket-workflow: ${errors.join("; ")}`);
}

/**
 * The recruiting pipeline (`settings/ats`) - the OTHER configurable lifecycle, and it was registered nowhere.
 *
 * An application's stage is stored as the key, so the rules `validateAtsConfig` states (unique slug keys, a
 * `hired` terminal) are the ones that decide whether a saved pipeline can be walked at all. Same relationship
 * to this file as `validateStateMachine`: the rules are pure and testable in the domain, the registration is
 * what makes them a check rather than a document.
 */
function validateAts(value: unknown) {
  const errors = validateAtsConfig(value);
  if (errors.length) throw invalidArgument(`ats: ${errors.join("; ")}`);
}

// Per-key value validation for settings whose shape the money math relies on. Generic settings accept any
// JSON; a few keys must be guarded so a bad config can't silently corrupt payroll. A Map (not an object) so a
// setting_id like "constructor" resolves to nothing rather than to an inherited prototype member.
//
// THE STATUTORY KEYS BELONG HERE, and their absence was the gap: `tax-config` and `professional-tax` are the
// two keys that decide what the state takes out of somebody's pay, and neither was validated while six keys
// with far less at stake were. `upsertSetting` writes any JSON to any key, and `getSettingValue` merges it
// over the default shallowly - so the only place a partial statutory blob can be caught is here, before it is
// stored.
const SETTING_VALIDATORS = new Map<string, (value: unknown) => void>([
  ["ctc", validateCtc],
  ["esign", validateEsign],
  ["payslip", validatePayslip],
  ["asset-tags", validateAssetTags],
  ["organization", validateOrganization],
  ["attendance", validateAttendance],
  ["tax-config", validateTaxConfig],
  ["professional-tax", validateProfessionalTax],
  ["ticket-workflow", validateTicketWorkflow],
  ["ats", validateAts],
  ["gratuity", validateGratuity],
]);

// Exported so test/attendanceSettings.test.ts can drive the per-key rules without a request: these guard the
// blobs the day and money math read, and the failures they exist to stop (a timezone the runtime throws on, a
// silently-ignored `lop_basis` typo) are the kind nothing downstream can report.
export function validateSettingValue(key: string, value: unknown) {
  SETTING_VALIDATORS.get(key)?.(value);
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
    const key = c.req.param("setting_id");
    validateSettingValue(key, c.req.valid("json").value);
    // The one rule that cannot be decided from the value alone: a pipeline stage may not be REMOVED while live
    // applications are parked in it. Deleting one leaves those rows naming a stage nothing resolves - no board
    // column, no `nextStage`, so no way forward - and web/src/pages/Pipeline.tsx shows an active candidate under
    // "Closed". One read, on a write to this one key, and it names the stages that are in the way so the admin
    // can move those candidates first.
    if (key === "ats") {
      const value = c.req.valid("json").value;
      const stages = isObj(value) && Array.isArray(value.stages) ? (value.stages as AtsStage[]) : null;
      if (stages) {
        const orphaned = orphanedStages(stages, await stagesInUse(c.get("deps")));
        if (orphaned.length) {
          throw invalidArgument(
            `these stages still hold active applications and cannot be removed: ${orphaned.join(", ")}. Move those candidates to another stage first.`,
          );
        }
      }
    }
    // The same rule for the employee identity fields, which nothing checked at all: removing a field is what
    // stops its values ever being shown, edited or cleared again, while they stay in every employee's
    // encrypted blob (services/identityDetails.ts prunes lazily, per employee, on the next write to THAT
    // employee's details - a write removing the field is exactly what stops anyone making). So a removal that
    // would strand values is refused, naming the fields and how many people hold one, and
    // `?delete_removed_values=true` is the caller saying "yes, delete them" - at which point the values AND
    // the proofs uploaded against them are actually deleted, rather than hidden and left resurrectable by any
    // later field whose label slugs the same way.
    if (key === "employee_fields") {
      const value = c.req.valid("json").value;
      const next = isObj(value) && Array.isArray(value.fields) ? (value.fields as { key?: unknown; label?: unknown }[]) : null;
      // The confirmation rides INSIDE the value (which is an opaque object on the wire) and is consumed here
      // rather than stored: a query parameter on the standard Update method is the one thing the AEP linter
      // refuses, and this is a per-key rule rather than a property of Update.
      const confirmed = isObj(value) && value.delete_removed_values === true;
      if (isObj(value)) delete value.delete_removed_values;
      if (next) {
        const keep = new Set(
          next
            .map((f) => (typeof f?.key === "string" && f.key ? f.key : typeof f?.label === "string" ? slugKey(f.label) : ""))
            .filter(Boolean),
        );
        const removed = (await getFieldDefs(c.get("deps"))).filter((f) => !keep.has(f.key));
        if (removed.length) {
          const counts = await identityValueCounts(c.get("deps"), removed.map((f) => f.key));
          const inUse = removed.filter((f) => (counts.get(f.key) ?? 0) > 0);
          if (inUse.length && !confirmed) {
            throw invalidArgument(
              `these identity fields still hold values: ${inUse.map((f) => `${f.label} (${counts.get(f.key)})`).join(", ")}. ` +
                "Removing them deletes those values and any uploaded proof - re-send with delete_removed_values to confirm.",
            );
          }
          await purgeIdentityFields(c.get("deps"), c.get("user"), removed.map((f) => f.key));
        }
      }
    }
    // Optional, like every other patch in the API: send the ETag the edited value was read at and a save that
    // would overwrite somebody else's is refused with 409 instead of silently winning (services/settings.ts).
    const row = await upsertSetting(c.get("deps"), c.get("user"), c.req.param("setting_id"), c.req.valid("json").value, c.req.header("If-Match"));
    return c.json(toSettingResource(row));
  });
