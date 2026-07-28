// Generic item lifecycle shared across resources: enable/disable (exclude from use),
// lock/unlock (protect from edits), and publish/unpublish (draft state).
//
// Who may call these verbs is decided ENTIRELY by the middleware (the :enable/:disable/:lock/:unlock/
// :publish/:unpublish grant, code-scoped). This service only performs the state transition and writes
// audit - it makes NO access decision. `assertNotLocked` is a WORKFLOW precondition (a locked row rejects
// edits for everyone alike, regardless of who they are), not access control, so it stays here.
import { eq } from "drizzle-orm";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { notifyMany, activeEmployeeIds } from "./notifications";
import { emitEvent } from "./eventBus";
import { notFound, failedPrecondition } from "../lib/errors";

type Table = any;
type Row = {
  uuid: string;
  locked?: boolean | null;
  lockedBy?: string | null;
  [k: string]: unknown;
};

async function fetchRow(deps: Deps, table: Table, id: string): Promise<Row | undefined> {
  return (await deps.db.select().from(table).where(eq(table.uuid, id)).limit(1))[0] as Row | undefined;
}

/** Throw if the row is locked (block edits/deletes until it is unlocked). Workflow precondition, not access. */
export function assertNotLocked(row: { locked?: boolean | null }) {
  if (row.locked) throw failedPrecondition("item is locked; unlock it before editing");
}

async function set(deps: Deps, table: Table, id: string, fields: Record<string, unknown>) {
  await deps.db.update(table).set({ ...fields, updatedAt: new Date() }).where(eq(table.uuid, id));
  return fetchRow(deps, table, id);
}

export async function setDisabled(deps: Deps, actor: AppUser, table: Table, singular: string, collection: string, id: string, disabled: boolean) {
  const row = await fetchRow(deps, table, id);
  if (!row) throw notFound(`${singular} not found`);
  assertNotLocked(row);
  const out = await set(deps, table, id, { disabled });
  await audit(deps, actor, `${singular}.${disabled ? "disable" : "enable"}`, collection, id, undefined, out ?? row);
  return out;
}

export async function setLocked(deps: Deps, actor: AppUser, table: Table, singular: string, collection: string, id: string, locked: boolean) {
  const row = await fetchRow(deps, table, id);
  if (!row) throw notFound(`${singular} not found`);
  // Authority to lock/unlock is the verb grant the middleware already enforced; we just record who locked
  // it (audit) and toggle the flag. No rank/owner check here - that would be access control in the service.
  const out = locked
    ? await set(deps, table, id, { locked: true, lockedBy: actor.uuid })
    : await set(deps, table, id, { locked: false, lockedBy: null });
  await audit(deps, actor, `${singular}.${locked ? "lock" : "unlock"}`, collection, id, undefined, out ?? row);
  return out;
}

export async function setPublished(
  deps: Deps,
  actor: AppUser,
  table: Table,
  singular: string,
  collection: string,
  id: string,
  published: boolean,
  withPublishTime = false,
) {
  const row = await fetchRow(deps, table, id);
  if (!row) throw notFound(`${singular} not found`);
  assertNotLocked(row);
  const fields: Record<string, unknown> = { published };
  if (withPublishTime) fields.publishTime = published ? new Date() : null;
  const out = await set(deps, table, id, fields);
  await audit(deps, actor, `${singular}.${published ? "publish" : "unpublish"}`, collection, id, undefined, out ?? row);
  // Publishing an announcement broadcasts an in-app notification to every active employee (except the author).
  if (collection === "announcements" && published) {
    const author = (row as { authorEmployeeId?: string | null }).authorEmployeeId ?? null;
    const recipients = (await activeEmployeeIds(deps)).filter((eid) => eid !== author);
    await notifyMany(deps, recipients, { type: "announcement.published", title: "New announcement", body: (row as { title?: string }).title ?? undefined, link: "announcements" });
    await emitEvent(deps, actor, "announcement.published", { subject: `announcements/${id}`, payload: { title: (row as { title?: string }).title ?? null } });
  }
  return out;
}
