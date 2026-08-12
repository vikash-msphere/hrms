import { collectionRoutes } from "../http/collectionRoute";
import { documentAcknowledgementSpec, listDocumentAcknowledgements } from "../services/documentAcknowledgements";
import { toDocumentAcknowledgementResource } from "../http/serialize";
import { clampPageSize } from "../http/pagination";

// Read-only + admin-cleanup. Acknowledgements are created via org-documents :acknowledge, never here - the spec
// has no insert/patch, so no POST or PATCH is mounted at all.
export const documentAcknowledgements = collectionRoutes({
  ...documentAcknowledgementSpec,
  param: "id",
  serialize: toDocumentAcknowledgementResource,
  lifecycleName: "document-acknowledgement",
  // Optional ?document=org-documents/<id> filter (the inbound edge already decoded the ref to an internal id).
  list: (c) =>
    listDocumentAcknowledgements(
      c.get("deps"),
      c.get("scope"),
      clampPageSize(Number(c.req.query("max_page_size")) || undefined),
      c.req.query("page_token"),
      c.req.query("document"),
      c.req.query("show_deleted") === "true",
    ),
});
