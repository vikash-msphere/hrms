// Notifying the people a board body names (@mentions). The syntax and the parser live in domain/mentions.ts;
// this is the side effect - decode the wire tokens the author wrote, keep the ones that are real employees,
// and tell them.
//
// Its own module rather than a function in services/announcements.ts so lifecycle.ts (which announcements
// already imports for assertNotLocked) can notify mentions when a draft goes live, without a cycle.
import { inArray } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { notifyMany } from "./notifications";
import { newMentions } from "../domain/mentions";
import { richExcerpt } from "../domain/richText";

/**
 * Notify everyone newly mentioned in `body`. `previousBody` is the version being replaced (an edit), so a
 * name that was already there is not notified twice; omit it for a create/publish/reply, where every
 * mention is new.
 *
 * A mention is a notification, never a grant. On the board that costs nothing - every employee can read it.
 * On a task or a ticket it means a mention can name somebody who cannot open what they were named in: they
 * get told, they still need access, and that is the honest behaviour. Widening access silently because
 * somebody typed an `@` would be the alternative, and it is worse.
 *
 * `subject` is the wire path of the thing being talked about (`announcements/x`, `cards/x`, `tickets/x`),
 * `link` the page that opens it, and `type` the notification category (`announcement.mention`,
 * `board.mention`, `ticket.mention`) so an org can mute mentions per area like every other notification.
 */
export async function notifyMentions(
  deps: Deps,
  actor: AppUser,
  opts: { subject: string; link: string; type: string; body?: string | null; previousBody?: string | null; title: string },
) {
  const tokens = newMentions(opts.body, opts.previousBody);
  if (!tokens.length) return;
  // Wire token -> internal id. A forged, foreign or stale token simply does not decode and is dropped.
  const ids = (await Promise.all(tokens.map((t) => deps.idCodec.decode("employees", t)))).filter(Boolean) as string[];
  // Never notify the author for naming themselves; never mention a deleted employee.
  const candidates = [...new Set(ids)].filter((id) => id !== actor.employeeId);
  if (!candidates.length) return;
  const live = (await deps.db
    .select({ uuid: schema.employees.uuid, deleteTime: schema.employees.deleteTime })
    .from(schema.employees)
    .where(inArray(schema.employees.uuid, candidates)))
    .filter((e) => !e.deleteTime)
    .map((e) => e.uuid);
  if (!live.length) return;
  await notifyMany(deps, live, {
    type: opts.type,
    title: "You were mentioned",
    body: richExcerpt(opts.body, 120) || opts.title,
    link: opts.link,
    subject: opts.subject,
    actorId: actor.employeeId ?? undefined,
  });
}
