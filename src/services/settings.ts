import { and, eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, fieldDiff } from "../lib/audit";
import { AppError, aborted, invalidArgument, isSettingKeyCollision, notFound } from "../lib/errors";
import { etagOf } from "../http/serialize";
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
  // No `wire`: a setting's identity IS its key (`/v1/settings/<key>`) - see the note in services/roles.ts.
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

/** The most one settings value may serialize to.
 *
 *  A ceiling here is not tidiness, it is the read cost of every request in the app: `refSettings`
 *  (lib/refData.ts) selects the WHOLE settings table - every key, every value - and it is the read behind
 *  `getSettingValue`, so essentially nothing runs without pulling it (the org's calendar day, the
 *  serializers' `organization` blob, payroll's five keys). D1 bills rows read by their bytes, so ONE
 *  oversized value taxes every request in the system until somebody edits it back.
 *
 *  The only ceiling before this was the global body limit, `MAX_DOCUMENT_BYTES` = 10 MB
 *  (middleware/bodyLimit.ts), which is sized for uploading a PDF rather than for a config row - and that file
 *  says what a limit of that size is: "reject once the buffer exists is not a cap, it is a report".
 *
 *  2 MB is generous for the biggest value the app has, `organization`, which carries four logos and a favicon
 *  INSIDE it as data URLs (the per-image caps are checked in routes/settings.ts#validateOrganization, so the
 *  form's limits are the app's limits) - and is far under the body limit, so a request that trips this one is
 *  saying something about the value rather than about the transport. */
export const MAX_SETTING_BYTES = 2 * 1024 * 1024;

export async function upsertSetting(deps: Deps, actor: AppUser, key: string, value: unknown, ifMatch?: string) {
  const json = JSON.stringify(value ?? {});
  if (json.length > MAX_SETTING_BYTES) {
    throw invalidArgument(`this setting is ${Math.round(json.length / 1024)} KB; a settings value may be at most ${Math.round(MAX_SETTING_BYTES / 1024)} KB`);
  }
  // Read-for-diff goes straight to the row: this is the one path that must see the CURRENT value (a stale
  // snapshot would write a wrong audit diff).
  const existing = (await deps.db.select().from(schema.settings).where(eq(schema.settings.key, key)).limit(1))[0];
  if (existing) {
    if (ifMatch && ifMatch !== etagOf(+new Date(existing.updatedAt))) throw aborted("etag mismatch");
    // COMPARE-AND-SWAP when the caller said which version it edited, exactly as services/crud.ts does for
    // every other row. It matters MORE here than there: a settings value is one blob holding many independent
    // fields, so the whole of it is rewritten to change any part of it. Two people saving different sections
    // of the same key a moment apart is not an exotic race - it is two admins in Settings - and without the
    // version in the WHERE the second save silently reverts the first, with a 200 and no trace but the audit
    // diff. A caller that sends no If-Match keeps last-write-wins, so nothing that never had an ETag to send
    // changes behaviour.
    const [updated] = await deps.db
      .update(schema.settings)
      .set({ value: json, updatedAt: new Date() })
      .where(ifMatch ? and(eq(schema.settings.key, key), eq(schema.settings.updatedAt, existing.updatedAt)) : eq(schema.settings.key, key))
      .returning();
    if (!updated) throw aborted("etag mismatch");
    // After the write: the rest of THIS request (an automation the save triggers, the serialized response)
    // must see the new value, not the snapshot taken before it.
    bustRef(deps, "settings");
    const diff = settingDiff(existing.value, json);
    await audit(deps, actor, "setting.update", "settings", key, diff ? { diff } : undefined);
    return updated!;
  }
  // An If-Match on a key that has no row at all is a caller editing a version that is gone (the key was
  // never written, or something purged it). Creating it here would discard whatever it thought it was
  // amending, so it is the same conflict as any other stale ETag.
  if (ifMatch) throw aborted("etag mismatch");
  // Two callers can both read no row and both get here; `settings.key` is the primary key, so the second
  // insert fails. That is the create-race the caller can simply retry against the row that now exists - not
  // a fault - so it answers 409 like every other lost allocation race rather than an unhandled 500.
  let inserted: typeof schema.settings.$inferSelect | undefined;
  try {
    [inserted] = await deps.db.insert(schema.settings).values({ key, value: json }).returning();
  } catch (e) {
    if (isSettingKeyCollision(e)) throw aborted("the setting was created concurrently; read it again and retry");
    throw e;
  }
  bustRef(deps, "settings");
  // A first save has no previous value to diff against, so the whole of what it set IS the change.
  await audit(deps, actor, "setting.create", "settings", key, { diff: { value: { from: null, to: json.length > 140 ? `${json.slice(0, 140)}…` : json } } }, inserted);
  return inserted!;
}

