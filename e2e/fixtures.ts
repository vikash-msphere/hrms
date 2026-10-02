import { readFileSync } from "node:fs";
import { test as base, expect, type APIRequestContext, type APIResponse, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { sealSession } from "../src/lib/session";
import { HOLIDAYS } from "../bootstrap/collections/holidays";
import { HOLIDAY_YEAR } from "../bootstrap/lib";
import { lane } from "./lane";

// Signing in, in a browser test.
//
// There is no OAuth round trip to drive here (and no dev bypass - see e2e/globalSetup.ts). The Worker's
// Google-mode session is stateless: a `hrms_session` cookie that is `payload.HMAC(payload)` keyed by
// AUTH_SESSION_KEY, verified per request, with role/status/grant resolved fresh from the DB every time
// (src/middleware/auth.ts). So a test can mint its own cookie for any seeded email and be that person -
// through the real cookie lane, with real authz, and with several identities alive at once.
//
// `sealSession` is imported from the app rather than reimplemented: the cookie format is the app's business,
// and a second copy of it here would be a second thing to keep true.
const VARS = readFileSync(new URL("./e2e.vars", import.meta.url), "utf8");

function e2eVar(key: string): string {
  const line = VARS.split("\n").find((l) => l.startsWith(`${key}=`));
  if (!line) throw new Error(`e2e: ${key} is not set in e2e/e2e.vars`);
  return line.slice(key.length + 1).replace(/^"|"$/g, "").trim();
}

const SESSION_KEY = e2eVar("AUTH_SESSION_KEY");
const SESSION_COOKIE = "hrms_session";

/** The role logins seeded by scripts/seed.sql (the same set scripts/start.sh documents). */
export const ROLES = {
  super: "super@example.com",
  hr: "hr@example.com",
  manager: "mgr@example.com",
  payroll: "pay@example.com",
  employee: "emp@example.com",
  it: "it@example.com",
  pm: "pm@example.com",
} as const;

export type Role = keyof typeof ROLES;

/** Mutations need this header or CSRF refuses them (src/middleware/csrf.ts). */
export const SPA_HEADERS = { "X-Requested-By": "hrms-spa" };

// Console noise that is not the app failing. Kept as short as the evidence allows: every entry here is a
// class of message somebody has decided is fine, and a long list is how a real error hides.
const IGNORED_CONSOLE = [
  /Download the React DevTools/i,
  /favicon/i,
  /ResizeObserver loop/i,
  // Telemetry delivery, which is not the app under test. Every browser in the lane ships its errors and
  // traces through the Worker's `/diag` relay to the real Sentry project, and sixteen of them at once are
  // rate limited there - a 429 the browser logs as a failed resource load. What the relay itself does IS
  // covered, by `reportProblem`, which stubs `/diag` in the page and reads the envelopes.
  //
  // The status is not the whole class, though: the relay answers with whatever ingest returned, so a busy
  // afternoon at Sentry arrives as a 503 (and a bad minute as any other 5xx) with no more to do with the app
  // than the 429 has. `TELEMETRY_URL` below drops those by WHERE they came from, which is the honest test;
  // this pattern stays for the case where the browser reports no url with the message.
  /status of 429/i,
  // 503, from the RUNTIME rather than from anything the app decided.
  //
  // This app has no 503 to answer with: every canonical error constructor (lib/errors.ts) is a 4xx, a 500,
  // 501 or 502, and the one 503 in the tree is `/readyz` reporting D1 down - a path outside /v1 that the SPA
  // never calls. The runtime does, and it says so in its own words in the body: "Your worker restarted
  // mid-request. Please try sending the request again. Only GET or HEAD requests are retried automatically."
  // `wrangler dev` recycles the Worker under sixteen browsers' load, and whatever was in flight is answered
  // with that. A handful per run - `tmp/e2e-worker.log` lists every one with its timing, all answered in
  // tens of milliseconds.
  //
  // Which is why this entry covers the console LINE only. A refused GET is re-read by the page and costs
  // nothing; a refused WRITE never happened, and the runtime will not re-send it - so a spec whose claim
  // rests on one press must press against the record until it lands (`loanRejectAndCancel.spec.ts`), and one
  // whose FIXTURE is a POST must re-send it (`apiPost` below).
  //
  // 500 and 502 stay failures: those the app really can produce (errorHandler's internal, `upstreamFailed`),
  // and a spec that provokes one still opts in by name through `allowConsoleErrors`.
  /status of 503/i,
  // A letterhead thumbnail whose bytes went while the row naming them was on screen.
  //
  // The letterheads CATALOGUE is one org-wide list, and four specs have its panel open at once
  // (letterheads, letterheadArtwork, letterheadCopy, letterheadPrintVersion). A row's artwork is not part of
  // the row - `Settings.tsx`'s LetterheadRow and the designer both fetch `:image` per slot, driven by the
  // `assets` map the LIST answer carried. So when `letterheadArtwork` uploads a mark and removes it again,
  // any page that read the list in between holds a row that still names the slot and asks for bytes the
  // server has already dropped: `getLetterheadImage` answers 404, which is the honest status for a slot with
  // no image. Both callers catch it and fall back to the placeholder, so nothing is broken on screen - the
  // only trace is the console line, and no amount of app care can close a window that opens in another
  // browser. Seen 2026-09-15: two of these failed `letterheads.spec.ts`, which passed on the retry.
  //
  // Scoped to the endpoint, not to the status: a 404 anywhere else is still a spec failure.
  /status of 404\b.*\/v1\/letterheads\/[^/]+:image/i,
  // A profile photo taken off while a page that had read the person's row was still drawing their avatar.
  //
  // `employeePhoto.spec.ts` sets the seeded employee's photo and removes it again - it has to be that person,
  // since the self-service grant is what it proves. Every other page showing them (search results, the
  // directory, an approval queue) keys its `<img>` on the row's `photo` marker, and a row read inside that
  // window names a picture the server has already dropped: `:getPhoto` answers 404, `PhotoAvatar` falls back
  // to initials, and the console line is the only trace. Seen 2026-09-26: it failed `entityKindLabel.spec.ts`
  // straight after the second `:clearPhoto` in the worker log.
  //
  // Scoped to the endpoint, not to the status: a 404 anywhere else is still a spec failure.
  /status of 404\b.*\/v1\/employees\/[^/]+:getPhoto/i,
  // The next policy in a signer's queue, purged by the spec that made it before the dialog reached it.
  //
  // `SignDocumentDialog` walks every policy awaiting the caller's signature and moves on to the next one after
  // each signature, fetching its PDF. Several specs publish ack-required policies org-wide and purge them when
  // they finish (`esignProvider`, `documentRemind`, `documentRemindBulkAndCopyEmails`), so HR's queue in
  // `documentAck` holds theirs too, and the one it advances to can be gone by then: `:download` answers 404 and
  // the dialog says the document was removed. Seen 2026-09-26: `esignProvider`'s force purge landed between
  // `documentAck`'s signature and the dialog's fetch of the next document.
  //
  // Scoped to the endpoint, not to the status: a 404 anywhere else is still a spec failure.
  /status of 404\b.*\/v1\/org-documents\/[^/]+:download/i,
  // A read receipt for a board post another spec deleted while this page had it on screen.
  //
  // The feed is org-wide and a dozen specs post to it and delete their posts again. A card that stays in view
  // for the dwell time fires `:markRead`, so a page that read the list just before another browser's delete
  // sends a receipt for a post that is gone, and 404 is the honest answer. `Announcements.tsx#markRead`
  // settles on it and drops the card; the console line is the only trace. Seen 2026-09-23: two of these
  // failed `aiFeatures.spec.ts` on the Feed, both answered 404 right after their DELETE in the worker log.
  //
  // Scoped to the endpoint, not to the status: a 404 anywhere else is still a spec failure.
  /status of 404\b.*\/v1\/announcements\/[^/]+:markRead/i,
];

// The relay's own path. A failed resource load is logged against the url that failed, so a console error
// whose location is this one is Sentry's ingest answering, never the app: the app's own /v1 failures still
// fail the spec that provoked them.
const TELEMETRY_URL = /\/diag(\b|$)/;

type Fixtures = {
  /**
   * A browser signed in as `role`, on its own context (own cookie jar, own storage). Call it more than once
   * in a test to have two people looking at the app at the same time.
   *
   * Pass `{ email }` instead of a role to be somebody the seed did not name - the login a spec provisioned
   * for itself. Access-control specs need that: the five seeded logins are load-bearing for the whole suite,
   * so a spec that wants to watch a GRANT arrive (or an account get disabled) has to do it to a person of its
   * own. The cookie lane is the same one either way, so the app cannot tell the difference.
   *
   * Every page it hands back is watched: if the app logs an error or throws, the test fails at teardown with
   * the message. A page that is EXPECTED to log (a spec deliberately provoking a failed request) opts out
   * with `allowConsoleErrors`.
   */
  as: (who: Role | { email: string }) => Promise<Page>;
};

/**
 * Stop treating console errors matching `pattern` as a failure on this page. The pattern is matched against
 * the message and the url the browser blamed, joined as `<message> @ <url>`, so a tolerance can name the one
 * request it is excusing rather than a whole status.
 */
export function allowConsoleErrors(page: Page, pattern: RegExp) {
  allowed.get(page)?.push(pattern);
}

/**
 * Boot the real Sentry SDK on this page.
 *
 * The lane runs with `VITE_SENTRY_IN_DEV=opt-in` (scripts/e2eStack.sh), which makes the SDK available but
 * leaves it inert until a page asks - so only the specs that are ABOUT telemetry pay for it, and the other
 * ~348 relay nothing to the live Sentry project through the Worker they are timing. Call it before the first
 * navigation: `addInitScript` runs ahead of the bundle, and instrument.ts reads the flag as it evaluates.
 *
 * A spec that calls this MUST also stub `**\/diag`, or its envelopes go to the real project.
 */
/**
 * Whether a 500 came from a hop between the browser and the Worker rather than from the app - the rule
 * `web/src/api.ts#isGatewayRefusal` applies, so a test and the app agree on what is infra.
 *
 * The app's 500 is always problem+json with a `/errors/...` type. The header settles most cases with no body.
 * A body that cannot be read settles the rest: the app cancels a response's body only when it is about to
 * retry it (`discard`), and it retries a 500 only when that 500 is not its own - its own is never cancelled,
 * so it is always readable here.
 */
export async function notTheApps500(res: Pick<import("@playwright/test").Response, "headers" | "text">): Promise<boolean> {
  if (!(res.headers()["content-type"] ?? "").includes("problem+json")) return true;
  const body = await res.text().catch(() => null);
  return body === null || !/"type"\s*:\s*"\/errors\//.test(body);
}

/**
 * The answer to a write the page is about to send, for a spec that asserts on it: the first response that is
 * not a copy the dev runtime dropped.
 *
 * A dropped connection reaches the browser as a 500 that is not the app's (`notTheApps500`), and the app then
 * re-sends the same write under its Idempotency-Key (web/src/api.ts) - so the FIRST matching response is the
 * dead copy and the rule was saved by the second. `waitForResponse` on the first one failed two workflow specs
 * on 2026-09-27 over a `POST /v1/automations` the page had already recovered. An app 500 is still returned,
 * so a real failure still fails the spec.
 */
export function landedResponse(page: Page, match: (r: import("@playwright/test").Response) => boolean, timeout = 30_000) {
  return page.waitForResponse(async (r) => match(r) && !(r.status() === 500 && (await notTheApps500(r))), { timeout });
}

/**
 * A sweep's own console collector: every error the page logs, labelled with where the walk was (`at`), so one
 * report names each page or panel that logged. The sweeps keep their own list rather than leaning on the
 * shared watchdog because the label is the point.
 *
 * A 500 the APP did not write (`notTheApps500` - a connection the dev runtime dropped, which the app's retry
 * absorbs) is left out, by the same rule the watchdog applies. Without it one dropped `batch:run` anywhere in a
 * forty-page walk failed the sweep about a page that drew perfectly well. The app's own 500 still counts.
 * `ignore` is matched against the console text, for whatever else the sweep excuses (429 telemetry, 409 races).
 */
export function collectConsole(page: Page, ignore: RegExp) {
  let where = "";
  const logged: { line: string; url: string }[] = [];
  const dropped = new Set<string>();
  const judged: Promise<void>[] = [];
  page.on("response", (res) => {
    if (res.status() === 500) judged.push(notTheApps500(res).then((infra) => void (infra && dropped.add(res.url()))));
  });
  page.on("console", (m) => {
    if (m.type() !== "error" || ignore.test(m.text())) return;
    logged.push({ line: `${where}: ${m.text().slice(0, 200)}`, url: m.location()?.url ?? "" });
  });
  page.on("pageerror", (e) => logged.push({ line: `${where}: threw ${e.message}`, url: "" }));
  return {
    /** Name what the walk is on now; later lines are attributed to it. */
    at(label: string) {
      where = label;
    },
    /** Every line logged so far, minus the dropped connections - once each 500 has been judged. */
    async problems(): Promise<string[]> {
      await Promise.all(judged);
      return logged.filter((l) => !l.url || !dropped.has(l.url)).map((l) => l.line);
    },
  };
}

export async function enableTelemetry(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __hrmsSentryOptIn?: boolean }).__hrmsSentryOptIn = true;
  });
}

