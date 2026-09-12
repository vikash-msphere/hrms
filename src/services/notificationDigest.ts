// Daily notification digest. When a recipient opts into digest mode (per-user pref), low-signal informational
// notifications are parked in `notification_digest_queue` instead of pinging the live feed one-by-one; the
// day-tick calls flushDigests() to coalesce each recipient's queue into ONE summary notification and clear the
// rows. Keeps the feed calm without dropping anything. See domain/notificationConfig.ts isDigestible.
import { inArray } from "drizzle-orm";
import { CODE_WIDTH, allocOwnedCodesFor } from "./codeAlloc";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { runBatch, chunk, insertBatches } from "../lib/dbBatch";

// Park one notification for later digest delivery (best-effort; never throws - a failed park must not break the
// action that triggered it). Called by notify() when the recipient has digest on and the item is digestible.
export async function queueForDigest(deps: Deps, input: { recipientId: string; type: string; title: string; body?: string | null; link?: string | null }): Promise<void> {
  try {
    await deps.db.insert(schema.notificationDigestQueue).values({
      recipientId: input.recipientId,
      type: input.type,
      title: input.title,
      body: input.body?.trim() || null,
      link: input.link?.trim() || null,
    });
  } catch (e) {
    console.error("[digest] queue failed (non-fatal)", e);
  }
}

// Coalesce every recipient's parked notifications into a single summary and clear the queue. Returns the number
// of digests delivered. Best-effort; never throws (a digest failure must not abort the cron tick).
export async function flushDigests(deps: Deps): Promise<number> {
  try {
    const queued = await deps.db
      .select({ uuid: schema.notificationDigestQueue.uuid, recipientId: schema.notificationDigestQueue.recipientId, title: schema.notificationDigestQueue.title, link: schema.notificationDigestQueue.link })
      .from(schema.notificationDigestQueue);
    if (!queued.length) return 0;

    // Group parked items by recipient (preserving insertion order for a readable summary).
    const byRecipient = new Map<string, { title: string; link: string | null }[]>();
    for (const q of queued) {
      const arr = byRecipient.get(q.recipientId) ?? [];
      arr.push({ title: q.title, link: q.link });
      byRecipient.set(q.recipientId, arr);
    }

    // OWNED CODES COME FROM THE COUNTER, like every other notification in the app.
    //
    // This used to compose them itself - read every existing notification for each recipient, take the highest
    // child segment, add one - which is the allocation shape `code_sequences` exists to replace, and it is
    // wrong here in the way that matters: it never BUMPS the counter. `notify` / `notifyMany` take their codes
    // from it (services/notifications.ts), so the sequence still believed N was free after the digest had
    // written it, and the next ordinary notification for that person minted N again ->
    // `UNIQUE constraint failed: notifications.code`.
    //
    // And the failure lands on the wrong side of an atomic batch. The insert and the queue clear go down
    // together (below, deliberately), so one collision rolled BOTH back: no digests delivered, and the queue
    // left full - which the next night re-read, re-collided on, and rolled back again. The outer catch logs it
    // as non-fatal, so digest delivery stops for the whole org and nothing says so louder than a console line.
    //
    // `allocOwnedCodesFor` is the same counter-backed allocator `notifyMany` uses, one batch of indexed bumps
    // for every recipient at once - so this also drops a read of every notification row belonging to every
    // digest recipient, on the table that grows fastest in the app.
    const recipients = [...byRecipient.keys()];
    const empCode = new Map((await deps.db.select({ uuid: schema.employees.uuid, code: schema.employees.code }).from(schema.employees).where(inArray(schema.employees.uuid, recipients))).map((e) => [e.uuid, e.code]));
    const codes = await allocOwnedCodesFor(deps, schema.notifications, schema.notifications.recipientId, recipients, CODE_WIDTH.owned, empCode);

    const rows = recipients.map((rid) => {
      const items = byRecipient.get(rid)!;
      // Deep-link to the single source when everything shares one, else to the notifications feed.
      const links = new Set(items.map((i) => i.link).filter(Boolean));
      const preview = items.slice(0, 5).map((i) => `• ${i.title}`).join("\n");
      const more = items.length > 5 ? `\n…and ${items.length - 5} more.` : "";
      return {
        code: codes.get(rid)!,
        recipientId: rid,
        type: "notification.digest",
        title: `Your daily digest: ${items.length} update${items.length === 1 ? "" : "s"}`,
        body: `${preview}${more}`,
        link: links.size === 1 ? [...links][0] : "notifications",
        priority: "low" as const,
      };
    });

    // Insert the digests AND clear the queue in one atomic batch (one subrequest): a crash between the two
    // used to leave the queue uncleared and re-digest the same items the next night. Chunked per statement
    // under the D1 bound-parameter cap (see notifyMany).
    const ids = queued.map((q) => q.uuid);
    await runBatch(deps.db, [
      ...insertBatches(rows, (c) => deps.db.insert(schema.notifications).values(c)),
      ...chunk(ids, 90).map((c) => deps.db.delete(schema.notificationDigestQueue).where(inArray(schema.notificationDigestQueue.uuid, c))),
    ]);
    return rows.length;
  } catch (e) {
    console.error("[digest] flush failed (non-fatal)", e);
    return 0;
  }
}
