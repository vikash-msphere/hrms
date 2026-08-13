import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { listReferrals, getReferral, createReferral, updateReferral, awardReferralBonusNow, type ReferralInput } from "../services/referrals";
import { putAttachment, downloadAttachment, attachedObjectIds, getAttachment } from "../services/attachments";
import { toReferralResource } from "../http/serialize";
import { clampPageSize } from "../http/pagination";

const COL = "referrals";
const RESUME = "resume"; // the attachment slot for a candidate's resume

const writeSchema = z
  .object({
    referrer: z.string().nullable().optional(),
    candidate_name: z.string().nullable().optional(),
    candidate_email: z.string().nullable().optional(),
    candidate_phone: z.string().nullable().optional(),
    position_title: z.string().nullable().optional(),
    department: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    hired_employee: z.string().nullable().optional(),
    bonus_amount: z.number().positive().nullable().optional(),
  })
  .strict();

// Employee referrals. :award pays the referral bonus now rather than waiting for the milestone cron.
export const referrals = collectionRoutes<ReferralInput>({
  table: schema.referrals,
  collection: COL,
  auditName: "referral",
  notFound: "referral not found",
  param: "referral_id",
  writeSchema,
  serialize: toReferralResource,
  decorate: async (deps, _actor, rows) =>
    Promise.all(rows.map(async (r) => ({ ...r, hasResume: !!(await getAttachment(deps, COL, r.uuid, RESUME)) }))),
  overrides: {
    create: (deps, actor, input, id) => createReferral(deps, actor, input, id),
    update: (deps, actor, id, patch, ifMatch) => updateReferral(deps, actor, id, patch, ifMatch),
  },
  list: async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const deps = c.get("deps");
    const { items, nextPageToken } = await listReferrals(deps, c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("status"), c.req.query("show_deleted") === "true");
    const withResume = await attachedObjectIds(deps, COL, RESUME); // one query for the page's resume flags
    return { items: items.map((r) => ({ ...r, hasResume: withResume.has(r.uuid) })), nextPageToken };
  },
  verbs: {
    award: { run: (deps, user, id) => awardReferralBonusNow(deps, user, id) },
    upload: {
      run: async (deps, user, id, _body, c) => {
        const bytes = new Uint8Array(await c.req.arrayBuffer());
        await putAttachment(deps, user, { collection: COL, objectId: id, slot: RESUME, bytes, fileName: c.req.query("file_name"), contentType: c.req.query("content_type") });
        return getReferral(deps, user, id);
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
