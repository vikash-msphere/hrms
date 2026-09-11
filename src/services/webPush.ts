// Fan a freshly created in-app notification out to the recipient's registered browsers. Subscriptions live in
// the user's own preferences row (key "push_subscriptions", written by the SPA when the user enables browser
// notifications) - no separate collection, and the caller-scoped preferences routes already gate writes.
// Everything here is best-effort: push is a bonus channel on top of the bell, never a failure source.
import { and, eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { assertPublicHttpsUrl } from "../lib/urlGuard";

export const PUSH_PREF_KEY = "push_subscriptions";
export const MAX_PUSH_DEVICES = 5;

type StoredSub = { endpoint: string; keys: { p256dh: string; auth: string } };

/**
 * Is this endpoint one the Worker may `fetch`?
 *
 * IT IS AN OUTBOUND URL FROM AN UNTRUSTED SOURCE, and it was treated as a string. A subscription is written
 * through `PATCH /v1/preferences/push_subscriptions`, whose body is the caller's own to set, and the sender
 * (lib/webPush.ts) does `fetch(sub.endpoint, init)`. So any signed-in employee could register up to five
 * arbitrary URLs - `http://`, any port, a private address - and have the Worker POST to each of them on every
 * notification they could provoke about themselves. That is precisely the primitive `assertPublicHttpsUrl`
 * exists for, written for the automation-webhook action and applied nowhere else; the guard's own header
 * explains why an author-supplied host has to be parsed into an address rather than prefix-matched.
 *
 * Checked at BOTH ends. Here is the send side, which covers rows an older build already stored; the write
 * side refuses it up front (services/preferences.ts) so a rejected endpoint is an error the caller sees
 * rather than a subscription that silently never delivers.
 *
 * Real push endpoints are on port 443 of a handful of vendor hosts (FCM, Mozilla, Apple, WNS), so nothing
 * legitimate is turned away. An explicit host allow-list would be tighter still; it is not used because a
 * browser this build has not heard of would then stop working with no way for an operator to tell why.
 */
export function pushEndpointAllowed(endpoint: string): boolean {
  try {
    assertPublicHttpsUrl(endpoint);
    return true;
  } catch {
    return false;
  }
}

function parseSubs(value: string): StoredSub[] {
  try {
    const v = JSON.parse(value) as { subs?: unknown[] };
    if (!Array.isArray(v?.subs)) return [];
    return v.subs.filter((s): s is StoredSub => {
      const c = s as StoredSub;
      return typeof c?.endpoint === "string" && typeof c?.keys?.p256dh === "string" && typeof c?.keys?.auth === "string" && pushEndpointAllowed(c.endpoint);
    }).slice(0, MAX_PUSH_DEVICES);
  } catch {
    return [];
  }
}

/** Push `payload` to every registered device of the employee's user account. No-op without a configured
 *  PushSender or any registered device. Subscriptions the push service reports dead are pruned in place. */
export async function pushToEmployee(
  deps: Deps,
  employeeId: string,
  payload: { title: string; body?: string; link?: string }
): Promise<void> {
  if (!deps.push) return;
  try {
    // One joined read (not user-then-prefs): this runs on EVERY single-recipient notify when push is
    // configured, and most recipients have no registered device - keep the common no-op path at 1 D1 read.
    const row = (
      await deps.db
        .select({ uuid: schema.preferences.uuid, value: schema.preferences.value })
        .from(schema.preferences)
        .innerJoin(schema.users, eq(schema.preferences.userId, schema.users.uuid))
        .where(and(eq(schema.users.employeeId, employeeId), eq(schema.preferences.key, PUSH_PREF_KEY)))
        .limit(1)
    )[0];
    if (!row) return;
    const subs = parseSubs(row.value);
    if (subs.length === 0) return;
    const results = await Promise.all(subs.map((s) => deps.push!.send(s, payload)));
    const live = subs.filter((_, i) => results[i] !== "gone");
    if (live.length !== subs.length) {
      await deps.db
        .update(schema.preferences)
        .set({ value: JSON.stringify({ subs: live }), updatedAt: deps.clock.now() })
        .where(eq(schema.preferences.uuid, row.uuid));
    }
  } catch (e) {
    console.error("[push] delivery failed (non-fatal)", e);
  }
}
