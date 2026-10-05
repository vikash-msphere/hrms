import { and, count, eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { aborted, invalidArgument, notFound } from "../lib/errors";
import { etagOf } from "../http/serialize";
import { paginate } from "../http/pagination";
import { PUSH_PREF_KEY, MAX_PUSH_DEVICES, pushEndpointAllowed } from "./webPush";

// Preferences are caller-scoped: a row is keyed by (userId, key) and the wire path
// is preferences/{key}, always resolved against the current user.
export async function listPreferences(deps: Deps, actor: AppUser, maxPageSize = 50, pageToken?: string) {
  const rows = await deps.db.select().from(schema.preferences).where(eq(schema.preferences.userId, actor.uuid));
  // Paged by KEY, not by `uuid`. A preference's wire identity is `preferences/<key>` (the collection is not in
  // encodeWireIds' ENCODABLE set, so its rows carry no token), and the rows are already narrowed to this one
  // user - so the key is unique here AND is the public identifier. Paging on `uuid` put the internal id in
  // `next_page_token` for a collection that has no codec domain to encode it under.
  return paginate(rows, maxPageSize, pageToken, (r) => +new Date(r.createdAt), (r) => r.key);
}

export async function getPreference(deps: Deps, actor: AppUser, key: string) {
  const row = (
    await deps.db
      .select()
      .from(schema.preferences)
      .where(and(eq(schema.preferences.userId, actor.uuid), eq(schema.preferences.key, key)))
      .limit(1)
  )[0];
  if (!row) throw notFound("preference not found");
  return row;
}

/**
 * The most a single preference value may weigh, serialized.
 *
 * The route accepts `z.unknown()` - any JSON, by design, because a preference is whatever the client needs to
 * remember - and the only ceiling on it was the API-wide body cap, which is the DOCUMENT cap (10 MiB). Two
 * things follow. D1 refuses a row over 2 MB, so anything between those numbers left as a `D1_ERROR` through
 * the generic 500 branch: an error the caller cannot act on, about a limit nothing states. And a signed-in
 * caller could park megabytes per key, for as many keys as they cared to name.
 *
 * 64 KiB is far above every real preference (the largest is a saved table layout) and far below the row limit,
 * so an oversized write is now an `invalid_argument` naming the limit.
 */
export const MAX_PREFERENCE_BYTES = 64 * 1024;

/** The most preference keys one user may hold. A preference is created by the client naming a key, so without
 *  a ceiling the row count per user is caller-controlled. Well above the ~20 the app itself uses. */
export const MAX_PREFERENCE_KEYS = 100;

/**
 * Per-key validation, for the keys whose value the SERVER acts on.
 *
 * Almost every preference is inert: the client writes it and the client reads it back, so its shape is the
 * client's business and `z.unknown()` is the honest contract. `push_subscriptions` is the exception - the
 * Worker `fetch`es the endpoints in it - and an inert-by-default contract silently covered that too. See
 * `pushEndpointAllowed` for what an unvalidated endpoint there amounted to.
 */
function validateValue(key: string, value: unknown): void {
  if (key !== PUSH_PREF_KEY) return;
  const v = value as { subs?: unknown };
  if (v == null || typeof v !== "object" || !Array.isArray(v.subs)) throw invalidArgument("push_subscriptions must be an object with a `subs` array");
  if (v.subs.length > MAX_PUSH_DEVICES) throw invalidArgument(`at most ${MAX_PUSH_DEVICES} push subscriptions may be registered`);
  for (const s of v.subs) {
    const sub = s as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    if (typeof sub?.endpoint !== "string" || typeof sub.keys?.p256dh !== "string" || typeof sub.keys?.auth !== "string") {
      throw invalidArgument("each push subscription needs an `endpoint` and `keys.p256dh` / `keys.auth`");
    }
    // The one value here the server will make an outbound request to.
    if (!pushEndpointAllowed(sub.endpoint)) throw invalidArgument("a push subscription endpoint must be an https URL on a public host");
  }
}

// Upsert: create the caller's preference for this key, or replace its value.
//
// With neither validator it is ONE statement, resolved by the (userId, key) unique index rather than by
// looking first. A person is more than one session - a second tab, a phone, the theme being written the moment
// two of them load - and a look-then-insert loses that race against its own index, which surfaced as a 500 on
// something as ordinary as remembering the theme. `createdAt` survives the conflict path, so the row keeps the
// day it was made.
//
// The validators are for a caller whose value is built FROM a read, exactly as on settings
// (services/settings.ts#upsertSetting). `If-Match` names the version the value was built on, and the UPDATE
// only lands while the row is still at it. `If-None-Match: *` is the caller that read NO row - including one
// whose read failed and so cannot tell - and it may only create: a value built on nothing must never replace a
// list another device appended to (push subscriptions, saved searches) or a layout the person built up.
export async function upsertPreference(deps: Deps, actor: AppUser, key: string, value: unknown, ifMatch?: string, ifNoneMatch?: string) {
  validateValue(key, value);
  const json = JSON.stringify(value ?? {});
  if (json.length > MAX_PREFERENCE_BYTES) {
    throw invalidArgument(`preference value too large (max ${Math.floor(MAX_PREFERENCE_BYTES / 1024)} KiB)`);
  }
  const mine = and(eq(schema.preferences.userId, actor.uuid), eq(schema.preferences.key, key));
  // Looked up only to count a NEW key and to check a validator, so an ordinary rewrite (the theme, a table
  // layout) stays the single statement below plus this one indexed read.
  const existing = (await deps.db.select({ updatedAt: schema.preferences.updatedAt }).from(schema.preferences).where(mine).limit(1))[0];
  if (existing && ifNoneMatch?.trim() === "*") throw aborted("the preference was created elsewhere; read it again and retry");
  if (!existing && ifMatch) throw aborted("etag mismatch");
  if (!existing) {
    const held = (await deps.db.select({ n: count() }).from(schema.preferences).where(eq(schema.preferences.userId, actor.uuid)))[0]?.n ?? 0;
    if (held >= MAX_PREFERENCE_KEYS) throw invalidArgument(`at most ${MAX_PREFERENCE_KEYS} preferences may be stored`);
  }
  if (existing && ifMatch) {
    // COMPARE-AND-SWAP on the version read, so a write that loses the race is refused by the DB, not by a read
    // that may already be stale.
    if (ifMatch !== etagOf(+new Date(existing.updatedAt))) throw aborted("etag mismatch");
    const [updated] = await deps.db
      .update(schema.preferences)
      .set({ value: json, updatedAt: new Date() })
      .where(and(mine, eq(schema.preferences.updatedAt, existing.updatedAt)))
      .returning();
    if (!updated) throw aborted("etag mismatch");
    return updated;
  }
  if (ifNoneMatch?.trim() === "*") {
    // Create-only, and still one statement against the unique index: a create that loses the race to another
    // session's finds the row there and is refused rather than overwriting it.
    const [created] = await deps.db.insert(schema.preferences).values({ userId: actor.uuid, key, value: json }).onConflictDoNothing().returning();
    if (!created) throw aborted("the preference was created elsewhere; read it again and retry");
    return created;
  }
  const [row] = await deps.db
    .insert(schema.preferences)
    .values({ userId: actor.uuid, key, value: json })
    .onConflictDoUpdate({
      target: [schema.preferences.userId, schema.preferences.key],
      set: { value: json, updatedAt: new Date() },
    })
    .returning();
  return row!;
}