/**
 * Read one settings blob, change part of it, and write it back WITHOUT losing a concurrent change to another
 * part of the same blob.
 *
 * This is the shape every managed-key writer has: `bank-formats` and `payroll-debit` each store a MAP keyed by
 * bank, and editing one bank means rewriting the whole map. Done as a plain read-then-write - which is what
 * services/bankFormats.ts did - two admins saving two different banks a moment apart silently revert each
 * other: both read the map, both add their own key, the second write wins and the first bank is simply gone,
 * with a 200 on both requests and nothing but the audit diff to say so. The blob these two hold is the
 * employer's payout configuration, so "gone" means a bank file built against a debit account nobody
 * re-entered.
 *
 * `upsertSetting` has had the compare-and-swap for this since the generic settings route grew an `If-Match` -
 * these two callers were simply the ones that never passed a version, and they could not: their routes expose
 * no ETag of their own (the resource is `bank-formats/<bank>`, not the settings row), so there was no version
 * for a client to hold. So the version is taken and used HERE, on the server, across the read and the write
 * that belong together - which is the guarantee that was actually missing. A client sending nothing is
 * unaffected, and no wire contract changes.
 *
 * A conflict is RETRIED rather than returned: the losing writer's edit is still valid, it was just computed
 * against a map that has since grown another key, so re-reading and re-applying is exactly right and is
 * invisible to the caller. Bounded, because a key contended through every attempt is not a race a longer wait
 * fixes - and past the bound the 409 is honest and retryable.
 */
const SETTING_MAP_ATTEMPTS = 4;
export async function mutateSetting<T>(deps: Deps, actor: AppUser, key: string, fallback: T, mutate: (current: T) => T): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    // Straight to the row, NOT through refSettings: that snapshot is per-request and is taken before any of
    // this, so reading the map from it would re-introduce the stale read this function exists to close.
    const row = (await deps.db.select().from(schema.settings).where(eq(schema.settings.key, key)).limit(1))[0];
    let current: T = fallback;
    if (row) {
      try {
        current = { ...fallback, ...(JSON.parse(row.value) as object) };
      } catch {
        console.error(`setting "${key}" holds malformed JSON; using default`);
      }
    }
    const next = mutate(current);
    try {
      // No row yet means there is no version to pin, so the first write goes in unguarded - and the insert
      // race is already answered by the primary key on `settings.key`, which `upsertSetting` turns into the
      // same `aborted` this loop retries.
      await upsertSetting(deps, actor, key, next, row ? etagOf(+new Date(row.updatedAt)) : undefined);
      return next;
    } catch (e) {
      const lost = e instanceof AppError && e.httpStatus === 409;
      if (!lost || attempt >= SETTING_MAP_ATTEMPTS) throw e;
    }
  }
}

// The org's single currency (settings/organization `default_currency`, "INR" out of the box). The app is
// deliberately single-currency: every payable is guarded against it at payroll build time, so anything that
// MINTS a payable must default to this rather than to a literal - a hardcoded "INR" in a non-INR org creates a
// bonus or a compensation row that fails the whole run's currency guard the moment payroll touches it.
export async function orgCurrency(deps: Deps): Promise<string> {
  const org = await getSettingValue<{ default_currency?: string }>(deps, "organization", {});
  return org.default_currency?.trim() || "INR";
}
