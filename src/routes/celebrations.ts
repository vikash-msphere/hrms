import { Hono } from "hono";
import type { AppEnv } from "../env";
import { upcomingCelebrations } from "../services/celebrations";

// Collection-level custom method `employees:upcomingCelebrations` (mounted at the full path in index.ts, as
// Hono's collection mount does not bind a `:verb` that is not preceded by an id). A safe read, so GET; the
// authz middleware resolves it to the custom key `employees.upcomingCelebrations`.
export const celebrations = new Hono<AppEnv>().get("/", async (c) => {
  const within = Math.min(Math.max(Number(c.req.query("within")) || 30, 1), 90);
  const results = await upcomingCelebrations(c.get("deps"), within);
  return c.json({ results });
});
