// Provider webhook handler: the inbound edge that flips a document to "signed". Called by the public
// /esign/callback/:provider route (mounted OUTSIDE /v1, so no session auth) - trust comes solely from the
// driver's HMAC signature verification in parseWebhook. Idempotent: a repeat delivery for an already-signed
// document is a no-op. Never throws PII; unknown refs are acked so the vendor stops retrying.
import { eq, and, isNull, inArray } from "drizzle-orm";
import * as schema from "../../db/schema";
import type { Deps } from "../../deps";
import type { AppUser } from "../../env";
import { audit } from "../../lib/audit";
import { notFound, invalidArgument } from "../../lib/errors";
import { getProvider } from "./index";
import { getSettingValue } from "../settings";
import type { EsignSecrets, EsignStatus } from "../../domain/esign";

export type CallbackResult = { ok: boolean; status?: string };

// Apply a normalized provider event to a document row. Shared by the webhook handler and the poll fallback.
// Idempotent (no-op once signedTime is set). Returns the effective status.
async function applyEsignEvent(deps: Deps, providerId: string, row: typeof schema.personalDocuments.$inferSelect, evt: { status: EsignStatus; signedPdf?: Uint8Array }): Promise<EsignStatus> {
  if (row.signedTime) return "signed"; // idempotent: already signed
  // A "signed" event MUST carry the signed PDF. If the vendor said signed but the signed-file fetch failed
  // (parseWebhook/getStatus return signedPdf: undefined on a non-OK/oversized/SSRF-blocked download), do NOT
  // stamp signedTime + locked - that would freeze the row over the UNSIGNED bytes still in R2. Leave it
  // pending so the poll fallback (refreshEsign) retries and picks up the PDF on a later attempt.
  const effective: EsignStatus = evt.status === "signed" && !evt.signedPdf ? "sent" : evt.status;
  const set: Record<string, unknown> = { esignStatus: effective, updatedAt: new Date() };
  if (evt.status === "signed" && evt.signedPdf) {
    await deps.docs.put(row.r2Key, evt.signedPdf, "application/pdf");
    set.sizeBytes = evt.signedPdf.byteLength;
    const emp = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, row.employeeId)).limit(1))[0];
    const name = emp ? (emp.legalName || `${emp.firstName} ${emp.lastName}`).trim() : row.signatureName;
    set.signedTime = new Date();
    set.esignSignedAt = new Date();
    set.signatureName = name;
    set.locked = true;
  } else if (evt.status === "signed") {
    // Signed-but-no-PDF: surface it (observability) so a stuck document is diagnosable; status stays pending.
    console.error(`esign:${providerId} reported signed for document ${row.uuid} but no signed PDF was retrieved; leaving pending for retry`);
  }
  // Guard on signedTime IS NULL so two concurrent webhook deliveries can't both apply (the read-guard above
  // closes most of the window; this closes the rest - the second writer no-ops instead of a duplicate R2
  // put + audit). Safe for the non-signed branches too: signedTime is still null there.
  const applied = await deps.db
    .update(schema.personalDocuments)
    .set(set)
    .where(and(eq(schema.personalDocuments.uuid, row.uuid), isNull(schema.personalDocuments.signedTime)))
    .returning({ uuid: schema.personalDocuments.uuid });
  // The guard above is what makes a redelivery a no-op - but the audit entry and the acknowledgement below
  // were written whether or not it matched, so the loser of that race filed a second "this document was
  // signed" entry for a write it did not make. An e-signature trail that says a thing happened twice is worse
  // than one that says it once, so the rest of this runs only for the writer that actually landed.
  if (!applied.length) return row.signedTime ? "signed" : effective;
  await audit(deps, `esign:${providerId}`, "personal-document.esign", "personal-documents", row.uuid, { status: effective });
  // Per-employee Aadhaar acknowledgement: this signed copy finalizes the linked (pending) ack. Guarded on the
  // ack still being pending so a redelivery/poll is idempotent.
  if (effective === "signed" && set.signedTime && row.ackId) {
    await deps.db.update(schema.documentAcknowledgements)
      .set({ acknowledgedTime: new Date(), signature: (set.signatureName as string) ?? row.signatureName ?? "", updatedAt: new Date() })
      .where(and(eq(schema.documentAcknowledgements.uuid, row.ackId), isNull(schema.documentAcknowledgements.acknowledgedTime)));
  }
  return effective;
}

export async function handleEsignCallback(deps: Deps, providerId: string, headers: Record<string, string>, rawBody: string): Promise<CallbackResult> {
  const provider = getProvider(providerId);
  if (!provider) return { ok: false }; // unknown provider -> 404 at the route

  const secrets: EsignSecrets = deps.esignSecrets?.[providerId] ?? {};
  const evt = await provider.parseWebhook({ headers, rawBody, secrets });
  if (!evt) return { ok: false }; // bad signature / unrecognized payload -> 400 at the route

  // Matched on (provider, ref), not on the ref alone. A request id is the VENDOR'S namespace, so two drivers
  // may legitimately mint the same string - and this route is reached with only the calling provider's own
  // signature verified, which makes "whichever document happens to carry that ref" the wrong row to flip.
  const row = (await deps.db
    .select()
    .from(schema.personalDocuments)
    .where(and(eq(schema.personalDocuments.esignRequestId, evt.providerRef), eq(schema.personalDocuments.esignProvider, providerId)))
    .limit(1))[0];
  if (!row || row.deleteTime) return { ok: true }; // unknown ref: ack so the vendor stops retrying
  const status = await applyEsignEvent(deps, providerId, row, evt);
  return { ok: true, status };
}

