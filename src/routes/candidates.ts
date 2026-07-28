import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import {
  listCandidates, getCandidate, createCandidate, updateCandidate,
  deleteCandidate, restoreCandidate, purgeCandidate,
} from "../services/ats";
import { putAttachment, downloadAttachment, attachedObjectIds, getAttachment } from "../services/attachments";
import { toCandidateResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";

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

export const candidates = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listCandidates(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    const withResume = await attachedObjectIds(c.get("deps"), COL, RESUME);
    return c.json({ results: items.map((r) => withAccess(toCandidateResource({ ...r, hasResume: withResume.has(r.uuid) }), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:candidate_id", async (c) => {
    const row = await getCandidate(c.get("deps"), c.req.param("candidate_id"));
    const hasResume = !!(await getAttachment(c.get("deps"), COL, row.uuid, RESUME));
    return c.json(withAccess(toCandidateResource({ ...row, hasResume }), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createCandidate(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(withAccess(toCandidateResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .patch("/:candidate_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateCandidate(c.get("deps"), c.get("user"), c.req.param("candidate_id"), c.req.valid("json"), c.req.header("If-Match"));
    return c.json(withAccess(toCandidateResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .delete("/:candidate_id", async (c) => {
    const id = c.req.param("candidate_id");
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") await purgeCandidate(c.get("deps"), c.get("user"), id, ifMatch);
    else await deleteCandidate(c.get("deps"), c.get("user"), id, ifMatch);
    return c.body(null, 204);
  })
  .post("/:candidate_id", async (c) => {
    const { id, verb } = customMethod(c);
    const deps = c.get("deps");
    const user = c.get("user");
    const hint = (row: any) => withAccess(toCandidateResource(row), user, COL, row?.code, c.get("objectGrant"));
    if (verb === "restore") return c.json(hint(await restoreCandidate(deps, user, id)));
    if (verb === "upload") {
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      await putAttachment(deps, user, { collection: COL, objectId: id, slot: RESUME, bytes, fileName: c.req.query("file_name"), contentType: c.req.query("content_type") });
      const row = await getCandidate(deps, id);
      return c.json(hint({ ...row, hasResume: true }));
    }
    if (verb === "download") {
      const { bytes, row: att } = await downloadAttachment(deps, COL, id, RESUME);
      return c.body(bytes, 200, { "Content-Type": att.contentType ?? "application/octet-stream", "Content-Disposition": "attachment" });
    }
    return c.notFound();
  });
