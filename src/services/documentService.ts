// Factory for the two document resources (org-documents, personal-documents). NO access control here:
// the middleware gates each resource by path + grants (prime directive: private by default). The only
// difference between the two is the code allocation (flat vs owner-embedded) and the owner column.
import { allocOwnedCode, allocFlatCode } from "./codeAlloc";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import { eq, and, inArray, isNull, type SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, createdMeta, diffMeta } from "../lib/audit";
import { invalidArgument, notFound, forbidden, failedPrecondition, isDocumentAckDuplicate } from "../lib/errors";
import { keysetPage } from "./keysetPage";
import { etagOf } from "../http/serialize";
import { softDeleteRow, restoreRow, purgeRow } from "./softDelete";
import { hasPrintVersion } from "./letterheads";
import { assertNotLocked } from "./lifecycle";
import { genId } from "../lib/idCodec";
import { VALID_DOC_TYPES, idFromPath, isAllowedUpload, isPdfUpload, assertUploadSize, documentFileName, storedContentType, type DocumentInput, type DocType } from "./documentsCommon";
import { notifyAudience, type Audience } from "./notifications";
import { emitEvent } from "./eventBus";
import { getSettingValue } from "./settings";
import { readIdentityValues } from "./identityDetails";
import { getProvider, assertProviderConfigured } from "./esign";
import { DEFAULT_ESIGN, type EsignConfig } from "../domain/esign";
import { stampSignature, type SignAnchor } from "../lib/pdfStamp";
import { orgToday } from "./orgDay";
import { checkEtag, updateAtVersion, type VersionedRow } from "./versionGuard";

// Audience the publisher picked for an org-document (refs are wire-decoded inbound to internal ids).
type NotifyAudienceInput = { kind: "everyone" | "department" | "employees" | "none"; department?: string | null; employees?: string[] };

type Cfg = { table: any; collection: string; singular: string; owned: boolean; acknowledgeable?: boolean };
// Personal-document create carries an `employee` owner ref (gated by the middleware owner-ref, P1.5).
// `requires_ack` (org-documents only) toggles the acknowledgement requirement.
type CreateInput = DocumentInput & { employee?: string | null; requires_ack?: boolean; ack_method?: "internal" | "cashfree" | null; sign_anchor?: SignAnchor | null; published?: boolean; notify_audience?: NotifyAudienceInput };

// Expiry in, as a Date or nothing. `new Date(...)` on its own turns anything unparseable into an Invalid
// Date, which the timestamp_ms column then stores as NaN - a row whose expiry no reader can compare. Reject
// it at the door instead, the way apiKeys.ts does. A bare YYYY-MM-DD parses to UTC midnight on that day,
// which is exactly what the wire contract asks writers to send.
function parseExpireTime(value: string): Date {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw invalidArgument("expire_time must be an RFC 3339 timestamp");
  return new Date(ms);
}

// An ack-required org document must declare how it's signed (method) and where (a single box). Validate the
// pair together so a doc can never require acknowledgement without a placement.
function validateAckConfig(requiresAck: boolean, method?: string | null, anchor?: SignAnchor | null) {
  if (!requiresAck) return;
  if (method !== "internal" && method !== "cashfree") throw invalidArgument("ack_method must be \"internal\" or \"cashfree\" when the document requires acknowledgement");
  const a = anchor;
  if (!a || [a.page, a.x1, a.y1, a.x2, a.y2].some((n) => typeof n !== "number" || !Number.isFinite(n)))
    throw invalidArgument("sign_anchor (page + box coordinates) is required when the document requires acknowledgement");
}

