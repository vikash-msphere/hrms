import { collectionRoutes } from "../http/collectionRoute";
import { leaveBalanceSpec, listLeaveBalances } from "../services/leaveBalances";
import { toLeaveBalanceResource } from "../http/serialize";

// Read-only collection: balances are accrued by the cron, not written via the API.
export const leaveBalances = collectionRoutes({
  ...leaveBalanceSpec,
  param: "leave_balance_id",
  serialize: toLeaveBalanceResource,
  list: (c, page) =>
    listLeaveBalances(
      c.get("deps"),
      c.get("scope"),
      page.maxPageSize,
      page.pageToken,
      c.req.query("employee"),
    ),
});
