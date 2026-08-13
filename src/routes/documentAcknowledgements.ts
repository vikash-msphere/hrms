import { collectionRoutes } from "../http/collectionRoute";
import { documentAcknowledgementSpec, listDocumentAcknowledgements } from "../services/documentAcknowledgements";
import { toDocumentAcknowledgementResource } from "../http/serialize";

// Read-only + admin-cleanup. Acknowledgements are created via org-documents :acknowledge, never here - the spec
// has no insert/patch, so no POST or PATCH is mounted at all.
export const documentAcknowledgements = collectionRoutes({
  ...documentAcknowledgementSpec,
  param: "id",
  serialize: toDocumentAcknowledgementResource,
  lifecycleName: "document-acknowledgement",
  // Optional ?document=org-documents/<id> filter (the inbound edge already decoded the ref to an internal id).
  list: (c, page) =>
    listDocumentAcknowledgements(
      c.get("deps"),
      c.get("scope"),
      page.maxPageSize,
      page.pageToken,
      c.req.query("document"),
      page.showDeleted,
    ),
});