const allowed = new WeakMap<Page, RegExp[]>();

async function signIn(browser: Browser, baseURL: string, email: string): Promise<BrowserContext> {
  const now = Date.now();
  const token = await sealSession({ email, iat: now, exp: now + 60 * 60_000 }, SESSION_KEY);
  const context = await browser.newContext({ baseURL });
  await context.addCookies([{ name: SESSION_COOKIE, value: token, url: baseURL }]);
  return context;
}

export const test = base.extend<Fixtures>({
  as: async ({ browser, baseURL }, use) => {
    if (!baseURL) throw new Error("e2e: no baseURL configured");
    const contexts: BrowserContext[] = [];
    const failures: string[] = [];
    // A 500 the lane's PRISM PROXY made up, rather than one the app answered with.
    //
    // Every browser request goes through `prism proxy openapi.yaml --errors` (scripts/e2eStack.sh), and Prism
    // answers with a 500 of its own when it cannot reach the Worker at all - `FetchError: ... read ECONNRESET`,
    // which workerd produces under sixteen browsers exactly as it produces the restart 503 documented above.
    // The console line is identical to a real one ("the server responded with a status of 500"), so the only
    // way to tell them apart is the BODY, and the rule is the one `web/src/api.ts#isGatewayRefusal` uses: the
    // app's errorHandler always answers a 500 as problem+json with a `/errors/...` type. Anything else came
    // from a hop in between - Prism names the problem after the error it caught (`"type":"FetchError"` for a
    // socket reset, `stoplight.io/prism/errors#UNKNOWN` otherwise), and `wrangler dev`'s ProxyWorker answers a
    // dropped connection with a plain-text 500 that Prism passes through. Those urls are collected here and the
    // console entries naming them are dropped at the end; every 500 the app wrote still fails the spec.
    const proxyFailed = new Set<string>();
    // A payroll build that lost a payable to ANOTHER spec's build. Every draft run claims the org's whole queue
    // of unpaid bonuses and claims, and sixteen workers build runs at once, so the second committer is refused
    // with `/errors/payables-raced` and the payroll page builds again by itself (PayrollRuns.tsx `buildRun`).
    // The browser still logs the refused attempt. Tolerated by the body's TYPE, never by the status, so any
    // other 409 on the same path still fails the spec, and a race that outlasted the retries fails on the
    // outcome the spec waits for.
    const racedPayables = new Set<string>();
    const bodiesRead: Promise<void>[] = [];

    await use(async (who) => {
      const email = typeof who === "string" ? ROLES[who] : who.email;
      const context = await signIn(browser, baseURL, email);
      hardenRequest(context.request);
      contexts.push(context);
      signedIn.set(email, [...(signedIn.get(email) ?? []), context]);
      const page = await context.newPage();
      settleBeforeReload(page);
      allowed.set(page, []);
      // `where` is the url the browser blames, and it is reported because without it a failed resource load
      // says only its status: "the server responded with a status of 500" names no request, so working out
      // WHICH read failed means re-running the spec with a listener attached and hoping it happens again.
      //
      // The tolerance patterns are matched against the reported LINE - message and url together - because a
      // failed resource load names no url in its message, so a pattern that could only see the message could
      // only ever tolerate a whole STATUS. That is how wide a tolerance had to be written to excuse one
      // endpoint, and a blanket `/status of 404/` is exactly the entry that hides the next real one. Matching
      // the line lets a tolerance name the request instead. A pattern written against the message alone is
      // unaffected: it matches a substring of the line either way.
      const record = (text: string, where?: string) => {
        const line = `${text}${where ? ` @ ${where}` : ""}`;
        const skip = [...IGNORED_CONSOLE, ...(allowed.get(page) ?? [])].some((p) => p.test(line));
        if (!skip) failures.push(`[${typeof who === "string" ? who : email}] ${text.slice(0, 300)}${where ? ` @ ${where}` : ""}`);
      };
      // Read before the console entry is judged - the body settles first, and the check happens after the run.
      page.on("response", (res) => {
        if (res.status() === 409) {
          bodiesRead.push(res.text().then((b) => void (/"type"\s*:\s*"\/errors\/payables-raced"/.test(b) && racedPayables.add(res.url())), () => undefined));
          return;
        }
        if (res.status() !== 500) return;
        bodiesRead.push(notTheApps500(res).then((infra) => void (infra && proxyFailed.add(res.url()))));
      });
      page.on("console", (m) => {
        if (m.type() !== "error") return;
        const url = m.location()?.url ?? "";
        if (TELEMETRY_URL.test(url)) return;
        record(m.text(), url || undefined);
      });
      // The message alone names a symptom ("Cannot read properties of undefined"); the first frames name the
      // FILE, which is the difference between a diagnosable failure and an afternoon of guessing - a crash
      // inside a bundled library reads identically to one of ours until you can see where it came from. Two
      // frames, because `record` keeps only the first 300 characters.
      page.on("pageerror", (e) => {
        const where = (e.stack ?? "").split("\n").slice(1, 3).map((l) => l.trim()).join(" | ");
        record(`pageerror: ${e.message}${where ? ` at ${where}` : ""}`);
      });
      return page;
    });

    await Promise.all(bodiesRead); // whose 500 each one was, before the pages go away
    for (const context of contexts) await context.close();
    for (const [email, held] of signedIn) {
      const open = held.filter((c) => !contexts.includes(c));
      if (open.length) signedIn.set(email, open);
      else signedIn.delete(email);
    }
    // Asserted after the test body so a genuine assertion failure is reported first and this never masks it.
    const real = failures.filter((line) => ![...proxyFailed, ...racedPayables].some((url) => line.endsWith(` @ ${url}`)));
    expect(real, "the app logged errors in the browser console").toEqual([]);
  },
});

