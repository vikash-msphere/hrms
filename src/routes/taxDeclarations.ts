import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import {
  listTaxDeclarations, getTaxDeclaration, createTaxDeclaration, updateTaxDeclaration,
  verifyTaxDeclaration, rejectTaxDeclaration,
  type TaxDeclarationInput,
} from "../services/taxDeclarations";
import { putAttachment, downloadAttachment, getAttachment, attachedObjectIds } from "../services/attachments";
import { toTaxDeclarationResource } from "../http/serialize";
import { clampPageSize } from "../http/pagination";

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
  decorate: async (deps, _actor, rows) =>
    Promise.all(rows.map(async (r) => ({ ...r, hasProof: !!(await getAttachment(deps, COL, r.uuid, PROOF)) }))),
  overrides: {
    create: (deps, actor, input, id) => createTaxDeclaration(deps, actor, input, id),
    update: (deps, actor, id, patch, ifMatch) => updateTaxDeclaration(deps, actor, id, patch, ifMatch),
  },
  list: async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const deps = c.get("deps");
    const { items, nextPageToken } = await listTaxDeclarations(deps, c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("employee"), c.req.query("financial_year"), c.req.query("status"), c.req.query("show_deleted") === "true");
    const withProof = await attachedObjectIds(deps, COL, PROOF);
    return { items: items.map((r) => ({ ...r, hasProof: withProof.has(r.uuid) })), nextPageToken };
  },
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
