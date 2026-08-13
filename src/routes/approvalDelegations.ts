import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { approvalDelegationSpec, listApprovalDelegations, deleteApprovalDelegation } from "../services/approvalDelegations";
import { toApprovalDelegationResource } from "../http/serialize";
import { clampPageSize } from "../http/pagination";

const writeSchema = z.object({
  delegator: z.string().nullable().optional(),
  delegate: z.string().nullable().optional(),
  from_date: z.string().optional(),
  to_date: z.string().optional(),
  reason: z.string().nullable().optional(),
}).strict();

export const approvalDelegations = collectionRoutes({
  ...approvalDelegationSpec,
  param: "delegation_id",
  writeSchema,
  serialize: toApprovalDelegationResource,
  // Revoking is permanent (see the service): no soft-delete mark, so no `:restore` and no `?force`.
  softDelete: false,
  overrides: { remove: deleteApprovalDelegation },
  list: (c) =>
    listApprovalDelegations(
      c.get("deps"),
      c.get("scope"),
      clampPageSize(Number(c.req.query("max_page_size")) || undefined),
      c.req.query("page_token"),
      c.req.query("employee"),
    ),
});
