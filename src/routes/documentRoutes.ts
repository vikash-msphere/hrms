import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { contentDisposition } from "../http/contentDisposition";
import { signLetter } from "../services/letterSign";
import { printDocument } from "../services/letterPrint";
import { remindAckPending } from "../services/documentAck";
import { refreshEsign } from "../services/esign/callback";
import type { makeDocumentService } from "../services/documentService";

// The shared spec for a document resource - org-wide or personal. NO access checks: the middleware gates the
// path by grants. `employee` applies to personal-documents only (org ignores it).
const writeSchema = z.object({
  employee: z.string().nullable().optional(),
  // The full set from services/documentsCommon.ts VALID_DOC_TYPES - FORM16 included. It is the type the
  // dedicated Form 16 routes write, and openapi.yaml has always published it here, so leaving it out of the
  // request schema made a document the app files itself impossible to file over the wire.
  document_type: z.enum(["CONTRACT", "ID", "PAYSLIP", "POLICY", "LETTER", "FORM16", "INSURANCE", "OTHER"]).optional(),
  display_name: z.string().min(1).optional(),
  content_type: z.string().nullable().optional(),
  size_bytes: z.number().int().nullable().optional(),
  expire_time: z.string().nullable().optional(),
  requires_ack: z.boolean().optional(), // org-documents only; ignored by personal-documents
  // org-documents only: how ack is signed + where the signature lands. Required together with requires_ack
  // (enforced in the service). ack_method picks the signing path; sign_anchor is a single box (PDF points).
  ack_method: z.enum(["internal", "cashfree"]).nullable().optional(),
  sign_anchor: z
    .object({ page: z.number(), x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() })
    .nullable()
    .optional(),
  published: z.boolean().optional(), // create as draft (false) instead of the published default
  // org-documents only: who to notify on publish (everyone / a department / specific employees). If the doc
  // requires acknowledgement, the notification is an action item ("review & sign").
  notify_audience: z
    .object({
      kind: z.enum(["everyone", "department", "employees", "none"]),
      department: z.string().nullable().optional(),
      employees: z.array(z.string()).optional(),
    })
    .optional(),
}).strict();

type Svc = ReturnType<typeof makeDocumentService>;
type DocWrite = z.infer<typeof writeSchema>;
type LcCfg = { table: any; singular: string; collection: string };

// One document collection, built from the shared lane. Every standard method is the document service's own
// (R2 keys, ack copies and the owner rules live there), so this is an all-overrides spec - what the factory
// still supplies is the one paging/If-Match/hint implementation, the lifecycle verbs the table's columns earn,
// and the verb dispatch.
export function makeDocumentRoutes(lc: LcCfg, svc: Svc, serialize: (r: any) => any) {
  return collectionRoutes<DocWrite, LcCfg["table"]>({
    table: lc.table,
    collection: lc.collection,
    auditName: lc.singular,
    notFound: `${lc.singular} not found`,
    param: "id",
    writeSchema,
    serialize,
    publish: true,
    overrides: {
      get: (deps, actor, id) => svc.get(deps, actor, id),
      create: (deps, actor, input, id) => svc.create(deps, actor, input, id),
      update: (deps, actor, id, patch, ifMatch) => svc.update(deps, actor, id, patch, ifMatch),
      remove: (deps, actor, id, ifMatch) => svc.del(deps, actor, id, ifMatch),
      purge: (deps, actor, id, ifMatch) => svc.purge(deps, actor, id, ifMatch),
      restore: (deps, actor, id) => svc.restore(deps, actor, id),
    },
    // `?employee=employees/<id>` narrows personal-documents to one person (org-documents have no owner and
    // ignore it). The ref arrives already wire-decoded, like every other inbound ref.
    list: (c, page) => svc.list(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, page.showDeleted, c.get("user"), c.req.query("employee") || undefined),
    verbs: {
      // The signatory name comes from the employee's legal name on file (not the request) - see the service.
      acknowledge: { run: (deps, user, id) => svc.acknowledge(deps, user, id) },
      // Chase the outstanding signatures on a policy: everyone still pending, or one person (org-documents
      // only; the service rejects a document that doesn't require acknowledgement).
      remindAck: {
        schema: z.object({ employee: z.string().nullable().optional() }).strict(),
        run: (deps, user, id, body) => remindAckPending(deps, user, id, body),
      },
      // In-place e-signature of a generated letter/contract (personal-documents only; owner-only in service).
      sign: { run: (deps, user, id) => signLetter(deps, user, id) },
      // Poll the e-sign vendor for a pending document's status and apply it (fallback to the webhook).
      refreshEsign: { run: (deps, user, id) => refreshEsign(deps, user, id) },
      upload: {
        // An oversized body is already refused from its declared length by middleware/bodyLimit.ts, before this
        // (or any other buffering route) reads it; the service's own byte assertion covers a chunked body.
        run: async (deps, user, id, _body, c) =>
          svc.upload(deps, user, id, await c.req.arrayBuffer(), { fileName: c.req.query("file_name"), contentType: c.req.query("content_type") }),
      },
      // The print copy of a generated letter: the SAME letter - same words, same date, same signature - re-
      // rendered on its letterhead's print page. Nothing is stored; the filed PDF stays the record of what was
      // issued. A letter with no frozen content (an upload, an externally-signed PDF) has nothing to re-render
      // and says so.
      print: {
        raw: async (c, id) => {
          const { bytes, fileName } = await printDocument(c.get("deps"), id);
          // pdf-lib hands back a Uint8Array; c.body wants a plain ArrayBuffer (same as the letter preview path).
          const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
          return c.body(body, 200, { "Content-Type": "application/pdf", "Content-Disposition": contentDisposition("inline", fileName) });
        },
      },
      download: {
        raw: async (c, id) => {
          const { bytes, fileName } = await svc.download(c.get("deps"), c.get("user"), id);
          // Generated rows carry no uploaded name, so the service derives one from the title + content type -
          // always with an extension. Header quoting is http/contentDisposition.ts's business.
          return c.body(bytes, 200, { "Content-Type": "application/octet-stream", "Content-Disposition": contentDisposition("attachment", fileName) });
        },
      },
    },
  });
}