// Poll fallback (personal-documents:refreshEsign): ask the provider for the current status of a pending
// document and apply it. For providers without webhooks, or to reconcile a missed delivery. Requires the
// document to have a live e-sign request whose provider exposes getStatus.
export async function refreshEsign(deps: Deps, actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.personalDocuments).where(eq(schema.personalDocuments.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("document not found");
  if (!row.esignProvider || !row.esignRequestId) throw invalidArgument("this document has no e-sign request to refresh");
  const provider = getProvider(row.esignProvider);
  if (!provider?.getStatus) throw invalidArgument(`e-sign provider "${row.esignProvider}" does not support status polling`);
  if (row.signedTime) return row; // already signed, nothing to do
  // Read the esign config through the hardened reader so a malformed settings blob falls back to default
  // instead of throwing a raw 500 (was a bare JSON.parse here).
  const cfg = await getSettingValue<{ providers?: Record<string, Record<string, unknown>> }>(deps, "esign", {});
  const providerCfg = cfg.providers?.[row.esignProvider] ?? {};
  const secrets = deps.esignSecrets?.[row.esignProvider] ?? {};
  const evt = await provider.getStatus(row.esignRequestId, providerCfg, secrets);
  await applyEsignEvent(deps, row.esignProvider, row, evt);
  return (await deps.db.select().from(schema.personalDocuments).where(eq(schema.personalDocuments.uuid, id)).limit(1))[0]!;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ESIGN_EXPIRY_DAYS = 15; // mirrors the vendor cap (cashfree.ts)
/** Documents one nightly reconcile will poll. One vendor round-trip each, against an invocation's subrequest
 *  budget that twenty-odd other subtasks draw on - see the sweep below. Exported for the test that pins it. */
export const RECONCILE_BATCH = 25;

// Scheduled reconcile (daily cron): a webhook can be missed or dropped (stale x-webhook-attempt), leaving a
// document stuck pending forever. Sweep every external-vendor document that is still awaiting signature and
// (a) auto-expire it once past its signing window, or (b) poll the vendor and apply the result. Shares
// applyEsignEvent, so it is idempotent and races safely with a late webhook. Best-effort per row: one vendor
// hiccup never aborts the sweep. Returns the number of documents whose status advanced.
export async function reconcilePendingEsign(deps: Deps): Promise<number> {
  const pending = await deps.db
    .select()
    .from(schema.personalDocuments)
    .where(and(
      isNull(schema.personalDocuments.signedTime),
      isNull(schema.personalDocuments.deleteTime),
      inArray(schema.personalDocuments.esignStatus, ["sent", "viewed"]),
    ))
    // BOUNDED PER TICK. Every row here costs an outbound vendor call, and a Worker invocation has a fixed
    // subrequest budget it shares with the other twenty-odd nightly subtasks - so an unbounded sweep over a
    // backlog spent the budget, and the per-row catch below swallowed the resulting failures as "no progress".
    // A pending document is reconciled a day later at worst, and the backlog drains over consecutive nights;
    // oldest first, so nothing at the back of the queue is starved by a steady trickle of new requests.
    .orderBy(schema.personalDocuments.esignSentAt)
    .limit(RECONCILE_BATCH);
  if (pending.length === 0) return 0;
  const cfg = await getSettingValue<{ providers?: Record<string, Record<string, unknown>> }>(deps, "esign", {});
  const now = +deps.clock.now();
  let advanced = 0;
  for (const row of pending) {
    // Only external vendors reconcile here: `internal` signs in-app (:sign), and a row with no provider/ref
    // has no vendor request to poll.
    if (!row.esignProvider || row.esignProvider === "internal" || !row.esignRequestId) continue;
    const provider = getProvider(row.esignProvider);
    if (!provider?.getStatus) continue;
    const providerCfg = cfg.providers?.[row.esignProvider] ?? {};
    const secrets = deps.esignSecrets?.[row.esignProvider] ?? {};
    try {
      // Auto-expire past the signing window (the same expiry we told the vendor). Don't lock - HR can re-issue.
      const rawExpiry = Number(providerCfg.expiry_days);
      const expiryDays = Number.isFinite(rawExpiry) && rawExpiry > 0 ? Math.min(MAX_ESIGN_EXPIRY_DAYS, rawExpiry) : 7;
      const sentAt = row.esignSentAt ? +new Date(row.esignSentAt) : 0;
      if (sentAt && now - sentAt > expiryDays * DAY_MS) {
        await deps.db.update(schema.personalDocuments)
          .set({ esignStatus: "expired", updatedAt: new Date() })
          .where(and(eq(schema.personalDocuments.uuid, row.uuid), isNull(schema.personalDocuments.signedTime)));
        await audit(deps, "esign:cron", "personal-document.esign", "personal-documents", row.uuid, { status: "expired" });
        advanced++;
        continue;
      }
      const evt = await provider.getStatus(row.esignRequestId, providerCfg, secrets);
      const status = await applyEsignEvent(deps, row.esignProvider, row, evt);
      if (status !== row.esignStatus) advanced++;
    } catch {
      // Best-effort: a vendor outage on one row must not abort the sweep. It retries next tick.
    }
  }
  return advanced;
}
