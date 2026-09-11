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

const writeSchema = z.object({ value: z.unknown().optional(), key: z.string().optional() }).strict();

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isIntIn = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

// `ctc.basic_pct` pins basic at that % of CTC in the top-down split - outside (0, 100] the split produces
// basic <= 0 or is always infeasible, so reject it up front with a clear message rather than failing
// opaquely at revise time.
function validateCtc(value: unknown) {
  if (!isObj(value) || !("basic_pct" in value)) return;
  const p = value.basic_pct;
  if (typeof p !== "number" || !Number.isFinite(p) || p <= 0 || p > 100) throw invalidArgument("ctc.basic_pct must be a number in (0, 100]");
}

function validateEsign(value: unknown) {
  if (!isObj(value) || !("enabled" in value)) return;
  if (typeof value.enabled !== "boolean") throw invalidArgument("esign.enabled must be a boolean");
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
function validateOrganization(value: unknown) {
  if (!isObj(value)) return;
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

// Per-key value validation for settings whose shape the money math relies on. Generic settings accept any
// JSON; a few keys must be guarded so a bad config can't silently corrupt payroll. A Map (not an object) so a
// setting_id like "constructor" resolves to nothing rather than to an inherited prototype member.
const SETTING_VALIDATORS = new Map<string, (value: unknown) => void>([
  ["ctc", validateCtc],
  ["esign", validateEsign],
  ["payslip", validatePayslip],
  ["asset-tags", validateAssetTags],
  ["organization", validateOrganization],
  ["attendance", validateAttendance],
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
    validateSettingValue(c.req.param("setting_id"), c.req.valid("json").value);
    // Optional, like every other patch in the API: send the ETag the edited value was read at and a save that
    // would overwrite somebody else's is refused with 409 instead of silently winning (services/settings.ts).
    const row = await upsertSetting(c.get("deps"), c.get("user"), c.req.param("setting_id"), c.req.valid("json").value, c.req.header("If-Match"));
    return c.json(toSettingResource(row));
  });
