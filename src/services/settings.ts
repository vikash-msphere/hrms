import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, fieldDiff } from "../lib/audit";
import { notFound } from "../lib/errors";
import { paginate } from "../http/pagination";

// Settings keys whose VALUES are stored in this table but are NOT exposed through the broadly-readable
// generic settings API. They are served only by their own access-gated namespaces (/v1/bank-formats,
// /v1/payroll-debit), so the generic list/get/patch routes skip them. Internal server-side reads via
// getSettingValue are unaffected (they read the row directly). This is a data-shape rule, not an access
// decision - the access gate lives on the dedicated namespaces.
export const MANAGED_KEYS = new Set<string>(["bank-formats", "payroll-debit"]);

// Org-wide settings (one row per key). Readable by all; writes gated at the route.
export async function listSettings(deps: Deps, maxPageSize = 50, pageToken?: string) {
  const rows = (await deps.db.select().from(schema.settings)).filter((r) => !MANAGED_KEYS.has(r.key));
  return paginate(rows, maxPageSize, pageToken, (r) => +new Date(r.updatedAt), (r) => r.key);
}

export async function getSetting(deps: Deps, key: string) {
  const row = (await deps.db.select().from(schema.settings).where(eq(schema.settings.key, key)).limit(1))[0];
  if (!row) throw notFound("setting not found");
  return row;
}

/** Read a setting's parsed value with a fallback (used internally, e.g. holiday policy). A malformed blob
 *  falls back to the default rather than throwing a 500 - this backs esign/tax/letter/etc. config reads, so
 *  one corrupt row must not take down every request that touches it. */
export async function getSettingValue<T>(deps: Deps, key: string, fallback: T): Promise<T> {
  const row = (await deps.db.select().from(schema.settings).where(eq(schema.settings.key, key)).limit(1))[0];
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
  const existing = (await deps.db.select().from(schema.settings).where(eq(schema.settings.key, key)).limit(1))[0];
  if (existing) {
    const [updated] = await deps.db.update(schema.settings).set({ value: json, updatedAt: new Date() }).where(eq(schema.settings.key, key)).returning();
    const diff = settingDiff(existing.value, json);
    await audit(deps, actor, "setting.update", "settings", key, diff ? { diff } : undefined);
    return updated!;
  }
  const [inserted] = await deps.db.insert(schema.settings).values({ key, value: json }).returning();
  await audit(deps, actor, "setting.create", "settings", key);
  return inserted!;
}
