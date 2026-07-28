import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { notFound } from "../lib/errors";
import { NOTIFICATION_CATEGORIES, parseNotificationPrefs, type NotificationPrefs } from "../domain/notificationConfig";

// Per-user in-app notification preferences (self-service mute list), stored as a JSON blob on the employee row.
// Access to employees/<id>/notification-prefs is owner/super-scoped by the middleware exactly like personal-info,
// so a caller only ever reads/writes their own. Layered over the org config by notify() at emit time.

const VALID = new Set(NOTIFICATION_CATEGORIES.map((c) => c.key));

async function loadEmployee(deps: Deps, employeeId: string) {
  const row = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, employeeId)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("employee not found");
  return row;
}

export async function getNotificationPrefs(deps: Deps, _actor: AppUser, employeeId: string): Promise<NotificationPrefs> {
  const emp = await loadEmployee(deps, employeeId);
  return parseNotificationPrefs(emp.notificationPrefs);
}

export async function setNotificationPrefs(deps: Deps, _actor: AppUser, employeeId: string, input: { muted?: unknown; digest?: unknown }): Promise<NotificationPrefs> {
  const emp = await loadEmployee(deps, employeeId);
  // Keep only known category keys (drops anything stale/invalid), deduped.
  const muted = Array.isArray(input.muted) ? [...new Set(input.muted.filter((k): k is string => typeof k === "string" && VALID.has(k)))] : [];
  // digest is preserved when the caller omits it (this endpoint fully replaces the blob).
  const digest = typeof input.digest === "boolean" ? input.digest : parseNotificationPrefs(emp.notificationPrefs).digest;
  const next: NotificationPrefs = { muted, digest };
  await deps.db.update(schema.employees).set({ notificationPrefs: JSON.stringify(next), updatedAt: new Date() }).where(eq(schema.employees.uuid, emp.uuid));
  return next;
}
