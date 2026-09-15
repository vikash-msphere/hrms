import { Hono } from "hono";
import type { AppEnv } from "../env";
import { upcomingCelebrations } from "../services/celebrations";
import { lastWriteAt, listEtag, etagMatches } from "../http/listEtag";

// Collection-level custom method `employees:upcomingCelebrations` (mounted at the full path in index.ts, as
// Hono's collection mount does not bind a `:verb` that is not preceded by an id). A safe read, so GET; the
// authz middleware resolves it to the custom key `employees.upcomingCelebrations`.
//
// CONDITIONALLY CACHED, by hand, because this is a bespoke handler and so gets none of the collection
// factory's machinery. It is the heaviest read in the app per unit of usefulness: `employees.upcomingCelebrations`
// is in the seeded allow list for every role, the SPA fires it from Dashboard.tsx on every dashboard mount with
// a bare `get()` (not `useCollection`, so `resourceStore` does not cache it either), and it costs one
// employee-table read plus one AES-GCM decrypt per live employee. Per user, per dashboard load, forever.
//
// The same validator the factory's lists use (http/listEtag.ts): it answers "has anything been written since
// you fetched this", carries the caller's authz version, and buckets time - which the five-minute bucket makes
// safe for an answer that moves with the calendar as this one does. The stamp is read BEFORE the work, so a
// write that lands mid-request can only cause the next revalidation to miss and re-read, never a 304 over a
// payload the write invalidated.
export const celebrations = new Hono<AppEnv>().get("/", async (c) => {
  const within = Math.min(Math.max(Number(c.req.query("within")) || 30, 1), 90);
  const now = Date.now();
  const etag = listEtag(await lastWriteAt(c.get("deps"), now), c.get("user"), c.req.url, now);
  // A match means the table is never read and nothing is decrypted, which is the whole saving.
  if (etagMatches(c.req.header("If-None-Match"), etag)) return c.body(null, 304, { ETag: etag });
  const results = await upcomingCelebrations(c.get("deps"), within);
  return c.json({ results }, 200, { ETag: etag });
});
