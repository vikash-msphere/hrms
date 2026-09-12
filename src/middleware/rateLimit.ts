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

/** The identity a budget belongs to: the API key, else the human actually making the calls. */
function principalOf(user: { uuid: string; apiKey?: { uuid: string }; simulatedBy?: { uuid: string } }): string {
  // KEYED ON THE KEY, not on its owner. A key acts as its owner (middleware/auth.ts), so keying on the user
  // would pool a person's own browsing together with every integration running under their name - one busy
  // key would then throttle the human, and revoking the key would not free the budget of anything else.
  if (user.apiKey) return `k:${user.apiKey.uuid}`;
  // A "view as" request is the ADMIN'S request, answered as somebody else (lib/viewAs.ts), so the budget is
  // theirs - the simulated person is not making calls. It also has to be, because a subject who has never
  // signed in has no account row and carries `uuid: ""`: keyed on that, every simulation of every such person,
  // by every admin, shared ONE bucket, and whoever hit it first throttled the rest.
  if (user.simulatedBy) return `u:${user.simulatedBy.uuid}`;
  return `u:${user.uuid}`;
}

// A budget, its counter, and how to recognise the requests it covers. Order matters: the FIRST match wins, so
// the narrow expensive surfaces are listed before the catch-all.
type Budget = { name: string; limit: number; matches: (method: string, path: string) => boolean; rate: KeyedIsolateRate };

/** `/v1/<collection>[:verb]` or `/v1/<collection>/<id>:verb` - the custom-method spellings, verb only. */
const verbIs = (path: string, verb: string) => path.endsWith(`:${verb}`);

/**
 * The same, pinned to ONE collection. Needed wherever a verb's SPELLING does not say what the request costs:
 * `:preview` renders a letterhead sample on `letterheads` and hands back an object stored in R2 on
 * `payslips`, and those two do not belong in the same budget.
 */
const itemVerbIs = (path: string, collection: string, verb: string) =>
  path.startsWith(`/v1/${collection}/`) && path.endsWith(`:${verb}`);

/**
 * Sub-requests one batch envelope may carry. The route's schema caps its array at this, and the limiter below
 * clamps the cost it charges to it - ONE constant, because the two disagreeing is a client that can either
 * spend a budget it was never allowed to use or slip work past the one that is meant to bound it.
 *
 * Lives here rather than in routes/batch.ts to keep the import one-way: that route imports the app from
 * index.ts, which mounts this middleware, so the constant travelling the other way would close the cycle.
 */
export const BATCH_MAX_SUB_READS = 20;

