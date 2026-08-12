import { collectionRoutes } from "../http/collectionRoute";
import { leaveBalanceSpec, listLeaveBalances } from "../services/leaveBalances";
import { toLeaveBalanceResource } from "../http/serialize";
import { clampPageSize } from "../http/pagination";

// Read-only collection: balances are accrued by the cron, not written via the API.
export const leaveBalances = collectionRoutes({
  ...leaveBalanceSpec,
  param: "leave_balance_id",
  serialize: toLeaveBalanceResource,
  list: (c) =>
    listLeaveBalances(
      c.get("deps"),
      c.get("scope"),
      clampPageSize(Number(c.req.query("max_page_size")) || undefined),
      c.req.query("page_token"),
      c.req.query("employee"),
    ),
});
