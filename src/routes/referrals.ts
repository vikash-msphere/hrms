import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import {
  listReferrals, getReferral, createReferral, updateReferral,
  deleteReferral, restoreReferral, purgeReferral, awardReferralBonusNow,
} from "../services/referrals";
import { putAttachment, downloadAttachment, attachedObjectIds, getAttachment } from "../services/attachments";
import { toReferralResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";

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

export const referrals = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listReferrals(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("status"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    const withResume = await attachedObjectIds(c.get("deps"), COL, RESUME); // one query for the page's resume flags
    return c.json({ results: items.map((r) => withAccess(toReferralResource({ ...r, hasResume: withResume.has(r.uuid) }), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:referral_id", async (c) => {
    const row = await getReferral(c.get("deps"), c.get("user"), c.req.param("referral_id"));
    const hasResume = !!(await getAttachment(c.get("deps"), COL, row.uuid, RESUME));
    return c.json(withAccess(toReferralResource({ ...row, hasResume }), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createReferral(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(withAccess(toReferralResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .patch("/:referral_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateReferral(c.get("deps"), c.get("user"), c.req.param("referral_id"), c.req.valid("json"), c.req.header("If-Match"));
    return c.json(withAccess(toReferralResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .delete("/:referral_id", async (c) => {
    const id = c.req.param("referral_id");
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") await purgeReferral(c.get("deps"), c.get("user"), id, ifMatch);
    else await deleteReferral(c.get("deps"), c.get("user"), id, ifMatch);
    return c.body(null, 204);
  })
  // Custom methods. The wire path is the :verb form; dispatch on the parsed verb.
  .post("/:referral_id", async (c) => {
    const { id, verb } = customMethod(c);
    const deps = c.get("deps");
    const user = c.get("user");
    const hint = (row: any) => withAccess(toReferralResource(row), user, COL, row?.code, c.get("objectGrant"));
    if (verb === "award") return c.json(hint(await awardReferralBonusNow(deps, user, id)));
    if (verb === "restore") return c.json(hint(await restoreReferral(deps, user, id)));
    if (verb === "upload") {
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      await putAttachment(deps, user, { collection: COL, objectId: id, slot: RESUME, bytes, fileName: c.req.query("file_name"), contentType: c.req.query("content_type") });
      const row = await getReferral(deps, user, id);
      return c.json(hint({ ...row, hasResume: true }));
    }
    if (verb === "download") {
      const { bytes, row: att } = await downloadAttachment(deps, COL, id, RESUME);
      return c.body(bytes, 200, { "Content-Type": att.contentType ?? "application/octet-stream", "Content-Disposition": "attachment" });
    }
    return c.notFound();
  });
