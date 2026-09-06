import { and, eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { notFound } from "../lib/errors";
import { paginate } from "../http/pagination";

// Preferences are caller-scoped: a row is keyed by (userId, key) and the wire path
// is preferences/{key}, always resolved against the current user.
export async function listPreferences(deps: Deps, actor: AppUser, maxPageSize = 50, pageToken?: string) {
  const rows = await deps.db.select().from(schema.preferences).where(eq(schema.preferences.userId, actor.uuid));
  return paginate(rows, maxPageSize, pageToken, (r) => +new Date(r.createdAt), (r) => r.uuid);
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

// Upsert: create the caller's preference for this key, or replace its value.
//
// ONE statement, resolved by the (userId, key) unique index rather than by looking first. A person is more
// than one session - a second tab, a phone, the theme being written the moment two of them load - and a
// look-then-insert loses that race against its own index, which surfaced as a 500 on something as ordinary
// as remembering the theme. `createdAt` survives the conflict path, so the row keeps the day it was made.
export async function upsertPreference(deps: Deps, actor: AppUser, key: string, value: unknown) {
  const json = JSON.stringify(value ?? {});
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