const BUDGETS: Budget[] = [
  {
    // DOCUMENT RENDERING. Each of these builds a PDF in the isolate (lib/pdf.ts, lib/letterPdf.ts) - the most
    // CPU any single request in the app spends, and the reason wrangler.toml raises cpu_ms at all. A loop
    // here is what exhausts an invocation budget rather than a database.
    //
    // THE LIST HAS TO BE THE WHOLE LIST, and it was not. Written from the personal-documents surfaces, it
    // named six spellings and missed every PDF built anywhere else in the app - so five renderers, each one a
    // `renderLetterPdf` / `renderPayslipPdf` call in the isolate and therefore exactly what this budget
    // exists to bound, fell through to the catch-all at 3000: seventy-five times the ceiling written for
    // them, on the one class of request that can exhaust an invocation rather than a database.
    //
    //   reviews/<id>:pdf                  services/reviews.ts       renderLetterPdf
    //   offers/<id>:letter                services/offerLetter.ts   renderLetterPdf
    //   personal-documents/<id>:print     services/letterPrint.ts   renderLetterPdf
    //   letterheads/<id>:preview          services/letterheads.ts   renderLetterPdf
    //   payroll-runs/<id>:previewPayslip  services/payroll.ts       renderPayslipPdf
    //
    // `payslips/<id>:preview` and `payslips/<id>:download` deliberately stay OUT, which is why the letterhead
    // entry is collection-qualified and they are not caught by a bare `:preview`: those two read the slip the
    // publish job already rendered out of R2 and decrypt it. That is an object read, and charging it here
    // would put an employee opening their own payslips under a budget sized for PDF construction.
    name: "render",
    limit: 40,
    matches: (_m, p) =>
      verbIs(p, "generateLetter") || verbIs(p, "generateForm16") || verbIs(p, "previewLetter") ||
      verbIs(p, "previewTemplate") || verbIs(p, "bankFile") || verbIs(p, "statutoryReport") ||
      verbIs(p, "pdf") || verbIs(p, "letter") || verbIs(p, "print") || verbIs(p, "previewPayslip") ||
      itemVerbIs(p, "letterheads", "preview"),
    rate: keyedCounter(40),
  },
  {
    // THE BATCH TRANSPORT. One envelope carries up to MAX_REQUESTS sub-reads (routes/batch.ts), each of which
    // re-enters the whole chain. The SPA coalesces essentially every GET through here, so this is the single
    // most leveraged call in the API.
    //
    // COUNTED IN SUB-READS, NOT IN ENVELOPES, which is the whole point of the number below. Charged one unit
    // per envelope, the budget was a count of envelopes whatever work they carried - so it bounded nothing on
    // the fan-out side (600 full envelopes is 12,000 reads) while being the TIGHTEST ceiling anywhere on the
    // SPA's read path: the same reads issued one per request are charged to `api` at 3000, so routing them
    // through the transport that exists to cost LESS made them run out of budget five times sooner. A client
    // must never be penalised for coalescing. `rateLimit` below therefore charges each envelope
    // `requests.length`, and this limit is a read count directly comparable with `api`'s.
    //
    // WHY 6000 AND NOT 3000. Parity with `api` is the principle; two things then say the transport's reads are
    // worth more than a raw request's. A sub-read is strictly cheaper - the envelope pays one JWT verify and
    // one HKDF derivation for all of them (routes/batch.ts), where twenty separate requests pay twenty of
    // each. And the same concrete reason the `api` budget is sized generously applies double here: the browser
    // suite drives the whole app as ONE caller against a single `wrangler dev` isolate with every Playwright
    // worker sharing it, and the SPA sends nearly every read of that suite through this one path.
    //
    // LISTED BEFORE the fan-outs, and matched on the exact path rather than on its verb. `:run` is a verb
    // several collections use, and a `verbIs(p, "run")` test in the fan-out entry below matched
    // `/v1/batch:run` first - so the transport the whole SPA reads through was silently charged to the
    // tighter fan-out budget. First match wins, so the order here IS the behaviour.
    name: "batch",
    limit: 6000,
    matches: (m, p) => m === "POST" && p === "/v1/batch:run",
    rate: keyedCounter(6000),
  },
  {
    // THE SPA'S CHROME COUNTS. `approvals-summary` is the approvals badge, `activity-counts` the dots on a tab
    // bar, `dashboard-summary` the KPI tiles - and the first two are fired on EVERY page mount (App.tsx,
    // lib/approvals.tsx, lib/tabActivity.ts), which is what separates them from the fan-outs below.
    //
    // THEY USED TO SIT IN `fan-out`, and that was a category error the app could not feel until the sub-read
    // charging above closed the batch hole. Before it, the SPA reached all three through `batch:run` and the
    // fan-out budget applied to nobody who used the transport, so its 120 a minute was never once measured
    // against the client's own behaviour. The moment a sub-read was charged to the budget its path matches,
    // the chrome of every navigation started spending a ceiling written for scripted abuse: three units per
    // page mount against 120 is forty navigations a minute for one credential, which is under human speed.
    // It also STARVED THE USER-DRIVEN SURFACE it shared the bucket with - ⌘K search 429'd because the badge
    // counts had already spent the allowance, on a run where only 18 searches were made at all.
    //
    // WHY THE SPLIT IS THE FIX AND NOT A BIGGER NUMBER: a fan-out's width grows with the ORG (search queries
    // ~60 collections, the people report one query per measure, a custom grid one per source table), while
    // each of these carries a bounded parameter list - the tabs a page has, the queues this caller may
    // approve, the keys the dashboard asked for. Their cost does not scale with the tenant, so they do not
    // belong under a ceiling whose whole justification is that it does.
    //
    // 1200 is a navigation rate, not a request rate: three units a mount is 400 page mounts a minute from one
    // credential. No person navigates that fast, and the same concrete reason the `api` and `batch` budgets
    // are sized generously applies here - the browser suite drives all sixteen workers through one `wrangler
    // dev` isolate as ONE caller. It stays well under `api` because each of these is several COUNT queries
    // rather than one read.
    name: "summary",
    limit: 1200,
    matches: (_m, p) =>
      p === "/v1/dashboard-summary" || p === "/v1/approvals-summary" || p === "/v1/activity-counts",
    rate: keyedCounter(1200),
  },
  {
    // CROSS-COLLECTION FAN-OUTS. One request becomes a decision plus a query per collection (search over ~60
    // of them, the people report per measure, a custom grid per source table), so its cost is a multiple of
    // an ordinary read's and it is trivially scriptable. The manual cron trigger rides here too: it dispatches
    // a whole nightly tick, which is the largest single unit of work the app has.
    //
    // Every surface left here is reached by a deliberate GESTURE - ⌘K, opening the analytics page, running a
    // saved grid, pressing the cron button - never by the act of navigating, so 120 a minute bounds scripting
    // without ever bounding use. See `summary` above for the three that were moved out.
    name: "fan-out",
    limit: 120,
    matches: (_m, p) =>
      p === "/v1/search" || p === "/v1/people-analytics" || p === "/v1/cron-runs:run" ||
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

/** The budget a request falls under. The last entry matches everything, so this never comes back undefined. */
const budgetOf = (method: string, path: string): Budget => BUDGETS.find((b) => b.matches(method, path))!;

/** Which budget a request falls under. Exported so a test can name the surfaces without re-deriving them. */
export const budgetFor = (method: string, path: string): { name: string; limit: number } => {
  const b = budgetOf(method.toUpperCase(), path);
  return { name: b.name, limit: b.limit };
};

/** A budget this request spends from, and how many units of it. */
type Charge = { budget: Budget; cost: number };

/**
 * Everything this request spends. ONE charge for every surface except the batch transport, whose envelope
 * spends from two different kinds of budget.
 *
 * ITS OWN, denominated in SUB-READS rather than in envelopes - see the `batch` entry above for why an
 * envelope cannot be one unit.
 *
 * AND THE BUDGET OF EACH EXPENSIVE SUB-READ IT CARRIES, which is the hole this closes. `rateLimit` skips the
 * limiter outright for a re-dispatched sub-request (the `__sharedCtx` branch below) - right for the
 * envelope's own count, since the sub-read was already charged on the way in, but it also meant a sub-read
 * never touched the budget its OWN path matches. Every GET fan-out (`/v1/search`, `/v1/people-analytics`) and
 * every chrome count (`/v1/dashboard-summary`, `/v1/approvals-summary`, `/v1/activity-counts`) was therefore
 * reachable through the transport at the batch budget's 6000 a minute instead of its own - fifty times the
 * ceiling written for the surfaces whose cost is a multiple of an ordinary read's. Nor was it a hole only an
 * attacker would find: web/src/lib/getCoalescer.ts is a UNIVERSAL GET coalescer, so the SPA already sends all
 * five through here, and those budgets bound nobody who used the transport at all.
 *
 * Closing it is also what first put the SPA's own chrome under a budget, which is how the `summary` split
 * above came to be needed: until a sub-read was charged, the three per-navigation counts had never spent a
 * ceiling at all.
 *
 * THE CATCH-ALL IS NOT RE-CHARGED per sub-read, deliberately. The envelope already spends one unit per
 * sub-read against `batch`, whose limit is a read count directly comparable with `api`'s, so charging both
 * would bill one read twice and re-impose on coalescing exactly the penalty that sub-read costing removed.
 * Only the narrow budgets - the ones batching could otherwise evade - are charged a second time.
 *
 * A sub-request the route will refuse without dispatching (a non-GET method, an unparseable path, one that
 * normalises outside /v1) buys no work, so it is charged no surface budget. It still counts toward the
 * envelope's own sub-read cost, which is the conservative direction.
 *
 * Reading the body here is safe and free: Hono caches the parsed JSON on the request, so the `zValidator` in
 * routes/batch.ts gets the same object rather than a second parse, and nothing before this middleware
 * (securityHeaders, dbContext, encodeWireIds, csrf, auth) touches the stream.
 *
 * A body that is missing, unparseable or the wrong shape charges ONE and falls through: the route's own
 * validator is what refuses a malformed envelope, and a limiter that threw its own error here would answer
 * 429 (or worse, 500) to what is really a 400 - a client told the wrong thing about why it failed.
 */
async function chargesFor(c: Parameters<MiddlewareHandler<AppEnv>>[0], budget: Budget): Promise<Charge[]> {
  if (budget.name !== "batch") return [{ budget, cost: 1 }];
  let subs: { method?: unknown; path?: unknown }[];
  try {
    const body = (await c.req.json()) as { requests?: unknown } | null;
    if (!Array.isArray(body?.requests)) return [{ budget, cost: 1 }];
    // Clamped at the route's own cap: past it the envelope is refused by the validator anyway, so charging an
    // arbitrarily large declared length would let a client spend somebody's whole window on one 400.
    subs = body.requests.slice(0, BATCH_MAX_SUB_READS) as { method?: unknown; path?: unknown }[];
  } catch {
    return [{ budget, cost: 1 }];
  }
  // Insertion order is the order charged, and the envelope's own budget goes first: it is the budget of the
  // request the client actually made, so it is the one named in the refusal when both are spent at once.
  const charges = new Map<Budget, number>([[budget, subs.length]]);
  const origin = new URL(c.req.url).origin;
  for (const r of subs) {
    // The same two tests routes/batch.ts applies before it dispatches anything, for the same reasons: GET
    // only, and a path that still resolves inside /v1 once the URL parser has normalised it (a raw
    // `startsWith` would take `/v1/../healthz` for a /v1 request).
    if (String(r.method ?? "GET").toUpperCase() !== "GET") continue;
    if (typeof r.path !== "string") continue;
    let pathname: string;
    try {
      const u = new URL(r.path, origin);
      if (u.origin !== origin || !u.pathname.startsWith("/v1/")) continue;
      pathname = u.pathname;
    } catch {
      continue;
    }
    const sub = budgetOf("GET", pathname);
    if (sub === budget || sub.name === "api") continue; // already covered by the envelope's own sub-read cost
    charges.set(sub, (charges.get(sub) ?? 0) + 1);
  }
  return [...charges].map(([b, cost]) => ({ budget: b, cost }));
}

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
  const budget = budgetOf(method, path);
  const principal = principalOf(user);
  const now = Date.now();
  // EVERY budget is charged before any of them decides the answer, so a refusal never leaves one of the
  // others under-counted - a request that is over budget on one surface still did the work it declared on the
  // rest. The loop holds no await, which is what lets `retryAfterSeconds` be read off the counter that
  // refused: that slot is one per counter (lib/isolateRate.ts), so it is this request's window only while
  // nothing else has run in between.
  const charges = await chargesFor(c, budget);
  let refused: Budget | undefined;
  for (const ch of charges) {
    if (ch.budget.rate.throttled(principal, now, ch.cost) && !refused) refused = ch.budget;
  }
  if (refused) {
    // Named in the message, because a 429 with no number is a thing a client author cannot act on. The
    // header is what an SDK actually reads.
    const err = resourceExhausted(`too many ${refused.name} requests; retry in ${refused.rate.retryAfterSeconds}s`);
    c.header("Retry-After", String(refused.rate.retryAfterSeconds));
    throw err;
  }
  await next();
};
