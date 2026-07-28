// Daily notification digest. When a recipient opts into digest mode (per-user pref), low-signal informational
// notifications are parked in `notification_digest_queue` instead of pinging the live feed one-by-one; the
// day-tick calls flushDigests() to coalesce each recipient's queue into ONE summary notification and clear the
// rows. Keeps the feed calm without dropping anything. See domain/notificationConfig.ts isDigestible.
import { inArray } from "drizzle-orm";
import { CODE_WIDTH } from "./codeAlloc";
import { nextChildCode } from "../domain/codes";
import * as schema from "../db/schema";
import type { Deps } from "../deps";

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

    // Sibling codes for owned-code allocation, one read across all recipients.
    const recipients = [...byRecipient.keys()];
    const empCode = new Map((await deps.db.select({ uuid: schema.employees.uuid, code: schema.employees.code }).from(schema.employees).where(inArray(schema.employees.uuid, recipients))).map((e) => [e.uuid, e.code]));
    const existing = await deps.db.select({ recipientId: schema.notifications.recipientId, code: schema.notifications.code }).from(schema.notifications).where(inArray(schema.notifications.recipientId, recipients));
    const siblings = new Map<string, (string | null)[]>();
    for (const r of existing) { const a = siblings.get(r.recipientId) ?? []; a.push(r.code); siblings.set(r.recipientId, a); }

    const rows = recipients.map((rid) => {
      const items = byRecipient.get(rid)!;
      // Deep-link to the single source when everything shares one, else to the notifications feed.
      const links = new Set(items.map((i) => i.link).filter(Boolean));
      const preview = items.slice(0, 5).map((i) => `• ${i.title}`).join("\n");
      const more = items.length > 5 ? `\n…and ${items.length - 5} more.` : "";
      return {
        code: nextChildCode(siblings.get(rid) ?? [], empCode.get(rid) ?? null, CODE_WIDTH.owned),
        recipientId: rid,
        type: "notification.digest",
        title: `Your daily digest: ${items.length} update${items.length === 1 ? "" : "s"}`,
        body: `${preview}${more}`,
        link: links.size === 1 ? [...links][0] : "notifications",
        priority: "low" as const,
      };
    });

    const CHUNK = 8; // D1 bound-parameter cap (see notifyMany).
    for (let i = 0; i < rows.length; i += CHUNK) await deps.db.insert(schema.notifications).values(rows.slice(i, i + CHUNK));
    // Clear the flushed rows.
    const ids = queued.map((q) => q.uuid);
    for (let i = 0; i < ids.length; i += 90) await deps.db.delete(schema.notificationDigestQueue).where(inArray(schema.notificationDigestQueue.uuid, ids.slice(i, i + 90)));
    return rows.length;
  } catch (e) {
    console.error("[digest] flush failed (non-fatal)", e);
    return 0;
  }
}