export { expect };

/**
 * Take a record this spec created back out, through the hard purge (`?force=true`).
 *
 * A spec brings its own data rather than consuming the seed's, which is what makes it repeatable - but data
 * brought and never taken away still piles up, three tickets and a document at a time, in the database a
 * developer runs the lane against all afternoon. Failures are swallowed on purpose: this is housekeeping
 * after the assertions, and a purge that this caller may not make is not what the spec is about.
 */
export async function purge(page: Page, path: string) {
  await page.request.delete(`/v1/${path}?force=true`, { headers: SPA_HEADERS }).catch(() => undefined);
}

/**
 * A POST that survives the Worker being recycled under it - for a spec's own FIXTURES, never for the write a
 * spec is actually about.
 *
 * The runtime this suite runs on restarts the Worker mid-request now and then and answers whatever was in
 * flight with a 503 saying exactly that ("Only GET or HEAD requests are retried automatically" - see
 * IGNORED_CONSOLE above). Nothing re-sends it, so a `page.request.post` that sets a spec up simply fails,
 * and the spec dies on its scaffolding rather than on its claim. Re-sent only on that answer: any other
 * status is the server's real verdict and comes straight back for the caller to assert on.
 */
//
// The same for a connection the dev ProxyWorker drops on the way to the Worker, which arrives as a 500 that is
// NOT the app's (`notTheApps500`: Prism's "Request/Response not valid" over a plain-text body). The write may or
// may not have landed, so every copy carries one `Idempotency-Key` - the server hands a repeat the first copy's
// stored answer instead of creating the row twice, exactly as `web/src/api.ts` does for the SPA's own writes.
//
// `as()` applies the same rule to every request a spec sends itself (`hardenRequest` below), so a bare
// `page.request.post` fixture is covered too; this stays for pages signed in some other way.
export async function apiPost(page: Page, path: string, data: unknown): Promise<APIResponse> {
  const headers = { ...SPA_HEADERS, "Idempotency-Key": crypto.randomUUID() };
  let res = await page.request.post(`/v1/${path}`, { headers, data });
  for (let attempt = 0; attempt < 3 && (res.status() === 503 || (res.status() === 500 && (await notTheApps500(res)))); attempt++) {
    res = await page.request.post(`/v1/${path}`, { headers, data });
  }
  return res;
}

