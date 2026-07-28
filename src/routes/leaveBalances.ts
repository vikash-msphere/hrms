import { Hono } from "hono";
import type { AppEnv } from "../env";
import { listLeaveBalances, getLeaveBalance } from "../services/leaveBalances";
import { toLeaveBalanceResource } from "../http/serialize";
import { clampPageSize } from "../http/pagination";

// Read-only collection: balances are accrued by the cron, not written via the API.
export const leaveBalances = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listLeaveBalances(
      c.get("deps"),
      c.get("scope"),
      maxPageSize,
      c.req.query("page_token"),
      c.req.query("employee"),
    );
    return c.json({ results: items.map(toLeaveBalanceResource), next_page_token: nextPageToken });
  })
  .get("/:leave_balance_id", async (c) => {
    const row = await getLeaveBalance(c.get("deps"), c.get("user"), c.req.param("leave_balance_id"));
    return c.json(toLeaveBalanceResource(row));
  });
