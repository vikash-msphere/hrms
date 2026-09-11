import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { resourceExhausted } from "../lib/errors";
import { keyedCounter, type KeyedIsolateRate } from "../lib/isolateRate";

// Per-caller request budgets inside /v1.
//
// WHAT THIS IS NOT, said first because the rest of the file only makes sense after it: the rate limit. The
// control is the Cloudflare WAF rule (docs/deploy-security.md §1), for the reasons lib/isolateRate.ts sets
// out - a Worker cannot see traffic an edge rule blocks, and a counter in one isolate's memory is not a limit
// across a fleet of them. This is the same FLOOR that file already puts under the unauthenticated lanes,
// extended to the authenticated ones.
//
// WHY THE AUTHENTICATED LANES NEED ONE AT ALL. The unauthenticated routes were floored because they take no
// credential; the inference drawn from that was that /v1 needs nothing, because everything there is
// authenticated and authorized. Authentication bounds WHO, not HOW OFTEN, and the two threats it leaves are
// ordinary ones: a leaked API key, used entirely inside its scope, reading the whole employee directory as
// fast as the network allows; and a signed-in employee (or a runaway client loop) driving the surfaces that
// cost real work. Neither is an access-control failure, so nothing else in the app has an opinion about it.
//
// THE BUDGETS ARE PER SURFACE, because the surfaces are not comparable. A list read is a couple of D1 queries;
// rendering a Form 16 is a PDF built in the isolate, and `people-analytics` fans a query set across every
// module. A single number would either be too loose for the second kind or absurd for the first. Every budget
// below is sized so that a person driving the UI hard never reaches it - they exist to bound automation and
// accidents, not to pace humans.
//
// Ordering: mounted AFTER auth (it needs the principal) and BEFORE authz, so a refused request costs the
// per-object reads the gate would otherwise do.

/** The identity a budget belongs to: the API key if there is one, else the user. */
function principalOf(user: { uuid: string; apiKey?: { uuid: string } }): string {
  // KEYED ON THE KEY, not on its owner. A key acts as its owner (middleware/auth.ts), so keying on the user
  // would pool a person's own browsing together with every integration running under their name - one busy
  // key would then throttle the human, and revoking the key would not free the budget of anything else.
  return user.apiKey ? `k:${user.apiKey.uuid}` : `u:${user.uuid}`;
}

// A budget, its counter, and how to recognise the requests it covers. Order matters: the FIRST match wins, so
// the narrow expensive surfaces are listed before the catch-all.
type Budget = { name: string; limit: number; matches: (method: string, path: string) => boolean; rate: KeyedIsolateRate };

/** `/v1/<collection>[:verb]` or `/v1/<collection>/<id>:verb` - the custom-method spellings, verb only. */
const verbIs = (path: string, verb: string) => path.endsWith(`:${verb}`);

const BUDGETS: Budget[] = [
  {
    // DOCUMENT RENDERING. Each of these builds a PDF in the isolate (lib/pdf.ts, lib/letterPdf.ts) - the most
    // CPU any single request in the app spends, and the reason wrangler.toml raises cpu_ms at all. A loop
    // here is what exhausts an invocation budget rather than a database.
    name: "render",
    limit: 40,
    matches: (_m, p) =>
      verbIs(p, "generateLetter") || verbIs(p, "generateForm16") || verbIs(p, "previewLetter") ||
      verbIs(p, "previewTemplate") || verbIs(p, "bankFile") || verbIs(p, "statutoryReport"),
    rate: keyedCounter(40),
  },
  {
    // THE BATCH TRANSPORT. One envelope carries up to MAX_REQUESTS sub-reads (routes/batch.ts), each of which
    // re-enters the whole chain. The SPA coalesces essentially every GET through here, so the budget is the
    // loosest of the three - but it is still the single most leveraged call in the API.
    //
    // LISTED BEFORE the fan-outs, and matched on the exact path rather than on its verb. `:run` is a verb
    // several collections use, and a `verbIs(p, "run")` test in the fan-out entry below matched
    // `/v1/batch:run` first - so the transport the whole SPA reads through was silently charged to the
    // tighter fan-out budget. First match wins, so the order here IS the behaviour.
    name: "batch",
    limit: 600,
    matches: (m, p) => m === "POST" && p === "/v1/batch:run",
    rate: keyedCounter(600),
  },
  {
    // CROSS-COLLECTION FAN-OUTS. One request becomes a decision plus a query per collection (search over ~60
    // of them, the people report per measure, a custom grid per source table), so its cost is a multiple of
    // an ordinary read's and it is trivially scriptable. The manual cron trigger rides here too: it dispatches
    // a whole nightly tick, which is the largest single unit of work the app has.
    name: "fan-out",
    limit: 120,
    matches: (_m, p) =>
      p === "/v1/search" || p === "/v1/people-analytics" || p === "/v1/dashboard-summary" ||
      p === "/v1/approvals-summary" || p === "/v1/activity-counts" || p === "/v1/cron-runs:run" ||
      (p.startsWith("/v1/table-views/") && verbIs(p, "run")),
    rate: keyedCounter(120),
  },
  {
    // Everything else on /v1. DELIBERATELY VERY LOOSE: this is a runaway detector, not a pace. 50 requests a
    // second, sustained, from one credential against one isolate is not a person and is not a healthy client.
    //
    // The number is high for a concrete reason as well as a principled one. The budget is per CALLER, and the
    // browser suite drives the entire app as ONE user against a single `wrangler dev` isolate with every
    // Playwright worker sharing it - so a ceiling sized for one human would fail the suite while telling us
    // nothing about production, where the same user is one person on one laptop. The surfaces where cost is
    // actually concentrated (rendering, the fan-outs) keep their tight budgets above; this one only has to
    // catch the unbounded case.
    name: "api",
    limit: 3000,
    matches: () => true,
    rate: keyedCounter(3000),
  },
];

/** Which budget a request falls under. Exported so a test can name the surfaces without re-deriving them. */
export const budgetFor = (method: string, path: string): { name: string; limit: number } => {
  const b = BUDGETS.find((x) => x.matches(method.toUpperCase(), path))!;
  return { name: b.name, limit: b.limit };
};

export const rateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  // A batch SUB-REQUEST is not a request the caller made - it is a slice of the envelope that was already
  // counted against the `batch` budget on the way in. Counting it again would charge one call up to twenty
  // times and make the batch transport the easiest way to hit a limit rather than the cheapest way to read.
  // The flag lives on the Worker env, unreachable by a client (routes/batch.ts).
  if (c.env.__sharedCtx) {
    await next();
    return;
  }
  const user = c.get("user");
  // No principal means this is not a caller with a budget: the cron tick and any in-process dispatch build
  // their own Deps and never pass through auth. Nothing to key on, and nothing an outsider can reach.
  if (!user) {
    await next();
    return;
  }
  const path = new URL(c.req.url).pathname;
  const method = c.req.method.toUpperCase();
  const budget = BUDGETS.find((b) => b.matches(method, path))!;
  if (budget.rate.throttled(principalOf(user), Date.now())) {
    // Named in the message, because a 429 with no number is a thing a client author cannot act on. The
    // header is what an SDK actually reads.
    const err = resourceExhausted(`too many ${budget.name} requests; retry in ${budget.rate.retryAfterSeconds}s`);
    c.header("Retry-After", String(budget.rate.retryAfterSeconds));
    throw err;
  }
  await next();
};
