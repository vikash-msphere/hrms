import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { listCandidates, getCandidate, createCandidate, updateCandidate, type CandidateInput } from "../services/ats";
import { putAttachment, downloadAttachment, attachedObjectIds, attachmentDisposition } from "../services/attachments";
import { requireCappedBody } from "../services/documentsCommon";
import { extractResume, MAX_RESUME_CHARS } from "../services/resumeExtract";
import { jsonBody } from "../http/jsonRequest";
import { invalidArgument } from "../lib/errors";
import { toCandidateResource } from "../http/serialize";

const COL = "candidates";
const RESUME = "resume"; // the attachment slot for a candidate's resume

// The resume TEXT, extracted client-side. See the verb below for why it arrives this way.
const extractSchema = z.object({ text: z.string().min(1).max(MAX_RESUME_CHARS) }).strict();

const writeSchema = z
  .object({
    // NOT nullable: `candidates.name` is a NOT NULL column the serializer emits on every response.
    name: z.string().optional(),
    email: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    source_detail: z.string().nullable().optional(),
    referral: z.string().nullable().optional(),
    tags: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
  })
  .strict();

// The talent pool. Plain CRUD plus soft delete/restore, with the resume as an attachment.
export const candidates = collectionRoutes<CandidateInput, typeof schema.candidates>({
  table: schema.candidates,
  collection: COL,
  auditName: "candidate",
  notFound: "candidate not found",
  param: "candidate_id",
  writeSchema,
  serialize: toCandidateResource,
  // One query for the whole page (bounded to it), not one per row - and the factory applies it to the
  // list, the item read and every write response alike, so the flag has a single implementation.
  decorate: async (deps, _actor, rows) => {
    const attached = await attachedObjectIds(deps, COL, RESUME, rows.map((r) => r.uuid));
    return rows.map((r) => ({ ...r, hasResume: attached.has(r.uuid) }));
  },
  overrides: {
    create: (deps, actor, input, id) => createCandidate(deps, actor, input, id),
    update: (deps, actor, id, patch, ifMatch) => updateCandidate(deps, actor, id, patch, ifMatch),
  },
  // `?q=` is the page's search box, run on the server (FTS) rather than over the loaded page - the same shape
  // employees, tickets, expenses and the rest already use.
  list: (c, page) => listCandidates(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, page.showDeleted, c.req.query("q"), page.deletedOnly),
  verbs: {
    upload: {
      run: async (deps, user, id, _body, c) => {
        const bytes = new Uint8Array(await requireCappedBody(c.req.raw));
        await putAttachment(deps, user, { collection: COL, objectId: id, slot: RESUME, bytes, fileName: c.req.query("file_name"), contentType: c.req.query("content_type") });
        return getCandidate(deps, id);
      },
    },
    download: {
      raw: async (c, id) => {
        const { bytes, row: att } = await downloadAttachment(c.get("deps"), COL, id, RESUME);
        return c.body(bytes, 200, { "Content-Type": att.contentType ?? "application/octet-stream", "Content-Disposition": attachmentDisposition(att, "resume") });
      },
    },
    // Read the CV into form fields the recruiter then accepts one by one. Off unless the org has enabled it,
    // and then only for the fields the org chose (domain/resumeFields.ts).
    //
    // The TEXT is posted by the client because the Worker cannot read a PDF (the SPA already runs pdfjs for
    // the viewer), which also keeps a PDF parser out of the Worker and a big parse off its CPU budget.
    //
    // `raw`, because the answer is a set of suggested field values, not a candidate resource. Nothing is
    // written to the candidate here: accepting a field is the ordinary PATCH, with its ordinary audit row.
    extractResume: {
      raw: async (c, id) => {
        const parsed = extractSchema.safeParse(await jsonBody(c));
        if (!parsed.success) throw invalidArgument("body must be { text }");
        const out = await extractResume(c.get("deps"), c.get("user"), id, parsed.data.text);
        return c.json({ fields: out.fields, cached: out.cached });
      },
    },
  },
});
