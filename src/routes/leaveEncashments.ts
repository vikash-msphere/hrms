import { z } from "zod";
import { positiveDays } from "../http/moneyField";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import {
  listEncashments, computeAndStoreEncashment,
  approveEncashment, rejectEncashment, cancelEncashment,
  type EncashmentInput,
} from "../services/leaveEncashments";
import { toLeaveEncashmentResource } from "../http/serialize";
import { rejectBody, type RejectBody } from "../http/rejectBody";

// HR-driven only (gated by grants: only hr_admin holds write). Payout is always via payroll, so there is no
// :pay verb - approved rows are swept into the next run.
const createSchema = z
  .object({
    employee: z.string(),
    leave_type: z.string(),
    days: positiveDays(),
  })
  .strict();

// A workflow resource: the create prices the payout, and the state moves only through :approve/:reject/:cancel
// (PAID is set by the payroll run). Nothing edits a priced row, and the table has no delete_time - so no PATCH,
// no DELETE, no `:restore`.
export const leaveEncashments = collectionRoutes<EncashmentInput, typeof schema.leaveEncashments>({
  table: schema.leaveEncashments,
  collection: "leave-encashments",
  auditName: "leave_encashment",
  notFound: "leave encashment not found",
  param: "encashment_id",
  createSchema,
  serialize: toLeaveEncashmentResource,
  overrides: {
    // The create is the eligibility check + pricing (services/leaveEncashments.ts), audited as `.compute`.
    create: (deps, actor, input) => computeAndStoreEncashment(deps, actor, input),
  },
  list: (c, page) => {
    // The inbound edge (decodeWireIds) already decoded the query ref to its internal id; just take the id.
    const emp = c.req.query("employee");
    return listEncashments(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, c.req.query("state"), emp ? emp.split("/").pop()! : undefined);
  },
  verbs: {
    approve: { run: (deps, user, id, _body, c) => approveEncashment(deps, user, id, c.req.header("If-Match")) },
    reject: { schema: rejectBody, run: (deps, user, id, body: RejectBody, c) => rejectEncashment(deps, user, id, body.reason, c.req.header("If-Match")) },
    cancel: { run: (deps, user, id) => cancelEncashment(deps, user, id) },
  },
});