/**
 * `apiPost`'s rule for every request a signed-in context sends outside the page: `page.request` is the
 * context's, and about 150 specs set themselves up with bare `page.request.post(...)` calls that the app's
 * own transport never sees. One dropped connection on one of those failed `eventDelete` on its scaffolding
 * (2026-09-28, a single `POST /v1/events` lost by the ProxyWorker).
 *
 * A write gets an `Idempotency-Key` unless the spec set its own, so a re-sent copy is answered with the
 * first copy's result rather than landing twice. Re-sent only on an answer the lane made up - a 503, a 500
 * that is not the app's (`notTheApps500`), or the idempotency middleware's `/errors/aborted` 409 for a copy
 * that arrived while the first was still running. Every other status is the server's verdict and comes back
 * unchanged, so a spec asserting a refusal still sees it.
 */
/**
 * `page.reload()` waits out a closed dialog's history drop first.
 *
 * A dialog pushes a history entry while it is open and, once it has closed, steps off it with an async
 * `history.back()` (web/src/lib/dialogHistory.ts). A reload issued in that window races the traversal: either
 * the reload is aborted (`net::ERR_ABORTED; maybe frame was detached?`) or the back lands on the NEW page and
 * closes whatever dialog opens there. Nobody presses reload inside those milliseconds; specs do, right after
 * a dialog closes, and with production-like latency (E2E_API_LATENCY_MS) the window is wide enough to
 * hit. "Pending" is a dialog entry on top with no dialog left on screen - a reload made deliberately WITH a
 * dialog open (a record deep link that should land back on it) is not held up. Bounded: a drop that never
 * comes is the app's problem to show, not this helper's to hang on.
 */
function settleBeforeReload(page: Page) {
  const reload = page.reload.bind(page);
  page.reload = async (options) => {
    await page
      .waitForFunction(
        () =>
          (history.state as { hrmsDialog?: boolean } | null)?.hrmsDialog !== true ||
          !!document.querySelector('[role="dialog"], [role="alertdialog"]'),
        undefined,
        { timeout: 10_000 },
      )
      .catch(() => undefined);
    return reload(options);
  };
}

function hardenRequest(req: APIRequestContext) {
  const laneMadeUp = async (res: APIResponse) => {
    if (res.status() === 503) return true;
    if (res.status() === 500) return notTheApps500(res);
    if (res.status() !== 409) return false;
    return /"type"\s*:\s*"\/errors\/aborted"/.test(await res.text().catch(() => ""));
  };
  for (const verb of ["get", "post", "put", "patch", "delete"] as const) {
    const send = req[verb].bind(req) as (url: string, options?: Parameters<APIRequestContext["post"]>[1]) => Promise<APIResponse>;
    const write = verb === "post" || verb === "put" || verb === "patch";
    req[verb] = (async (url: string, options: Parameters<APIRequestContext["post"]>[1] = {}) => {
      const headers = { ...options.headers };
      if (write && !Object.keys(headers).some((h) => h.toLowerCase() === "idempotency-key")) headers["Idempotency-Key"] = crypto.randomUUID();
      const opts = { ...options, headers };
      let res = await send(url, opts);
      for (let attempt = 0; attempt < 3 && (await laneMadeUp(res)); attempt++) {
        if (res.status() === 409) await new Promise((r) => setTimeout(r, 1_000));
        res = await send(url, opts);
      }
      return res;
    }) as APIRequestContext[typeof verb];
  }
}

