import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { listReferrals, getReferral, createReferral, updateReferral, awardReferralBonusNow, type ReferralInput } from "../services/referrals";
import { putAttachment, downloadAttachment, attachedObjectIds, attachmentDisposition } from "../services/attachments";
import { requireCappedBody } from "../services/documentsCommon";
import { toReferralResource } from "../http/serialize";

const COL = "referrals";
const RESUME = "resume"; // the attachment slot for a candidate's resume

const writeSchema = z
  .object({
    referrer: z.string().nullable().optional(),
    // candidate_name and status are NOT NULL columns (status defaults to "submitted") that the serializer
    // emits on every response: null is not a value they can hold.
    candidate_name: z.string().optional(),
    candidate_email: z.string().nullable().optional(),
    candidate_phone: z.string().nullable().optional(),
    position_title: z.string().nullable().optional(),
    department: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    status: z.string().optional(),
    hired_employee: z.string().nullable().optional(),
    bonus_amount: z.number().positive().nullable().optional(),
  })
  .strict();

// Employee referrals. :award pays the referral bonus now rather than waiting for the milestone cron.
export const referrals = collectionRoutes<ReferralInput, typeof schema.referrals>({
  table: schema.referrals,
  collection: COL,
  auditName: "referral",
  notFound: "referral not found",
  param: "referral_id",
  writeSchema,
  serialize: toReferralResource,
  // One query for the whole page (bounded to it), not one per row - and the factory applies it to the
  // list, the item read and every write response alike, so the flag has a single implementation.
  decorate: async (deps, _actor, rows) => {
    const attached = await attachedObjectIds(deps, COL, RESUME, rows.map((r) => r.uuid));
    return rows.map((r) => ({ ...r, hasResume: attached.has(r.uuid) }));
  },
  overrides: {
    create: (deps, actor, input, id) => createReferral(deps, actor, input, id),
    update: (deps, actor, id, patch, ifMatch) => updateReferral(deps, actor, id, patch, ifMatch),
  },
  list: (c, page) => listReferrals(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, c.req.query("status"), page.showDeleted, page.deletedOnly),
  verbs: {
    award: { run: (deps, user, id) => awardReferralBonusNow(deps, user, id) },
    upload: {
      run: async (deps, user, id, _body, c) => {
        const bytes = new Uint8Array(await requireCappedBody(c.req.raw));
        await putAttachment(deps, user, { collection: COL, objectId: id, slot: RESUME, bytes, fileName: c.req.query("file_name"), contentType: c.req.query("content_type") });
        return getReferral(deps, user, id);
      },
    },
    download: {
      raw: async (c, id) => {
        const { bytes, row: att } = await downloadAttachment(c.get("deps"), COL, id, RESUME);
        return c.body(bytes, 200, { "Content-Type": att.contentType ?? "application/octet-stream", "Content-Disposition": attachmentDisposition(att, "resume") });
      },
    },
  },
});
