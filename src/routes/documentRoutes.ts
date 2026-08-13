import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { signLetter } from "../services/letterSign";
import { refreshEsign } from "../services/esign/callback";
import type { makeDocumentService } from "../services/documentService";

// The shared spec for a document resource - org-wide or personal. NO access checks: the middleware gates the
// path by grants. `employee` applies to personal-documents only (org ignores it).
const writeSchema = z.object({
  employee: z.string().nullable().optional(),
  document_type: z.enum(["CONTRACT", "ID", "PAYSLIP", "POLICY", "LETTER", "INSURANCE", "OTHER"]).optional(),
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
  published: z.boolean().optional(),
  // org-documents only: who the document is for.
  audience: z.enum(["everyone", "department", "role"]).nullable().optional(),
  audience_ref: z.string().nullable().optional(),
  audience_refs: z.array(z.string()).optional(),
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
    list: (c, page) => svc.list(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, page.showDeleted, c.get("user")),
    verbs: {
      // The signatory name comes from the employee's legal name on file (not the request) - see the service.
      acknowledge: { run: (deps, user, id) => svc.acknowledge(deps, user, id) },
      // In-place e-signature of a generated letter/contract (personal-documents only; owner-only in service).
      sign: { run: (deps, user, id) => signLetter(deps, user, id) },
      // Poll the e-sign vendor for a pending document's status and apply it (fallback to the webhook).
      refreshEsign: { run: (deps, user, id) => refreshEsign(deps, user, id) },
      upload: {
        run: async (deps, user, id, _body, c) =>
          svc.upload(deps, user, id, await c.req.arrayBuffer(), { fileName: c.req.query("file_name"), contentType: c.req.query("content_type") }),
      },
      download: {
        raw: async (c, id) => {
          const { bytes, fileName } = await svc.download(c.get("deps"), c.get("user"), id);
          // Name the attachment (quotes/backslashes stripped so the header can't be broken out of). Generated
          // rows carry no uploaded name, so the service derives one from the title + content type - always
          // with an extension.
          const safeName = fileName.replace(/["\\\r\n]/g, "");
          const disposition = `attachment; filename="${safeName.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
          return c.body(bytes, 200, { "Content-Type": "application/octet-stream", "Content-Disposition": disposition });
        },
      },
    },
  });
}
