import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { listCandidates, getCandidate, createCandidate, updateCandidate, type CandidateInput } from "../services/ats";
import { putAttachment, downloadAttachment, attachedObjectIds, getAttachment } from "../services/attachments";
import { toCandidateResource } from "../http/serialize";
import { clampPageSize } from "../http/pagination";

const COL = "candidates";
const RESUME = "resume"; // the attachment slot for a candidate's resume

const writeSchema = z
  .object({
    name: z.string().nullable().optional(),
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
export const candidates = collectionRoutes<CandidateInput>({
  table: schema.candidates,
  collection: COL,
  auditName: "candidate",
  notFound: "candidate not found",
  param: "candidate_id",
  writeSchema,
  serialize: toCandidateResource,
  decorate: async (deps, _actor, rows) =>
    Promise.all(rows.map(async (r) => ({ ...r, hasResume: !!(await getAttachment(deps, COL, r.uuid, RESUME)) }))),
  overrides: {
    create: (deps, actor, input, id) => createCandidate(deps, actor, input, id),
    update: (deps, actor, id, patch, ifMatch) => updateCandidate(deps, actor, id, patch, ifMatch),
  },
  list: async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const deps = c.get("deps");
    const { items, nextPageToken } = await listCandidates(deps, c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("show_deleted") === "true");
    const withResume = await attachedObjectIds(deps, COL, RESUME);
    return { items: items.map((r) => ({ ...r, hasResume: withResume.has(r.uuid) })), nextPageToken };
  },
  verbs: {
    upload: {
      run: async (deps, user, id, _body, c) => {
        const bytes = new Uint8Array(await c.req.arrayBuffer());
        await putAttachment(deps, user, { collection: COL, objectId: id, slot: RESUME, bytes, fileName: c.req.query("file_name"), contentType: c.req.query("content_type") });
        return getCandidate(deps, id);
      },
    },
    download: {
      raw: async (c, id) => {
        const { bytes, row: att } = await downloadAttachment(c.get("deps"), COL, id, RESUME);
        return c.body(bytes, 200, { "Content-Type": att.contentType ?? "application/octet-stream", "Content-Disposition": "attachment" });
      },
    },
  },
});
