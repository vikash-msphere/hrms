import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, fieldDiff } from "../lib/audit";
import { notFound } from "../lib/errors";
import { paginate } from "../http/pagination";
import { refSettings, bustRef } from "../lib/refData";

// Settings keys whose VALUES are stored in this table but are NOT exposed through the broadly-readable
// generic settings API. They are served only by their own access-gated namespaces (/v1/bank-formats,
// /v1/payroll-debit), so the generic list/get/patch routes skip them. Internal server-side reads via
// getSettingValue are unaffected (they read the row directly). This is a data-shape rule, not an access
// decision - the access gate lives on the dedicated namespaces.
export const MANAGED_KEYS = new Set<string>(["bank-formats", "payroll-debit"]);

// Org-wide settings (one row per key). Readable by all; writes gated at the route.
//
// Every read here comes off ONE per-request snapshot of the table (lib/refData.ts) instead of its own query.
// The table is tiny and read constantly - a page reads a handful of keys and half the money code consults one -
// so `WHERE key = ?` per key meant a scan per key. Same request, one read; a write inside the request drops it.
export async function listSettings(deps: Deps, maxPageSize = 50, pageToken?: string) {
  const rows = (await refSettings(deps)).filter((r) => !MANAGED_KEYS.has(r.key));
  return paginate(rows, maxPageSize, pageToken, (r) => +new Date(r.updatedAt), (r) => r.key);
}

export async function getSetting(deps: Deps, key: string) {
  const row = (await refSettings(deps)).find((r) => r.key === key);
  if (!row) throw notFound("setting not found");
  return row;
}

/** Read a setting's parsed value with a fallback (used internally, e.g. holiday policy). A malformed blob
 *  falls back to the default rather than throwing a 500 - this backs esign/tax/letter/etc. config reads, so
 *  one corrupt row must not take down every request that touches it. */
export async function getSettingValue<T>(deps: Deps, key: string, fallback: T): Promise<T> {
  const row = (await refSettings(deps)).find((r) => r.key === key);
  if (!row) return fallback;
  try {
    return { ...fallback, ...(JSON.parse(row.value) as object) };
  } catch {
    console.error(`setting "${key}" holds malformed JSON; using default`);
    return fallback;
  }
}

// The org-wide default department (internal uuid) or null. Stored in the `organization` settings blob as a
// `default_department` resource ref ("departments/<id>"). Board cards and helpdesk tickets fall back to it
// when no department is otherwise supplied. Malformed/absent -> null (no default).
export async function getDefaultDepartmentId(deps: Deps): Promise<string | null> {
  const org = await getSettingValue<{ default_department?: string | null }>(deps, "organization", {});
  const ref = org.default_department;
  return ref ? ref.split("/").pop() ?? null : null;
}

// Shallow before→after diff over a settings blob's top-level keys, for audit meta. Both sides are the
// parsed JSON values (objects, or scalars/arrays wrapped so `fieldDiff` sees a single "value" key).
function settingDiff(before: string, after: string): Record<string, { from: unknown; to: unknown }> | undefined {
  const parse = (s: string): Record<string, unknown> => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
    } catch {
      return { value: s };
    }
  };
  const b = parse(before);
  const a = parse(after);
  const diff = fieldDiff(b, a, [...new Set([...Object.keys(b), ...Object.keys(a)])]);
  return Object.keys(diff).length ? diff : undefined;
}

export async function upsertSetting(deps: Deps, actor: AppUser, key: string, value: unknown) {
  const json = JSON.stringify(value ?? {});
  // Read-for-diff goes straight to the row: this is the one path that must see the CURRENT value (a stale
  // snapshot would write a wrong audit diff).
  const existing = (await deps.db.select().from(schema.settings).where(eq(schema.settings.key, key)).limit(1))[0];
  if (existing) {
    const [updated] = await deps.db.update(schema.settings).set({ value: json, updatedAt: new Date() }).where(eq(schema.settings.key, key)).returning();
    // After the write: the rest of THIS request (an automation the save triggers, the serialized response)
    // must see the new value, not the snapshot taken before it.
    bustRef(deps, "settings");
    const diff = settingDiff(existing.value, json);
    await audit(deps, actor, "setting.update", "settings", key, diff ? { diff } : undefined);
    return updated!;
  }
  const [inserted] = await deps.db.insert(schema.settings).values({ key, value: json }).returning();
  bustRef(deps, "settings");
  await audit(deps, actor, "setting.create", "settings", key);
  return inserted!;
}

// The org's single currency (settings/organization `default_currency`, "INR" out of the box). The app is
// deliberately single-currency: every payable is guarded against it at payroll build time, so anything that
// MINTS a payable must default to this rather than to a literal - a hardcoded "INR" in a non-INR org creates a
// bonus or a compensation row that fails the whole run's currency guard the moment payroll touches it.
export async function orgCurrency(deps: Deps): Promise<string> {
  const org = await getSettingValue<{ default_currency?: string }>(deps, "organization", {});
  return org.default_currency?.trim() || "INR";
}