/**
 * The wire path of a seeded person, found by the email they sign in with.
 *
 * A spec that drives somebody's own record needs `employees/<id>` in the URL, and the id in the URL is the
 * WIRE id - a token the edge decodes per request, not the row id in scripts/seed.sql. So it cannot be
 * hard-coded, and matching on a first name is one seeded joiner away from picking the wrong person. The
 * login email is the one thing that identifies a role's person exactly, and it is already the key `ROLES`
 * is written in.
 *
 * Walked page by page: a list page holds at most 100 rows (`max_page_size`, src/http/pagination.ts
 * clampPageSize) and the seed alone has 100 employees, so a login past the first page is only found by
 * following `next_page_token`.
 */
export async function personPath(page: Page, role: Role): Promise<string> {
  let token = "";
  do {
    const res = await page.request.get(`/v1/employees?max_page_size=100${token ? `&page_token=${encodeURIComponent(token)}` : ""}`);
    expect(res.status(), await res.text()).toBe(200);
    const { results = [], next_page_token } = (await res.json()) as { results?: { path: string; work_email?: string }[]; next_page_token?: string };
    const person = results.find((e) => e.work_email === ROLES[role]);
    if (person) return person.path;
    token = next_page_token ?? "";
  } while (token);
  throw new Error(`e2e: no employee record for ${ROLES[role]}`);
}

/** The id half of `personPath` - what a route wants (`employees/<id>`, `org-chart/<id>`). */
export async function personId(page: Page, role: Role): Promise<string> {
  return (await personPath(page, role)).split("/")[1]!;
}

/**
 * File one day of leave for whoever `employee` is signed in as, and return its path.
 *
 * Specs that decide requests need requests to decide. The seed ships some, but a spec that consumes them is
 * only repeatable until they run out - so anything that approves something files its own first. Two refusals
 * are the app being right rather than a failure, and both are walked past: leave that overlaps leave this
 * person already has, and a day that is a weekend or a holiday.
 *
 * `from` moves the search to a particular day, for the one case where the date matters: a surface that only
 * draws a WINDOW of the calendar (the dashboard's team timeline is two weeks wide) never shows the far-future
 * placeholder days this otherwise picks. Everything else should leave it alone and take the placeholder.
 */
/** How many requests this worker has filed - one day of the calendar each (see the day choice below). */
let filedLeaves = 0;

export async function fileLeave(employee: Page, reason: string, opts?: { from?: string }): Promise<string> {
  // The type with the most days left, not simply the first one. A day of leave is CONSUMED by every spec
  // that files one, so on a database the suite has been run against all afternoon the first type is the one
  // that has run dry - and "not enough Annual balance" is the server being right, not a failure worth
  // debugging.
  const [types, balances] = await Promise.all([
    employee.request.get("/v1/leave-types?page_size=100"),
    employee.request.get("/v1/leave-balances?page_size=100"),
  ]);
  const all = ((await types.json()) as { results?: { path: string }[] }).results ?? [];
  const left = new Map(
    (((await balances.json()) as { results?: { leave_type?: string; balance_days?: number }[] }).results ?? [])
      .map((b) => [b.leave_type ?? "", b.balance_days ?? 0] as const),
  );
  const leaveType = [...all].sort((a, b) => (left.get(b.path) ?? 0) - (left.get(a.path) ?? 0))[0]?.path;
  if (!leaveType) throw new Error("e2e: the org has no leave types to request");

  // A day nobody else is using. Not random: with several specs filing leave for the SAME seeded person at
  // the same moment, random days in one year collide often enough to matter - and a spec that finds "its"
  // request by the date on the row would then act on somebody else's. The worker index and a per-worker
  // counter give every filing in the run its own day, a few years out where nothing real lives.
  const slot = test.info().parallelIndex * 512 + filedLeaves++;
  let day = opts?.from ? new Date(`${opts.from}T00:00:00Z`) : new Date(Date.UTC(2027, 0, 1 + (slot % 1000)));
  for (let tries = 0; tries < 12; tries++) {
    // Built from a UTC instant on purpose, so this reads the same day it was constructed as - the dates this
    // one picks are far-future placeholders, not "today", so the local-day rule above does not apply.
    const on = day.toISOString().slice(0, 10);
    const res = await employee.request.post("/v1/leave-requests", {
      headers: SPA_HEADERS,
      data: { leave_type: leaveType, start_date: on, end_date: on, reason },
    });
    if (res.status() === 200) return ((await res.json()) as { path: string }).path;
    const body = await res.text();
    // An id collision is the server asking to be asked again (two writers picked the same generated id in the
    // same instant, which the parallel lane does hit): retry on the SAME day rather than moving on, because
    // nothing is wrong with the day.
    if (/resource id collision/.test(body)) continue;
    if (!/no working days|overlaps/.test(body)) throw new Error(`e2e: could not file leave: ${body}`);
    day = new Date(day.getTime() + 86_400_000);
  }
  throw new Error("e2e: found no free working day to file leave on");
}

/**
 * A toast, by the text on it.
 *
 * NOT `getByRole("status")`: that matches the screen-reader announcer Radix renders beside the toast, whose
 * text is cleared again a moment later - so an assertion against it is a race that happens to win today, and
 * anything INSIDE it (an Undo button) is not there at all. The toast itself is an `li` in Radix's own labelled
 * region, which is stable and is where the action buttons live.
 */
export function toast(page: Page, text: string | RegExp) {
  return page.getByRole("region", { name: /Notifications/i }).locator("li").filter({ hasText: text });
}

/**
 * Answer the prompt every delete puts up (`useSoftDelete`, and the pages that delete by hand): the dialog
 * titled "Delete …?", pressed through on its own button. `label` is that button when a page names it
 * differently ("Delete task", "Remove").
 */
export async function confirmDelete(page: Page, label: string | RegExp = "Delete") {
  const prompt = page.getByRole("dialog").filter({ hasText: /^(Delete|Remove|Withdraw|Retire) .+\?/ }).last();
  await expect(prompt).toBeVisible({ timeout: 30_000 });
  await prompt.getByRole("button", { name: label, exact: typeof label === "string" }).click();
  await expect(prompt).toHaveCount(0, { timeout: 30_000 });
}