export function makeDocumentService(cfg: Cfg) {
  const { table, collection, singular, owned, acknowledgeable = false } = cfg;
  const ownerCol = owned ? table.employeeId : table.code; // personal -> employee_id; org has no owner

  async function loadRow(deps: Deps, id: string) {
    return (await deps.db.select().from(table).where(eq(table.uuid, id)).limit(1))[0];
  }

  // Attach the caller's acknowledged version per document, so the serializer can derive `acknowledged`. One
  // read for the whole page; no-op when the collection isn't acknowledgeable or the caller has no employee.
  async function decorateAck(deps: Deps, actor: AppUser | undefined, rows: any[]): Promise<any[]> {
    if (!acknowledgeable || !actor?.employeeId || rows.length === 0) return rows;
    const ids = new Set(rows.map((r) => r.uuid));
    const acks = await deps.db.select().from(schema.documentAcknowledgements).where(eq(schema.documentAcknowledgements.employeeId, actor.employeeId));
    const byDoc = new Map<string, number>();
    // Only a COMPLETED ack counts (acknowledgedTime set). A pending Aadhaar ack (copy created, awaiting the
    // signer) must not mark the document acknowledged.
    for (const a of acks) if (!a.deleteTime && a.acknowledgedTime && ids.has(a.documentId)) byDoc.set(a.documentId, Math.max(byDoc.get(a.documentId) ?? 0, a.version));
    return rows.map((r) => ({ ...r, ackedVersion: byDoc.get(r.uuid) ?? 0 }));
  }

  /**
   * Flag the documents whose letterhead has a PRINT version, so the UI can offer the two downloads as a
   * choice and otherwise offer one button. One query for the whole page, keyed off the letterhead id stamped
   * on each row at generation - no R2 read, and nothing at all when the page holds no generated documents.
   */
  async function decoratePrint(deps: Deps, rows: any[]): Promise<any[]> {
    const ids = [...new Set(rows.map((r) => r.letterheadId).filter((x): x is string => !!x))];
    if (ids.length === 0) return rows;
    const heads = await deps.db.select().from(schema.letterheads).where(inArray(schema.letterheads.uuid, ids));
    const withPrint = new Set(heads.filter((h) => hasPrintVersion(h)).map((h) => h.uuid));
    return rows.map((r) => ({ ...r, printVariant: !!r.letterheadId && withPrint.has(r.letterheadId) }));
  }

  const decorate = async (deps: Deps, actor: AppUser | undefined, rows: any[]) => decoratePrint(deps, await decorateAck(deps, actor, rows));

  /**
   * `employee` narrows an OWNED collection to one person's documents. Without it a caller who can see everyone
   * has to read a page of the whole org to find one person's file, and the row they want is as likely as not
   * past the page cursor - which is how "has this letter already been written for them?" answered no for the
   * hundred-and-first document in the org. It only ever narrows: the scope is applied first and still decides
   * what the caller may see at all.
   */
  async function list(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, showDeleted = false, actor?: AppUser, employee?: string) {
    const scoped = applyScope(scope, table.code, ownerCol);
    const employeeId = owned ? idFromPath(employee) : undefined;
    // Paged in SQL (services/keysetPage.ts), soft-delete filter included. This one list backs every document
    // collection in the app (personal, org, offer, letter...), and it used to read every row the scope
    // matched into the isolate to slice fifty out of it - the exact cost the `employee` narrowing above was
    // added to avoid, still being paid by every caller who does not pass one.
    const conds = [scoped, employeeId ? eq(table.employeeId, employeeId) : undefined, showDeleted ? undefined : isNull(table.deleteTime)];
    const page = await keysetPage<any>(deps, table, collection, and(...(conds.filter(Boolean) as SQL[])), { dir: "desc", max: maxPageSize, pageToken });
    return { items: await decorate(deps, actor, page.items), nextPageToken: page.nextPageToken };
  }

  async function get(deps: Deps, actor: AppUser, id: string) {
    const row = await loadRow(deps, id); // access already enforced by the middleware on this path
    if (!row || row.deleteTime) throw notFound(`${singular} not found`);
    return (await decorate(deps, actor, [row]))[0];
  }

  async function create(deps: Deps, actor: AppUser, input: CreateInput, id?: string) {
    if (!input.display_name) throw invalidArgument("display_name is required");
    if (!input.document_type) throw invalidArgument("document_type is required");
    if (!VALID_DOC_TYPES.includes(input.document_type as DocType)) throw invalidArgument("invalid document_type");
    const docId = id ?? genId(); // compact wire-encodable id (matches every other table), not a raw UUID
    const r2Key = `${collection}/${docId}`;
    const base: Record<string, unknown> = {
      uuid: docId,
      documentType: input.document_type as DocType,
      title: input.display_name,
      r2Key,
      contentType: input.content_type?.trim() || null,
      sizeBytes: input.size_bytes ?? null,
      expireTime: input.expire_time ? parseExpireTime(input.expire_time) : null,
    };
    if (acknowledgeable && input.requires_ack !== undefined) base.requiresAck = !!input.requires_ack;
    if (acknowledgeable && !!input.requires_ack) {
      validateAckConfig(true, input.ack_method, input.sign_anchor);
      base.ackMethod = input.ack_method;
      base.signAnchorJson = JSON.stringify(input.sign_anchor);
      // When this version started asking for signatures - the clock the chase-up reminders age off.
      base.ackVersionTime = new Date();
    }
    // Published by default (the column default); the uploader can create it as a draft instead.
    if (input.published !== undefined) base.published = !!input.published;
    if (owned) {
      const employeeId = idFromPath(input.employee) ?? actor.employeeId;
      if (!employeeId) throw invalidArgument("employee is required");
      base.employeeId = employeeId;
      base.code = await allocOwnedCode(deps, table, table.employeeId, employeeId);
    } else {
      base.code = await allocFlatCode(deps, table);
    }
    const row = (await deps.db.insert(table).values(base).returning() as any[])[0]!;
    await audit(deps, actor, `${singular}.create`, collection, row.uuid, createdMeta(row, collection), row);
    // Org documents can fan a notification to a chosen audience on publish. If acknowledgement is required it's
    // an ACTION item ("review & sign"), at the configured `document` priority (high by default).
    if (acknowledgeable && base.published !== false && input.notify_audience && input.notify_audience.kind !== "none") {
      const a = input.notify_audience;
      const audience: Audience =
        a.kind === "everyone" ? { kind: "everyone" }
        : a.kind === "department" && a.department ? { kind: "department", department: idFromPath(a.department)! }
        : a.kind === "employees" ? { kind: "employees", employees: (a.employees ?? []).map((e) => idFromPath(e)!).filter(Boolean) }
        : { kind: "none" };
      const ack = !!base.requiresAck;
      await notifyAudience(
        deps,
        audience,
        {
          type: ack ? "document.ackRequired" : "document.published",
          title: ack ? `Review & sign: ${input.display_name}` : `New document: ${input.display_name}`,
          body: ack ? "This document requires your acknowledgement." : input.display_name,
          link: "documents",
          action: ack ? "sign" : null,
        },
        actor.employeeId,
      );
    }
    // Announce the publish on the event bus (org-documents only) so automations can react (e.g. the policy-
    // acknowledgement reminder). Personal documents aren't acknowledgeable and don't publish org-wide.
    if (acknowledgeable && base.published !== false) {
      await emitEvent(deps, actor, "document.published", { subject: `${collection}/${row.uuid}`, payload: { requiresAck: !!base.requiresAck } });
    }
    return row;
  }

  async function update(deps: Deps, actor: AppUser, id: string, patch: CreateInput, ifMatch?: string) {
    const row = await loadRow(deps, id);
    if (!row || row.deleteTime) throw notFound(`${singular} not found`);
    assertNotLocked(row);
    checkEtag(row as VersionedRow, ifMatch);
    const set: Record<string, unknown> = { updatedAt: new Date() };
    const has = (k: keyof CreateInput) => Object.prototype.hasOwnProperty.call(patch, k);
    if (has("display_name")) set.title = patch.display_name;
    if (has("document_type")) set.documentType = patch.document_type;
    if (has("content_type")) set.contentType = patch.content_type?.trim() || null;
    if (has("size_bytes")) set.sizeBytes = patch.size_bytes ?? null;
    if (has("expire_time")) set.expireTime = patch.expire_time ? parseExpireTime(patch.expire_time) : null;
    if (acknowledgeable && has("requires_ack")) {
      // Turning ack on demands a PDF source (the signature is stamped in place on it). Block it if a
      // non-PDF file is already attached; with no file yet, the later upload enforces it.
      if (patch.requires_ack && row.sizeBytes && !isPdfUpload(row.fileName ?? undefined, row.contentType ?? undefined))
        throw invalidArgument("a document that requires acknowledgement must be a PDF; replace the file with a PDF first");
      set.requiresAck = !!patch.requires_ack;
    }
    if (acknowledgeable) {
      // Resolve the effective ack config after this patch and validate the method+anchor pair together.
      const willRequire = has("requires_ack") ? !!patch.requires_ack : !!row.requiresAck;
      const method = has("ack_method") ? patch.ack_method : (row.ackMethod as "internal" | "cashfree" | null);
      const anchor = has("sign_anchor") ? patch.sign_anchor : (row.signAnchorJson ? (JSON.parse(row.signAnchorJson) as SignAnchor) : null);
      if (willRequire) validateAckConfig(true, method, anchor);
      if (has("ack_method")) set.ackMethod = willRequire ? patch.ack_method : null;
      if (has("sign_anchor")) set.signAnchorJson = willRequire && patch.sign_anchor ? JSON.stringify(patch.sign_anchor) : null;
      if (has("requires_ack") && !patch.requires_ack) { set.ackMethod = null; set.signAnchorJson = null; set.ackVersionTime = null; }
      // Switching acknowledgement ON starts the chase-up clock; a row that already required it keeps its own.
      if (has("requires_ack") && patch.requires_ack && !row.requiresAck) set.ackVersionTime = new Date();
    }
    const updated = await updateAtVersion(deps, table, singular, row as VersionedRow, set);
    await audit(deps, actor, `${singular}.update`, collection, id, diffMeta(row, updated, set, collection), updated);
    return updated;
  }

  const del = (deps: Deps, actor: AppUser, id: string, ifMatch?: string) => softDeleteRow(deps, actor, table, singular, collection, id, ifMatch);
  const restore = (deps: Deps, actor: AppUser, id: string) => restoreRow(deps, actor, table, singular, collection, id);
  const purge = (deps: Deps, actor: AppUser, id: string, ifMatch?: string) =>
    purgeRow(deps, actor, table, singular, collection, id, ifMatch, async (row) => {
      const key = row.r2Key as string;
      await deps.docs.delete(key);
      // AND THE FROZEN CONTENT BESIDE IT. Every generated letter and Form 16 writes a second object,
      // `<key>.content` - the fully resolved LetterContent, so `:print` and the in-place e-sign can re-render
      // (services/letterPrint.ts freezeLetterContent). The purge took only the PDF, so the irreversible,
      // admin-gated hard delete left the sidecar in the bucket permanently: unreferenced by any row, and
      // therefore unreachable by any later purge, cascade or retention sweep. For a salary or increment letter
      // that object is the resolved CTC annexure and for a Form 16 the annual gross and tax - and "purge" is
      // the operation this app documents as the one that actually erases.
      //
      // Tolerant, because most documents are uploads and have no sidecar: a missing object must not fail a
      // purge whose real work (the row and the PDF) is already done.
      await deps.docs.delete(`${key}.content`).catch(() => {});
    });

  async function upload(deps: Deps, actor: AppUser, id: string, bytes: ArrayBuffer, opts: { fileName?: string; contentType?: string } = {}) {
    const row = await loadRow(deps, id);
    if (!row || row.deleteTime) throw notFound(`${singular} not found`);
    assertUploadSize(bytes.byteLength);
    if (!isAllowedUpload(opts.fileName, opts.contentType))
      throw invalidArgument("unsupported file type; allowed: documents, spreadsheets, presentations, images");
    // A document requiring acknowledgement must be a PDF (the signature is stamped in place onto it).
    if (acknowledgeable && row.requiresAck && !isPdfUpload(opts.fileName, opts.contentType))
      throw invalidArgument("a document that requires acknowledgement must be a PDF");
    // Normalized, never the raw header: this column is echoed into the download's `Content-Type` (see the
    // `download` lane below), so the caller must not get to name the type their own bytes come back as.
    // See services/documentsCommon.ts#storedContentType.
    const ct = opts.contentType ? storedContentType(opts.contentType) : row.contentType || "application/octet-stream";
    await deps.docs.put(row.r2Key, bytes, ct);
    const set: Record<string, unknown> = { sizeBytes: bytes.byteLength, contentType: ct, fileName: opts.fileName ?? row.fileName ?? null, updatedAt: new Date() };
    // Replacing the file of a document that requires acknowledgement is a NEW version: bump so everyone re-signs.
    if (acknowledgeable && row.requiresAck) { set.ackVersion = (row.ackVersion ?? 1) + 1; set.ackVersionTime = new Date(); }
    const updated = (await deps.db.update(table).set(set).where(eq(table.uuid, id)).returning() as any[])[0]!;
    await audit(deps, actor, `${singular}.upload`, collection, id, { size_bytes: bytes.byteLength });
    return updated;
  }

  // Record the caller's acknowledgement of the current version. Two methods, chosen per-document:
  //  - "internal": stamp the employee's on-file signature image onto the policy PDF at the doc's box, file the
  //    signed copy, and complete the ack synchronously.
  //  - "cashfree": create a per-employee copy + an Aadhaar e-sign request; the ack stays PENDING and is
  //    finalized by the e-sign webhook/poll (applyEsignEvent) when the copy is signed. Returns the signing link.
  // Idempotent per (doc, employee, version). Returns the document decorated with ackedVersion (+ esignUri for a
  // pending Aadhaar ack) so the UI reflects state immediately.
  async function acknowledge(deps: Deps, actor: AppUser, id: string) {
    if (!acknowledgeable) throw invalidArgument("this document type cannot be acknowledged");
    const row = await loadRow(deps, id);
    if (!row || row.deleteTime) throw notFound(`${singular} not found`);
    if (!row.requiresAck) throw invalidArgument("this document does not require acknowledgement");
    const employeeId = actor.employeeId;
    if (!employeeId) throw invalidArgument("only an employee can acknowledge a document");
    const emp = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, employeeId)).limit(1))[0];
    if (!emp) throw notFound("employee not found");

    const version = row.ackVersion ?? 1;
    const method: "internal" | "cashfree" = row.ackMethod === "cashfree" ? "cashfree" : "internal";
    const anchor = JSON.parse(row.signAnchorJson ?? "null") as SignAnchor | null;
    if (!anchor) throw failedPrecondition("this document has no signature placement configured");
    // Legal name on file is the attestation (not a value the signer can alter).
    const legalName = (emp.legalName || `${emp.firstName} ${emp.lastName}`).trim();

    // Idempotency per (doc, employee, version) is the UNIQUE index `dack_once_idx`; this read is only the
    // probe in front of it, so the ordinary "already signed" answer costs no write (services/compOff.ts
    // splits the same way, and says why the index rather than the read is what makes it true). It narrows by
    // EMPLOYEE in SQL: an org-wide policy collects one row per employee per version, so matching in JS meant
    // reading the whole company's acknowledgements - every version of them - on the one path everybody walks.
    // `dack_emp_idx` serves this; the version/delete filter stays in JS over the one or two rows it returns.
    const findAck = async () =>
      (await deps.db.select().from(schema.documentAcknowledgements).where(and(
        eq(schema.documentAcknowledgements.documentId, id),
        eq(schema.documentAcknowledgements.employeeId, employeeId),
      ))).find((a) => a.version === version && !a.deleteTime);
    // A completed ack short-circuits; a still-pending Aadhaar ack re-returns its signing link so the employee
    // can resume rather than starting a duplicate request.
    const ackResult = async (a: { acknowledgedTime: Date | null; signedDocId: string | null }) => {
      if (a.acknowledgedTime) return { ...row, ackedVersion: version };
      const copy = a.signedDocId ? (await deps.db.select().from(schema.personalDocuments).where(eq(schema.personalDocuments.uuid, a.signedDocId)).limit(1))[0] : undefined;
      return { ...row, ackedVersion: 0, esignUri: copy?.esignUri ?? undefined };
    };
    const existing = await findAck();
    if (existing) return ackResult(existing);

    // Claim the acknowledgement BEFORE any of the work it authorises - the stamped copy, the personal-document
    // row, and on the vendor lane a paid e-sign transaction. The index decides who won, so the same person in
    // two tabs (or the Aadhaar path resuming its own pending ack) gets one signed copy and one signing link
    // instead of two. Each caller allocates its own `code`, and a collision on THAT is a different answer -
    // look again - so it is left to propagate as the retryable 409 the error handler already makes of it.
    const claimAck = async () => {
      try {
        return (await deps.db.insert(schema.documentAcknowledgements).values({
          code: await allocOwnedCode(deps, schema.documentAcknowledgements, schema.documentAcknowledgements.employeeId, employeeId),
          // signedDocId/acknowledgedTime are filled in once the copy exists; a null row is a pending ack.
          employeeId, documentId: id, version, signature: legalName,
        }).returning() as any[])[0]! as typeof schema.documentAcknowledgements.$inferSelect;
      } catch (e) {
        if (!isDocumentAckDuplicate(e)) throw e;
        return null;
      }
    };
    // The loser of that race reads the winner's row and answers from it, which is the same answer the probe
    // above gives - "you have already acknowledged this" - rather than an error the employee cannot act on.
    const lost = async () => {
      const won = await findAck();
      if (won) return ackResult(won);
      throw failedPrecondition("this document has already been acknowledged");
    };

    const orgBuf = await deps.docs.get(row.r2Key);
    if (!orgBuf) throw failedPrecondition(`${singular} file not found in storage`);
    const orgBytes = new Uint8Array(orgBuf);
    const copyId = genId();
    const copyKey = `personal-documents/${copyId}`;
    const copyTitle = `${row.title} - signed (v${version})`;
    // The copy is generated, not uploaded, so give it a file name explicitly (title + .pdf) - otherwise it
    // downloads without an extension.
    const copyFileName = documentFileName({ title: copyTitle, contentType: "application/pdf" });

    if (method === "internal") {
      // The on-file signature image is mandatory (it is what gets stamped). Employee uploads it on their profile.
      if (!emp.signatureKey) throw failedPrecondition("upload a signature image to your profile before acknowledging documents");
      const sigBuf = await deps.docs.get(emp.signatureKey);
      const ack = await claimAck();
      if (!ack) return lost();
      try {
        // The date printed ON the signature is the ORG's calendar day, not UTC. Deriving a "today" from the
        // UTC clock is wrong everywhere (services/orgDay.ts explains why the app moved off it), and worst
        // here: the stamp is baked into a PDF that is then LOCKED, so an acknowledgement signed before 05:30
        // in IST carried yesterday's date on the face of the document, for good, on the one record whose
        // whole purpose is to say when somebody signed. services/letterSign.ts signs the same way.
        const stamped = await stampSignature(orgBytes, sigBuf ? new Uint8Array(sigBuf) : undefined, anchor, { name: legalName, date: await orgToday(deps) });
        await deps.docs.put(copyKey, stamped, "application/pdf");
        await deps.db.insert(schema.personalDocuments).values({
          uuid: copyId, code: await allocOwnedCode(deps, schema.personalDocuments, schema.personalDocuments.employeeId, employeeId),
          employeeId, documentType: "POLICY", title: copyTitle, fileName: copyFileName, r2Key: copyKey, contentType: "application/pdf", sizeBytes: stamped.byteLength,
          sourceDocId: id, published: true, signedTime: new Date(), signatureName: legalName, locked: true,
        });
        await deps.db.update(schema.documentAcknowledgements).set({ signedDocId: copyId, acknowledgedTime: new Date() })
          .where(eq(schema.documentAcknowledgements.uuid, ack.uuid));
      } catch (e) {
        // Unwind so a failure part-way leaves nothing holding the claim - the index would otherwise refuse
        // the retry and the employee could never sign - and no orphan copy. Each step is best-effort.
        await deps.docs.delete(copyKey).catch(() => {});
        await deps.db.delete(schema.personalDocuments).where(eq(schema.personalDocuments.uuid, copyId)).catch(() => {});
        await deps.db.delete(schema.documentAcknowledgements).where(eq(schema.documentAcknowledgements.uuid, ack.uuid)).catch(() => {});
        throw e;
      }
      await audit(deps, actor, "document.acknowledge", collection, id, { version, method });
      return { ...row, ackedVersion: version };
    }

    // cashfree: create the copy + a PENDING ack, fire the Aadhaar e-sign request, return the signing link.
    const providerId = "cashfree";
    const provider = getProvider(providerId);
    if (!provider) throw failedPrecondition(`e-sign provider "${providerId}" is not available`);
    assertProviderConfigured(provider, deps.esignSecrets?.[providerId]);
    const cfg = await getSettingValue<EsignConfig>(deps, "esign", DEFAULT_ESIGN);
    const aadhaar = (await readIdentityValues(deps, emp)).aadhaar;
    if (provider.requiresAadhaar && !aadhaar) throw failedPrecondition("this employee has no Aadhaar on file; cannot request Aadhaar e-sign");
    const signer = { name: legalName, email: emp.workEmail ?? undefined, aadhaar };

    // Claimed before the R2 put and the vendor call, which is the whole point on this lane: `createRequest`
    // is a paid transaction and a second signing link to somebody who only agreed to sign once.
    const ack = await claimAck();
    if (!ack) return lost();

    await deps.docs.put(copyKey, orgBytes, "application/pdf");
    // The ack and its signed copy reference each other (ack.signedDocId <-> copy.ackId), a circular FK that
    // SQLite/D1 enforce per-statement. The ack above went in WITHOUT signedDocId; insert the copy carrying
    // ackId, then backfill ack.signedDocId - neither row can name the other at insert time.
    await deps.db.insert(schema.personalDocuments).values({
      uuid: copyId, code: await allocOwnedCode(deps, schema.personalDocuments, schema.personalDocuments.employeeId, employeeId),
      employeeId, documentType: "POLICY", title: copyTitle, fileName: copyFileName, r2Key: copyKey, contentType: "application/pdf", sizeBytes: orgBytes.byteLength,
      sourceDocId: id, ackId: ack.uuid, requiresSignature: true, esignProvider: providerId, published: true,
    });
    await deps.db.update(schema.documentAcknowledgements).set({ signedDocId: copyId }).where(eq(schema.documentAcknowledgements.uuid, ack.uuid));
    let res;
    try {
      res = await provider.createRequest({
        pdf: orgBytes, fileName: documentFileName({ ...row, contentType: "application/pdf" }), docId: copyId,
        signers: [signer], signAnchors: [anchor],
        cfg: cfg.providers?.[providerId] ?? {}, secrets: deps.esignSecrets?.[providerId] ?? {},
      });
    } catch (e) {
      // Unwind so a vendor outage leaves no orphan copy/ack. Break the circular FK first (null the ack's
      // signedDocId) so the copy row can be deleted, then delete both. Each step is best-effort.
      await deps.docs.delete(copyKey).catch(() => {});
      await deps.db.update(schema.documentAcknowledgements).set({ signedDocId: null }).where(eq(schema.documentAcknowledgements.uuid, ack.uuid)).catch(() => {});
      await deps.db.delete(schema.personalDocuments).where(eq(schema.personalDocuments.uuid, copyId)).catch(() => {});
      await deps.db.delete(schema.documentAcknowledgements).where(eq(schema.documentAcknowledgements.uuid, ack.uuid)).catch(() => {});
      // Surface a vendor/config failure as an actionable error, not a raw 500. (createRequest messages are
      // generic - no secrets.)
      throw failedPrecondition(`Aadhaar e-sign request failed: ${(e as Error).message ?? "unknown error"}`);
    }
    await deps.db.update(schema.personalDocuments)
      .set({ esignRequestId: res.providerRef, esignStatus: res.status, esignUri: res.signUrl ?? null, esignSentAt: new Date() })
      .where(eq(schema.personalDocuments.uuid, copyId));
    await audit(deps, actor, "document.acknowledge", collection, id, { version, method, pending: true });
    return { ...row, ackedVersion: 0, esignUri: res.signUrl ?? undefined };
  }

  async function download(deps: Deps, _actor: AppUser, id: string) {
    const row = await loadRow(deps, id);
    if (!row || row.deleteTime) throw notFound(`${singular} not found`);
    const bytes = await deps.docs.get(row.r2Key);
    if (!bytes) throw notFound(`${singular} file not found in storage`);
    return { bytes, contentType: row.contentType ?? "application/octet-stream", fileName: documentFileName(row) };
  }

  return { list, get, create, update, del, restore, purge, upload, download, acknowledge };
}
