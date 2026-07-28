import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import {
  listTaxDeclarations, getTaxDeclaration, createTaxDeclaration, updateTaxDeclaration,
  verifyTaxDeclaration, rejectTaxDeclaration, deleteTaxDeclaration, restoreTaxDeclaration, purgeTaxDeclaration,
} from "../services/taxDeclarations";
import { putAttachment, downloadAttachment, getAttachment, attachedObjectIds } from "../services/attachments";
import { toTaxDeclarationResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";

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

export const taxDeclarations = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listTaxDeclarations(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("employee"), c.req.query("financial_year"), c.req.query("status"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    const withProof = await attachedObjectIds(c.get("deps"), COL, PROOF);
    return c.json({ results: items.map((r) => withAccess(toTaxDeclarationResource({ ...r, hasProof: withProof.has(r.uuid) }), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:decl_id", async (c) => {
    const row = await getTaxDeclaration(c.get("deps"), c.get("user"), c.req.param("decl_id")!);
    const hasProof = !!(await getAttachment(c.get("deps"), COL, row.uuid, PROOF));
    return c.json(withAccess(toTaxDeclarationResource({ ...row, hasProof }), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createTaxDeclaration(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(withAccess(toTaxDeclarationResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .patch("/:decl_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateTaxDeclaration(c.get("deps"), c.get("user"), c.req.param("decl_id")!, c.req.valid("json"), c.req.header("If-Match"));
    return c.json(withAccess(toTaxDeclarationResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .delete("/:decl_id", async (c) => {
    const id = c.req.param("decl_id")!;
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") await purgeTaxDeclaration(c.get("deps"), c.get("user"), id, ifMatch);
    else await deleteTaxDeclaration(c.get("deps"), c.get("user"), id, ifMatch);
    return c.body(null, 204);
  })
  .post("/:decl_id", async (c) => {
    const { id, verb } = customMethod(c);
    const deps = c.get("deps");
    const user = c.get("user");
    const hint = (row: any) => withAccess(toTaxDeclarationResource(row), user, COL, row?.code, c.get("objectGrant"));
    if (verb === "verify") {
      const { verified_amount } = z.object({ verified_amount: z.number().nullable().optional() }).strict().parse(await c.req.json().catch(() => ({})));
      return c.json(hint(await verifyTaxDeclaration(deps, user, id, verified_amount)));
    }
    if (verb === "reject") return c.json(hint(await rejectTaxDeclaration(deps, user, id)));
    if (verb === "upload") {
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      await putAttachment(deps, user, { collection: COL, objectId: id, slot: PROOF, bytes, fileName: c.req.query("file_name"), contentType: c.req.query("content_type") });
      const row = await getTaxDeclaration(deps, user, id);
      return c.json(hint({ ...row, hasProof: true }));
    }
    if (verb === "download") {
      const { bytes, row: att } = await downloadAttachment(deps, COL, id, PROOF);
      return c.body(bytes, 200, { "Content-Type": att.contentType ?? "application/octet-stream", "Content-Disposition": "attachment" });
    }
    if (verb === "restore") return c.json(hint(await restoreTaxDeclaration(deps, user, id)));
    return c.notFound();
  });
