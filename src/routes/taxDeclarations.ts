import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import {
  listTaxDeclarations, getTaxDeclaration, createTaxDeclaration, updateTaxDeclaration,
  verifyTaxDeclaration, rejectTaxDeclaration,
  type TaxDeclarationInput,
} from "../services/taxDeclarations";
import { putAttachment, downloadAttachment, attachedObjectIds } from "../services/attachments";
import { toTaxDeclarationResource } from "../http/serialize";

const COL = "tax-declarations";
const PROOF = "proof"; // attachment slot for a declaration's proof document

const writeSchema = z.object({
  employee: z.string().nullable().optional(),
  financial_year: z.string().optional(),
  section: z.string().optional(),
  label: z.string().nullable().optional(),
  declared_amount: z.number().optional(),
  note: z.string().nullable().optional(),
}).strict();
const verifySchema = z.object({ verified_amount: z.number().nullable().optional() }).strict();

// Investment declarations. Only a VERIFIED amount reduces withholding, so :verify and :reject are the whole
// point; the employee edits their own declaration until then. Delete/restore are the shared soft-delete lane.
export const taxDeclarations = collectionRoutes<TaxDeclarationInput>({
  table: schema.taxDeclarations,
  collection: COL,
  auditName: "tax-declaration",
  notFound: "declaration not found",
  param: "decl_id",
  writeSchema,
  serialize: toTaxDeclarationResource,
  // Whether the proof document is attached lives in the attachments table.
  // One query for the whole page (bounded to it), not one per row - and the factory applies it to the
  // list, the item read and every write response alike, so the flag has a single implementation.
  decorate: async (deps, _actor, rows) => {
    const attached = await attachedObjectIds(deps, COL, PROOF, rows.map((r) => r.uuid));
    return rows.map((r) => ({ ...r, hasProof: attached.has(r.uuid) }));
  },
  overrides: {
    create: (deps, actor, input, id) => createTaxDeclaration(deps, actor, input, id),
    update: (deps, actor, id, patch, ifMatch) => updateTaxDeclaration(deps, actor, id, patch, ifMatch),
  },
  list: (c, page) =>
    listTaxDeclarations(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, c.req.query("employee"), c.req.query("financial_year"), c.req.query("status"), page.showDeleted),
  verbs: {
    verify: { schema: verifySchema, run: (deps, user, id, body) => verifyTaxDeclaration(deps, user, id, body.verified_amount) },
    reject: { run: (deps, user, id) => rejectTaxDeclaration(deps, user, id) },
    upload: {
      run: async (deps, user, id, _body, c) => {
        const bytes = new Uint8Array(await c.req.arrayBuffer());
        await putAttachment(deps, user, { collection: COL, objectId: id, slot: PROOF, bytes, fileName: c.req.query("file_name"), contentType: c.req.query("content_type") });
        return getTaxDeclaration(deps, user, id);
      },
    },
    download: {
      raw: async (c, id) => {
        const { bytes, row: att } = await downloadAttachment(c.get("deps"), COL, id, PROOF);
        return c.body(bytes, 200, { "Content-Type": att.contentType ?? "application/octet-stream", "Content-Disposition": "attachment" });
      },
    },
  },
});
