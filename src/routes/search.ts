import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { globalSearch } from "../services/globalSearch";
import { openLabel, recordInsight, zeroLabel } from "../services/searchInsights";
import { redactionGateFor } from "../http/fieldAccess";
import { invalidArgument } from "../lib/errors";
import { jsonBody } from "../http/jsonRequest";
import { askSearch } from "../services/searchAsk";
import { MAX_DESTINATIONS, MAX_QUESTION } from "../domain/searchAsk";
import { startOfPeriod } from "../domain/searchQuery";

// Virtual collection: `GET /v1/search?q=...` returns cross-collection hits for the command palette. `search`
// is not a resource - it holds no data of its own and grants nothing. It is the read-side twin of
// `/v1/batch:run`: the envelope is a transport, and access is decided per collection. The middleware does that
// deciding and leaves the verdicts on `searchScopes`; this route makes no access decision, exactly like every
// other list route. The field gate it hands over is the same shape: `redactionGateFor` closes over the
// caller's grant so the service can ask a decision it is not allowed to make itself, one row at a time.
//
// `name` is the standard `<collection>/<id>` resource ref, so the outbound wire edge tokenizes the id like
// every other response and the SPA routes on it with the same resourceRoute() it uses for the activity feed.
//
// NARROWING (the palette's `in:`, `@name` and `is:mine`), all of which only ever narrow the caller's own scopes:
//   ?in=tickets,assets     only these collections
//   ?owner=employees/<id>  only rows belonging to this employee - decoded inbound like any query-param ref
//   ?mine=1                only rows belonging to the caller
//   ?after=2026-01[-15]    only rows created on or after the start of that month (or day), UTC
//   ?before=2026-03[-01]   only rows created before the start of that month (or day), UTC
//   ?status=pending        only rows whose own state/status column holds that value
// With any of these and an empty `q`, the answer is the newest rows the narrowing names, not nothing.
export const search = new Hono<AppEnv>().get("/", async (c) => {
  const user = c.get("user")!;
  const q = c.req.query("q") ?? "";
  const collections = (c.req.query("in") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 12);
  const ownerRef = c.req.query("owner");
  // A caller with no employee record owns nothing, so `mine` for them matches nothing rather than everything.
  const ownerId = c.req.query("mine") === "1" ? (user.employeeId ?? "-") : ownerRef?.startsWith("employees/") ? ownerRef.split("/").pop() : undefined;
  const after = c.req.query("after");
  const before = c.req.query("before");
  const status = c.req.query("status");
  const afterMs = after === undefined ? undefined : startOfPeriod(after);
  const beforeMs = before === undefined ? undefined : startOfPeriod(before);
  // A date that does not parse narrows to nothing rather than being dropped, so the answer is never WIDER
  // than the question asked.
  const unparsable = afterMs === null || beforeMs === null;
  const hits = unparsable ? [] : await globalSearch(c.get("deps"), user, c.get("searchScopes") ?? new Map(), q, redactionGateFor(user), {
    collections: collections.length ? collections : undefined,
    ownerId,
    after: afterMs ?? undefined,
    before: beforeMs ?? undefined,
    status,
  });
  // A query that found nothing at all is the evidence for a missing synonym or noun. Unnarrowed only: a
  // search scoped to one collection finding nothing says nothing about the vocabulary. Off the response path.
  const narrowed = collections.length > 0 || !!ownerId || after !== undefined || before !== undefined || status !== undefined;
  if (hits.length === 0 && !narrowed) {
    const work = recordInsight(c.get("deps"), "zero", zeroLabel(q));
    try {
      c.executionCtx.waitUntil(work);
    } catch {
      await work; // no execution context (tests, in-process dispatch)
    }
  }
  return c.json({
    results: hits.map((h) => ({
      name: `${h.collection}/${h.id}`,
      collection: h.collection,
      title: h.title,
      subtitle: h.subtitle,
      ...(h.related ? { related: true } : {}),
    })),
  });
});

const feedbackBody = z.object({
  source: z.enum(["keyword", "related", "local"]),
  position: z.number().int().min(0).max(500),
});

// `POST /v1/search:feedback` - the palette reports which result was opened: how it was found and where in the
// list it sat. Counted, not logged (services/searchInsights.ts), so it carries no record id and no query.
export const searchFeedback = new Hono<AppEnv>().post("/", async (c) => {
  const parsed = feedbackBody.safeParse(await jsonBody(c));
  if (!parsed.success) throw invalidArgument("source and position are required");
  await recordInsight(c.get("deps"), "open", openLabel(parsed.data.source, parsed.data.position));
  return c.body(null, 204);
});

const askBody = z.object({
  question: z.string().max(MAX_QUESTION),
  destinations: z.array(z.object({ key: z.string().max(120), label: z.string().max(200), group: z.string().max(80).nullish() })).max(MAX_DESTINATIONS),
});

// `POST /v1/search:ask` - the palette's Ask, on Enter. The caller sends the question AND the destinations its
// own palette offers, so the model is only ever choosing among places this person can already open; nothing it
// answers can widen that (services/searchAsk.ts filters to the offered keys). No access decision here: the
// destinations are the caller's own, and the pages they lead to decide for themselves when opened.
export const searchAsk = new Hono<AppEnv>().post("/", async (c) => {
  const parsed = askBody.safeParse(await jsonBody(c));
  if (!parsed.success) throw invalidArgument("question and destinations are required");
  const answer = await askSearch(c.get("deps"), c.get("user")!, parsed.data.question, parsed.data.destinations);
  return c.json(answer);
});