/**
 * A date, as a `<input type="date">` holds it, in the LOCAL day - never `toISOString()`.
 *
 * The app's forms default to the reader's own today (an offer to file remote work "today", a claim dated
 * now). `toISOString()` answers in UTC, which is a DIFFERENT DAY for most of the world for part of every day
 * - IST evening is already tomorrow, US afternoon is still yesterday - so a spec that compares against it
 * passes in the morning and fails after tea. The browser and this process share a machine, so the local day
 * is the one both sides mean.
 */
export function ymd(at: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/**
 * Put one bank on the org's allowed list, and take THAT ONE off again afterwards.
 *
 * The list lives in the shared `settings/organization` blob, so a spec that snapshots it, appends, and later
 * writes the snapshot back deletes whatever another spec added in between - the two specs that need a bank
 * (`bankFormats`, `employeeRecord`) run in parallel and did exactly that to each other. Adding and removing
 * one LINE is the only shape of this that is safe to run beside itself.
 */
export async function withAllowedBank(page: Page, name: string): Promise<() => Promise<void>> {
  await editBanks(page, (banks) => [...banks.filter((b) => b !== name), name]);
  return () => editBanks(page, (banks) => banks.filter((b) => b !== name));
}

/**
 * Read-modify-write the org's bank list, retrying so a concurrent write is merged rather than lost.
 *
 * `If-Match` on the etag this same read carried, not the SPA's own no-etag PATCH (memory
 * settings-lost-update.md - the server takes one, the client just never sends it): without it, two of these
 * running at once (or beside `settingsPanels.spec.ts` editing an unrelated key of this same blob) both read
 * the pre-change row and both "succeed", the second's write silently discarding the first's - a 200 from
 * `wrote.ok()` alone cannot tell that apart from a real success. A 409 here is exactly that collision caught
 * before it lands, not a failure worth surfacing - retried on the freshly re-read row same as the app's own
 * forms do.
 */
async function editBanks(page: Page, change: (banks: string[]) => string[]): Promise<void> {
  await patchOrgSettings(page, (blob) => {
    const banks = Array.isArray(blob.banks) ? (blob.banks as string[]) : [];
    return { ...blob, banks: change(banks) };
  });
}

/**
 * Read-modify-write the shared `settings/organization` blob, retrying so a concurrent write is merged rather
 * than lost. `mutate` gets the FRESH value on every attempt and must return the whole next value (merge in
 * only the keys it actually cares about, spreading the rest through unchanged) - many settings panels
 * (banks, currencies, quick-create menu, letter defaults, the org default department...) share this one row,
 * and specs for several of them run at once.
 *
 * `If-Match` on the etag this same read carried, not the SPA's own no-etag PATCH (memory
 * settings-lost-update.md - the server takes one, the client just never sends it): without it, two writers
 * racing each other both read the pre-change row and both "succeed", the second's write silently discarding
 * the first's - a 200 from `wrote.ok()` alone cannot tell that apart from a real success. A 409 here is
 * exactly that collision caught before it lands, not a failure worth surfacing - retried on the freshly
 * re-read row same as the app's own forms do. Restoring a snapshot taken at a test's own START (rather than
 * re-reading fresh right before the write) is the same bug with extra steps: it discards not just this
 * spec's own change but whatever ANY other spec wrote to a DIFFERENT key of this row in between.
 */
/**
 * Read-modify-write one settings key, retrying the If-Match race.
 *
 * Generic because `organization` is not the only key a spec needs to move: the AI switches live under `ai`,
 * and a spec that turns one on has the same lost-update problem against a parallel worker that this has
 * always had.
 */
export async function patchSettings(page: Page, key: string, mutate: (value: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await page.request.get(`/v1/settings/${key}`);
    const body = res.ok() ? ((await res.json()) as { value?: Record<string, unknown>; etag?: string }) : {};
    const next = mutate(body.value ?? {});
    const wrote = await page.request.patch(`/v1/settings/${key}`, {
      headers: { ...SPA_HEADERS, ...(body.etag ? { "If-Match": body.etag } : {}) },
      data: { value: next },
    });
    if (wrote.ok()) return;
    if (wrote.status() !== 409) throw new Error(`e2e: could not update settings/${key}: ${await wrote.text()}`);
  }
  throw new Error(`e2e: could not update settings/${key} - kept losing the race to a concurrent writer`);
}

export const patchOrgSettings = (page: Page, mutate: (value: Record<string, unknown>) => Record<string, unknown>): Promise<void> =>
  patchSettings(page, "organization", mutate);

/**
 * Fire the five-minute cron tick. **Returns as soon as it is dispatched, NOT when the work is done.**
 *
 * Four AI features are fed by the tick and by nothing else - the embed drain that semantic search, ticket
 * triage and suggestion clustering all read from, and the moderation scan. Waiting five real minutes per
 * assertion is not a test, so `scripts/e2eStack.sh` passes `--test-scheduled`, which serves the cron handler
 * at this path.
 *
 * THIS IS A NUDGE, NOT A SYNCHRONISATION POINT, and an earlier version of this comment claimed the opposite -
 * that it "answers only once the handler has RUN". The worker log settles it: `GET /__scheduled` returns
 * `200 OK (1ms)`, `(2ms)`, `(4ms)` while the drain behind it is embedding hundreds of rows against a model.
 * Wrangler dispatches the scheduled event and answers; the handler runs on after that.
 *
 * So a caller must WAIT FOR THE EFFECT rather than for this call. The semantic-search spec polls the search
 * API until its row is indexed, firing another tick each round; asserting straight after this returned made
 * that test pass or fail on timing, which is precisely the flake it looked like.
 *
 * Straight at the Worker, not through Vite or Prism: `/__scheduled` is wrangler's own route, in neither the
 * SPA's proxy table nor openapi.yaml, so it exists at exactly one origin.
 */
export async function runCron(page: Page, cron = "*/5 * * * *"): Promise<void> {
  const res = await page.request.get(
    `http://127.0.0.1:${lane.workerPort}/__scheduled?cron=${encodeURIComponent(cron)}`,
    { timeout: 120_000 },
  );
  if (!res.ok()) throw new Error(`e2e: the cron tick answered ${res.status()} - is the stack running with --test-scheduled?`);
}

/**
 * Is there a model answering on this machine?
 *
 * The lane points the whole AI layer at `AI_LOCAL_URL` (e2e/e2e.vars) so it can never reach Workers AI. That
 * override stands whether or not anything is listening - with Ollama down the calls fail, services/ai.ts
 * catches and returns an `error` refusal, and every feature falls back, which is the state nearly every spec
 * in this suite expects anyway.
 *
 * Only the last describe of `aiFeatures.spec.ts` needs a model that actually answers, and Ollama is an
 * optional dependency of this repository rather than part of the stack `scripts/e2eStack.sh` starts. So it
 * skips itself
 * rather than failing a run for a tool the machine was never required to have. The consequence worth stating:
 * **a green suite does not mean the AI features were exercised.** Read the skip count.
 */
export async function aiLocalUp(page: Page): Promise<boolean> {
  try {
    // Straight at Ollama, not through the app: the question is whether the dependency is up, and asking the
    // Worker would answer "a feature is off" and "the model is down" with the same silence.
    // Twenty seconds, not three. A server busy paging a 28 GB model into memory answers nothing, and at a
    // short timeout that is indistinguishable from a machine with no Ollama - so the specs skipped silently
    // while a model was in fact right there, which is the failure this probe exists to avoid reporting as
    // success.
    const res = await page.request.get("http://127.0.0.1:11434/api/tags", { timeout: 20_000 });
    return res.ok();
  } catch {
    return false;
  }
}

/** The local day `n` days from now (negative for the past), as a date input wants it. */
export function inDays(n: number): string {
  return ymd(new Date(Date.now() + n * 86_400_000));
}

/**
 * The seeded public holidays, as `YYYY-MM-DD`, taken from the bootstrap generator so the two cannot drift.
 *
 * A WEEKDAY IS NOT A WORKING DAY. The list covers one calendar year (`HOLIDAY_YEAR`), and both kinds are in
 * it: the leave forms charge against every holiday the org has not disabled, so an "optional" one prices a
 * day at zero exactly like a company-wide one does.
 */
const SEEDED_HOLIDAYS = new Set(
  HOLIDAYS.map((h) => `${HOLIDAY_YEAR}-${String(h.month).padStart(2, "0")}-${String(h.day).padStart(2, "0")}`),
);

/** A Mon-Fri that the org actually works: not a weekend, and not one of the seeded holidays. */
function isWorkingDay(day: Date): boolean {
  return day.getDay() !== 0 && day.getDay() !== 6 && !SEEDED_HOLIDAYS.has(ymd(day));
}

/**
 * The next working day at least `after` days out, as a date input wants it.
 *
 * Leave, overtime and remote work are all priced in WORKING days: a request that lands entirely on a weekend
 * or a holiday costs zero days, so the forms drop it and the page never shows what the spec is asking about. A
 * working day is the only date that behaves the same whichever day the suite happens to run on - which is why
 * "tomorrow" is not good enough (on a Friday it is Saturday, and the form is right to refuse it).
 *
 * Holidays are skipped as well as weekends, and that half is a CALENDAR TIME BOMB when it is missing: it fires
 * only in the weeks where a seeded holiday happens to land on the date the arithmetic reaches, months after
 * the spec was written and with nothing in the tree having changed.
 */
export function nextWeekday(after = 1): string {
  for (let n = after; n < after + 14; n++) {
    const day = new Date(Date.now() + n * 86_400_000);
    if (isWorkingDay(day)) return ymd(day);
  }
  throw new Error("e2e: a fortnight with no working day in it");
}

/**
 * A working day nobody else is asking for: unique per worker and per call, a few weeks out.
 *
 * `nextWeekday()` answers the same date for every spec, which is what a form-level test wants and what a
 * FILING test must not use - two specs asking the same person for the same day overlap, and the form is right
 * to refuse the second. Use this wherever a request is actually submitted.
 *
 * Skips holidays as well as weekends, for the reason `nextWeekday` gives: worker 0's first claim is fourteen
 * days out, which on a run in mid-September is Gandhi Jayanti, and a form asked for one day of leave over it
 * correctly answers zero.
 */
export function ownWeekday(): string {
  const slot = test.info().parallelIndex * 64 + claimedWeekdays++;
  const from = 14 + slot * 3;
  for (let n = from; n < from + 14; n++) {
    const day = new Date(Date.now() + n * 86_400_000);
    if (isWorkingDay(day)) return ymd(day);
  }
  throw new Error("e2e: a fortnight with no working day in it");
}

/** How many weekdays this worker has claimed - one per filing (see ownWeekday). */
let claimedWeekdays = 0;

/**
 * Go to an app route and wait for the shell to render it. `<main aria-label="Main content">` is the app's
 * own landmark (web/src/App.tsx), so this waits on the thing the app itself considers "the page", not on a
 * class name that a restyle would move.
 *
 * Pass `heading` (the page's `<h1>`, from its PageHeader) wherever landing on the WRONG page could still let
 * a spec pass: an unrecognised route key renders the dashboard rather than failing, and the dashboard offers
 * shortcuts - "Request leave", "New reimbursement" - with the same names as the buttons on the pages they
 * lead to. A spec can therefore drive a whole flow from the wrong page without noticing.
 */
export async function gotoRoute(page: Page, route: string, heading?: string) {
  // The navigation is inside the retry below, not in front of it. `page.goto` can fail to START - `net::
  // ERR_ABORTED`, the shape a dropped request or a frame going away under a wide run leaves - and that is the
  // one failure with nothing on screen to recover from, so the shell's own "Try again" is no use and the
  // helper used to throw before reaching any of its recovery. Asked again, it lands. Re-navigating is only for
  // a goto that threw: a page that loaded slowly is left alone to finish.
  let landed = false;
  // 30s, not the 5s default. A first landing on a route compiles its chunk in Vite, fetches the page's data
  // and paints - and on a wide run the Worker behind it is answering two dozen browsers at once. At the
  // default this fails as "no <h1> Documents" in the middle of a spec that has nothing to do with navigation,
  // which reads like the page being broken rather than the stack being busy. Every other wait in the suite is
  // already given room; this one was not, so it was the first thing to go under load.
  //
  // The shell's OWN recovery is taken when the bootstrap read is the thing that failed: one 500 from a
  // restarting dev Worker leaves "Can't reach the server ... Try again" where `<main>` belongs, and every
  // spec that happens to navigate in that window dies of somebody else's hiccup. Pressing what the app puts
  // in front of a real user in exactly this situation is the honest recovery - and a server that is genuinely
  // down still fails here, since the retry has to actually produce the page.
  await expect(async () => {
    if (!landed) {
      await page.goto(`/${route}`);
      landed = true;
    }
    // Only while the shell itself is missing: a "Try again" INSIDE a rendered page belongs to that page's own
    // failed panel (`failedRead.spec.ts` is about pressing it deliberately), and is none of this helper's
    // business.
    if (!(await page.getByRole("main").count())) {
      const retry = page.getByRole("button", { name: "Try again" });
      if (await retry.count()) await retry.first().click({ timeout: 5_000 }).catch(() => undefined);
    }
    // A RECORD route (`/<page>/<id>`) opens that record's own modal as soon as its row lands, and a modal
    // aria-hides the shell behind it - so `main` stops being reachable BY DESIGN, a second or so after the
    // page renders. Waiting only on the landmark therefore turns into a race the deep link loses: the
    // dialog is equally good proof that the route rendered what it was asked for.
    if (route.includes("/") && (await page.getByRole("dialog").count())) return;
    await expect(page.getByRole("main")).toBeVisible({ timeout: 30_000 });
  }).toPass({ timeout: 90_000 });
  if (heading) await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible({ timeout: 30_000 });
}

/**
 * A person nobody else in the suite is using: a throwaway employee, with the login that comes with them.
 *
 * Access-control specs cannot practise on the seeded five. Every other spec in the lane signs in as those
 * logins, so a rule granted to `emp@example.com` - even for the second it takes to read it back - changes
 * what another worker's browser is being asked to prove at that moment. A person created for one test and
 * retired at the end of it is invisible to all of them.
 *
 * `services/employees.ts` provisions the login as the employee is created, so the returned email can be
 * signed in with straight away (`as({ email })`).
 */
export async function makeThrowawayPerson(page: Page, tag: string): Promise<{ path: string; email: string; name: string }> {
  const stamp = `${test.info().parallelIndex}${Date.now() % 1_000_000}`;
  const last = `${tag}${stamp}`;
  const email = `e2e.${tag.toLowerCase()}.${stamp}@example.com`;
  const res = await page.request.post("/v1/employees", {
    headers: SPA_HEADERS,
    data: { first_name: "E2E", last_name: last, work_email: email },
  });
  expect(res.status(), await res.text()).toBe(200);
  const path = ((await res.json()) as { path: string }).path;
  throwawayEmails.set(path, email);
  return { path, email, name: `E2E ${last}` };
}

// Who each throwaway person is, and the browsers signed in as anybody (filled by the `as` fixture), so retiring
// a person can close their pages first. Per worker process, like everything else here.
const throwawayEmails = new Map<string, string>();
const signedIn = new Map<string, BrowserContext[]>();

/**
 * Take a throwaway person back out - a soft delete, never `?force=true`.
 *
 * The login provisioned alongside them is an undeclared reference (users has no delete route at all -
 * "provisioned when an employee is created, disabled rather than removed", src/routes/users.ts), so a hard
 * purge answers 409 and cleans up nothing.
 */
export async function retireThrowawayPerson(page: Page, path: string): Promise<void> {
  // Their own pages go first. A page still open on the app keeps writing as them (a theme preference, a read
  // receipt), and once the account is retired the server rightly refuses it - a 403 in the console of a spec
  // whose assertions had all passed.
  const email = throwawayEmails.get(path);
  for (const context of email ? signedIn.get(email) ?? [] : []) {
    for (const p of context.pages()) await p.close().catch(() => undefined);
  }
  const got = await page.request.get(`/v1/${path}`);
  if (!got.ok()) return;
  const { etag } = (await got.json()) as { etag: string };
  await page.request.delete(`/v1/${path}`, { headers: { ...SPA_HEADERS, "If-Match": etag } }).catch(() => undefined);
}

/** The `users/<id>` path of a login, by the email it signs in with - what an access rule's subject is. */
export async function userPath(page: Page, email: string): Promise<string> {
  const res = await page.request.get("/v1/users?page_size=200");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; email?: string }[] };
  const user = results.find((u) => u.email === email);
  if (!user) throw new Error(`e2e: no login for ${email}`);
  return user.path;
}

