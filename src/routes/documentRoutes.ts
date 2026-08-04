import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { customMethod } from "../http/customMethod";
import { lifecycleVerb } from "../http/lifecycleRoute";
import { clampPageSize } from "../http/pagination";
import { withAccess } from "../http/accessHint";
import { signLetter } from "../services/letterSign";
import { refreshEsign } from "../services/esign/callback";
import type { makeDocumentService } from "../services/documentService";

// Shared CRUD + upload/download/restore routes for a document resource. NO access checks - the middleware
// gates the path by grants. `employee` applies to personal-documents only (org ignores it).
const writeSchema = z.object({
  employee: z.string().nullable().optional(),
  document_type: z.enum(["CONTRACT", "ID", "PAYSLIP", "POLICY", "LETTER", "INSURANCE", "OTHER"]).optional(),
  display_name: z.string().min(1).optional(),
  content_type: z.string().nullable().optional(),
  size_bytes: z.number().int().nullable().optional(),
  expire_time: z.string().nullable().optional(),
  requires_ack: z.boolean().optional(), // org-documents only; ignored by personal-documents
  // org-documents only: how an ack is signed + where the signature lands. Required together with requires_ack
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
type LcCfg = { table: any; singular: string; collection: string };

export function makeDocumentRoutes(lc: LcCfg, svc: Svc, serialize: (r: any) => any) {
  return new Hono<AppEnv>()
    .get("/", async (c) => {
      const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
      const { items, nextPageToken } = await svc.list(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("show_deleted") === "true", c.get("user"));
      const user = c.get("user");
      return c.json({ results: items.map((r: any) => withAccess(serialize(r), user, lc.collection, r.code)), next_page_token: nextPageToken });
    })
    .get("/:id", async (c) => {
      const row = await svc.get(c.get("deps"), c.get("user"), c.req.param("id")!);
      return c.json(withAccess(serialize(row), c.get("user"), lc.collection, (row as any)?.code, c.get("objectGrant")));
    })
    .post("/", zValidator("json", writeSchema), async (c) => c.json(serialize(await svc.create(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id")))))
    .patch("/:id", zValidator("json", writeSchema), async (c) => c.json(serialize(await svc.update(c.get("deps"), c.get("user"), c.req.param("id")!, c.req.valid("json"), c.req.header("If-Match")))))
    .delete("/:id", async (c) => {
      const id = c.req.param("id")!;
      const ifMatch = c.req.header("If-Match");
      if (c.req.query("force") === "true") await svc.purge(c.get("deps"), c.get("user"), id, ifMatch);
      else await svc.del(c.get("deps"), c.get("user"), id, ifMatch);
      return c.body(null, 204);
    })
    .post("/:id", async (c) => {
      // Shared lifecycle verbs (:enable/:disable/:lock/:unlock/:publish/:unpublish) first.
      const handled = await lifecycleVerb(c, { table: lc.table, singular: lc.singular, collection: lc.collection, serialize, publish: true });
      if (handled) return handled;
      const { id, verb } = customMethod(c);
      if (verb === "restore") return c.json(serialize(await svc.restore(c.get("deps"), c.get("user"), id)));
      if (verb === "acknowledge") {
        // The signatory name comes from the employee's legal name on file (not the request) - see service.
        return c.json(serialize(await svc.acknowledge(c.get("deps"), c.get("user"), id)));
      }
      if (verb === "sign") {
        // In-place e-signature of a generated letter/contract (personal-documents only; owner-only in service).
        return c.json(serialize(await signLetter(c.get("deps"), c.get("user"), id)));
      }
      if (verb === "refreshEsign") {
        // Poll the e-sign vendor for a pending document's status and apply it (fallback to the webhook).
        return c.json(serialize(await refreshEsign(c.get("deps"), c.get("user"), id)));
      }
      if (verb === "upload") {
        const bytes = await c.req.arrayBuffer();
        const row = await svc.upload(c.get("deps"), c.get("user"), id, bytes, { fileName: c.req.query("file_name"), contentType: c.req.query("content_type") });
        return c.json(serialize(row));
      }
      if (verb !== "download") return c.notFound();
      const { bytes, fileName } = await svc.download(c.get("deps"), c.get("user"), id);
      // Name the attachment (quotes/backslashes stripped so the header can't be broken out of). Generated rows
      // carry no uploaded name, so the service derives one from the title + content type - always with an
      // extension.
      const safeName = fileName.replace(/["\\\r\n]/g, "");
      const disposition = `attachment; filename="${safeName.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
      return c.body(bytes, 200, { "Content-Type": "application/octet-stream", "Content-Disposition": disposition });
    });
}
