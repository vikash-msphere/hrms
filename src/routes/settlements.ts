import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { listSettlements, computeAndStoreSettlement, type SettlementInput } from "../services/settlements";
import { toSettlementResource } from "../http/serialize";

// Full-and-final settlement (FnF). POST computes + stores a snapshot from the employee's data + exit inputs.
const computeSchema = z
  .object({
    employee: z.string(),
    settlement_date: z.string().optional(),
    leave_days: z.number().min(0).optional(),
    notice_shortfall_days: z.number().min(0).optional(),
  })
  .strict();

// A settlement is a computed snapshot, not an editable record: the create IS the computation (it consumes the
// leaver's payables and can be recomputed, which releases what the previous one took). So there is no PATCH,
// and the table carries no delete_time - the factory therefore mounts no DELETE and no `:restore` either.
export const settlements = collectionRoutes<SettlementInput>({
  table: schema.settlements,
  collection: "settlements",
  auditName: "settlement",
  notFound: "settlement not found",
  param: "settlement_id",
  createSchema: computeSchema,
  serialize: toSettlementResource,
  overrides: {
    // The create is the whole FnF computation (services/settlements.ts), audited as `settlement.compute`.
    create: (deps, actor, input) => computeAndStoreSettlement(deps, actor, input),
  },
  list: (c) => {
    // The inbound edge (decodeWireIds) already decoded the query ref to its internal id; just take the id.
    const emp = c.req.query("employee");
    return listSettlements(c.get("deps"), c.get("scope"), emp ? emp.split("/").pop()! : undefined).then((items) => ({ items, nextPageToken: undefined }));
  },
});