/** Every access rule the caller can read - the wire truth behind whatever the ACL modal is drawing. */
/**
 * Every access rule, or those on one collection (`?collection=` keeps the `**` rules too).
 *
 * EVERY PAGE, not the first: other specs write rules concurrently - a role copy alone lands a couple of hundred
 * - so a rule this spec wrote a moment ago can already be off the newest page.
 */
export async function accessRules(page: Page, collection?: string): Promise<AccessRuleRow[]> {
  const all: AccessRuleRow[] = [];
  let token: string | undefined;
  do {
    const params = new URLSearchParams({ max_page_size: "100" });
    if (collection) params.set("collection", collection);
    if (token) params.set("page_token", token);
    const res = await page.request.get(`/v1/access-rules?${params.toString()}`);
    expect(res.status(), await res.text()).toBe(200);
    const body = (await res.json()) as { results?: AccessRuleRow[]; next_page_token?: string };
    all.push(...(body.results ?? []));
    token = body.next_page_token;
  } while (token);
  return all;
}

export type AccessRuleRow = {
  path: string;
  subject_kind?: string;
  subject?: string;
  collection?: string;
  scope?: string;
  level?: string;
  verb?: string;
  effect?: string;
  status?: string;
  expire_time?: string;
};

/** The capability set the server issued this caller - the only authority on what they may actually do. */
export async function capabilitiesOf(page: Page): Promise<string[]> {
  const res = await page.request.get("/v1/users/me");
  expect(res.status(), await res.text()).toBe(200);
  const me = (await res.json()) as { caller_access?: { capabilities?: string[] } };
  return me.caller_access?.capabilities ?? [];
}
