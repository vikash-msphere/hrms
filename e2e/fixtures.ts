import { readFileSync } from "node:fs";
import { test as base, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { sealSession } from "../src/lib/session";

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
   * Every page it hands back is watched: if the app logs an error or throws, the test fails at teardown with
   * the message. A page that is EXPECTED to log (a spec deliberately provoking a failed request) opts out
   * with `allowConsoleErrors`.
   */
  as: (role: Role) => Promise<Page>;
};

/** Stop treating console errors matching `pattern` as a failure on this page. */
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
export async function enableTelemetry(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __hrmsSentryOptIn?: boolean }).__hrmsSentryOptIn = true;
  });
}

const allowed = new WeakMap<Page, RegExp[]>();

async function signIn(browser: Browser, baseURL: string, role: Role): Promise<BrowserContext> {
  const now = Date.now();
  const token = await sealSession({ email: ROLES[role], iat: now, exp: now + 60 * 60_000 }, SESSION_KEY);
  const context = await browser.newContext({ baseURL });
  await context.addCookies([{ name: SESSION_COOKIE, value: token, url: baseURL }]);
  return context;
}

export const test = base.extend<Fixtures>({
  as: async ({ browser, baseURL }, use) => {
    if (!baseURL) throw new Error("e2e: no baseURL configured");
    const contexts: BrowserContext[] = [];
    const failures: string[] = [];

    await use(async (role) => {
      const context = await signIn(browser, baseURL, role);
      contexts.push(context);
      const page = await context.newPage();
      allowed.set(page, []);
      const record = (text: string) => {
        const skip = [...IGNORED_CONSOLE, ...(allowed.get(page) ?? [])].some((p) => p.test(text));
        if (!skip) failures.push(`[${role}] ${text.slice(0, 300)}`);
      };
      page.on("console", (m) => {
        if (m.type() !== "error") return;
        if (TELEMETRY_URL.test(m.location()?.url ?? "")) return;
        record(m.text());
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

    for (const context of contexts) await context.close();
    // Asserted after the test body so a genuine assertion failure is reported first and this never masks it.
    expect(failures, "the app logged errors in the browser console").toEqual([]);
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
 * The wire path of a seeded person, found by the email they sign in with.
 *
 * A spec that drives somebody's own record needs `employees/<id>` in the URL, and the id in the URL is the
 * WIRE id - a token the edge decodes per request, not the row id in scripts/seed.sql. So it cannot be
 * hard-coded, and matching on a first name is one seeded joiner away from picking the wrong person. The
 * login email is the one thing that identifies a role's person exactly, and it is already the key `ROLES`
 * is written in.
 */
export async function personPath(page: Page, role: Role): Promise<string> {
  const res = await page.request.get("/v1/employees?page_size=200");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; work_email?: string }[] };
  const person = results.find((e) => e.work_email === ROLES[role]);
  if (!person) throw new Error(`e2e: no employee record for ${ROLES[role]}`);
  return person.path;
}

/** The id half of `personPath` - what a hash route wants (`employees/<id>`, `org-chart/<id>`). */
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

/** Read-modify-write the org's bank list, retrying so a concurrent write is merged rather than lost. */
async function editBanks(page: Page, change: (banks: string[]) => string[]): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await page.request.get("/v1/settings/organization");
    const blob = res.ok() ? (((await res.json()) as { value?: Record<string, unknown> }).value ?? {}) : {};
    const banks = Array.isArray(blob.banks) ? (blob.banks as string[]) : [];
    const next = change(banks);
    const wrote = await page.request.patch("/v1/settings/organization", {
      headers: SPA_HEADERS,
      data: { value: { ...blob, banks: next } },
    });
    if (wrote.ok()) return;
  }
  throw new Error("e2e: could not update the org's bank list");
}

/** The local day `n` days from now (negative for the past), as a date input wants it. */
export function inDays(n: number): string {
  return ymd(new Date(Date.now() + n * 86_400_000));
}

/**
 * The next Mon-Fri at least `after` days out, as a date input wants it.
 *
 * Leave, overtime and remote work are all priced in WORKING days: a request that lands entirely on a weekend
 * costs zero days, so the forms drop it and the page never shows what the spec is asking about. A weekday is
 * the only date that behaves the same whichever day the suite happens to run on - which is why "tomorrow" is
 * not good enough (on a Friday it is Saturday, and the form is right to refuse it).
 */
export function nextWeekday(after = 1): string {
  for (let n = after; n < after + 7; n++) {
    const day = new Date(Date.now() + n * 86_400_000);
    if (day.getDay() !== 0 && day.getDay() !== 6) return ymd(day);
  }
  throw new Error("e2e: a week with no weekday in it");
}

/**
 * A weekday nobody else is asking for: unique per worker and per call, a few weeks out.
 *
 * `nextWeekday()` answers the same date for every spec, which is what a form-level test wants and what a
 * FILING test must not use - two specs asking the same person for the same day overlap, and the form is right
 * to refuse the second. Use this wherever a request is actually submitted.
 */
export function ownWeekday(): string {
  const slot = test.info().parallelIndex * 64 + claimedWeekdays++;
  for (let n = 14 + slot * 3; n < 14 + slot * 3 + 7; n++) {
    const day = new Date(Date.now() + n * 86_400_000);
    if (day.getDay() !== 0 && day.getDay() !== 6) return ymd(day);
  }
  throw new Error("e2e: a week with no weekday in it");
}

/** How many weekdays this worker has claimed - one per filing (see ownWeekday). */
let claimedWeekdays = 0;

/**
 * Go to a hash route and wait for the shell to render it. `<main aria-label="Main content">` is the app's
 * own landmark (web/src/App.tsx), so this waits on the thing the app itself considers "the page", not on a
 * class name that a restyle would move.
 *
 * Pass `heading` (the page's `<h1>`, from its PageHeader) wherever landing on the WRONG page could still let
 * a spec pass: an unrecognised route key renders the dashboard rather than failing, and the dashboard offers
 * shortcuts - "Request leave", "New reimbursement" - with the same names as the buttons on the pages they
 * lead to. A spec can therefore drive a whole flow from the wrong page without noticing.
 */
export async function gotoRoute(page: Page, route: string, heading?: string) {
  await page.goto(`/#/${route}`);
  // 30s, not the 5s default. A first landing on a route compiles its chunk in Vite, fetches the page's data
  // and paints - and on a wide run the Worker behind it is answering two dozen browsers at once. At the
  // default this fails as "no <h1> Documents" in the middle of a spec that has nothing to do with navigation,
  // which reads like the page being broken rather than the stack being busy. Every other wait in the suite is
  // already given room; this one was not, so it was the first thing to go under load.
  await expect(page.getByRole("main")).toBeVisible({ timeout: 30_000 });
  if (heading) await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible({ timeout: 30_000 });
}
