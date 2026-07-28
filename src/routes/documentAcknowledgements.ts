import { Hono } from "hono";
import type { AppEnv } from "../env";
import { customMethod } from "../http/customMethod";
import { lifecycleVerb } from "../http/lifecycleRoute";
import { clampPageSize } from "../http/pagination";
import * as schema from "../db/schema";
import { listDocumentAcknowledgements, getDocumentAcknowledgement, deleteDocumentAcknowledgement, restoreDocumentAcknowledgement, purgeDocumentAcknowledgement } from "../services/documentAcknowledgements";
import { toDocumentAcknowledgementResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";

const COL = "document-acknowledgements";

// Read-only + admin-cleanup routes. Acknowledgements are created via org-documents :acknowledge, never here.
export const documentAcknowledgements = new Hono<AppEnv>()
  .get("/", async (c) => {
    // Optional ?document=org-documents/<id> filter (the inbound edge already decoded the ref to an internal id).
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listDocumentAcknowledgements(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), c.req.query("document"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toDocumentAcknowledgementResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:id", async (c) => {
    const row = await getDocumentAcknowledgement(c.get("deps"), c.get("user"), c.req.param("id"));
    return c.json(withAccess(toDocumentAcknowledgementResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .delete("/:id", async (c) => {
    const id = c.req.param("id");
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") await purgeDocumentAcknowledgement(c.get("deps"), c.get("user"), id, ifMatch);
    else await deleteDocumentAcknowledgement(c.get("deps"), c.get("user"), id, ifMatch);
    return c.body(null, 204);
  })
  .post("/:id", async (c) => {
    const lc = await lifecycleVerb(c, { table: schema.documentAcknowledgements, singular: "document-acknowledgement", collection: COL, serialize: toDocumentAcknowledgementResource });
    if (lc) return lc;
    const { id, verb } = customMethod(c);
    if (verb !== "restore") return c.notFound();
    const row = await restoreDocumentAcknowledgement(c.get("deps"), c.get("user"), id);
    return c.json(toDocumentAcknowledgementResource(row));
  });
