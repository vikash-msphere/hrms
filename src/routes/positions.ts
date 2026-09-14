import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { positionSpec, listPositions, changeRole, EMPLOYMENT_TYPES, WORK_MODES } from "../services/positions";
import { toPositionResource } from "../http/serialize";

// Effective-dated role history. POST records a promotion/transfer (closes the current row, opens a new one),
// so the create is the service's `changeRole` rather than a generic insert. There is no PATCH and no DELETE:
// a role change supersedes, it never edits or removes what was true before.
const changeSchema = z
  .object({
    employee: z.string(),
    job_title: z.string().nullable().optional(),
    department: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
    employment_type: z.enum(EMPLOYMENT_TYPES).nullable().optional(),
    work_mode: z.enum(WORK_MODES).nullable().optional(),
    note: z.string().nullable().optional(),
    effective_from: z.string(),
  })
  .strict();

export const positions = collectionRoutes({
  ...positionSpec,
  param: "position_id",
  createSchema: changeSchema,
  serialize: toPositionResource,
  softDelete: false,
  overrides: { create: (deps, actor, input) => changeRole(deps, actor, input) },
  list: (c, page) => {
    // Optional ?employee=employees/<token> filter. The inbound edge (decodeWireIds) already decoded the
    // query ref to its internal id, so just take the id segment - do NOT decode again (that fails, dropping
    // the filter).
    const emp = c.req.query("employee");
    return listPositions(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, emp ? emp.split("/").pop()! : undefined);
  },
});
