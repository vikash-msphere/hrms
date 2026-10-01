import { Hono } from "hono";
import type { AppEnv } from "../env";
import { listPendingTaxVerifications } from "../services/taxDetails";

// GET /v1/tax-verifications - prior-employer tax declarations awaiting HR/payroll verification, for the
// Approvals inbox. Virtual capability (no table): the authz middleware gates this as `tax-verifications.read`
// (super via `**` and the seeded payroll_admin role, anyone else through the ACL). The verify/reject action itself is
// PATCH employees/<id>/tax (gated by the existing employees.tax write). Not a hot path: it decrypts per employee.
export const taxVerifications = new Hono<AppEnv>().get("/", async (c) => {
  const items = await listPendingTaxVerifications(c.get("deps"));
  return c.json({ results: items });
});
