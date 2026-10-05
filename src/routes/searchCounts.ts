import { Hono } from "hono";
import type { AppEnv } from "../env";
import { searchKindCounts } from "../services/globalSearch";

// `GET /v1/search:counts` - how many records of each kind this caller can find by words: the totals ⌘K shows on
// its `in:` suggestions, and the last of the things it ranks them by. The middleware decides the per-collection scopes and leaves them on
// `searchScopes`, as it does for `/v1/search`; this route makes no access decision. One grouped read of the
// pre-counted `search_counts` (services/globalSearch.ts searchKindCounts), not a count of the index itself.
//
// Measured (sqlite3 `.scanstats`, the local dev data, 2026-10-05): counting `search_docs` visits every one of its
// 368 rows whatever the scope - no index serves the scope test - where `search_counts` visits 95. The counters grow
// with people × kinds rather than with records, so the gap widens as records pile up; the client asks once per
// opening of the search, the first time `in:` is typed.
export const searchCountsRoute = new Hono<AppEnv>().get("/", async (c) =>
  c.json({ counts: await searchKindCounts(c.get("deps"), c.get("user")!, c.get("searchScopes") ?? new Map()) }),
);
