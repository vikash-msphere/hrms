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
];

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
      page.on("console", (m) => m.type() === "error" && record(m.text()));
      page.on("pageerror", (e) => record(`pageerror: ${e.message}`));
      return page;
    });

    for (const context of contexts) await context.close();
    // Asserted after the test body so a genuine assertion failure is reported first and this never masks it.
    expect(failures, "the app logged errors in the browser console").toEqual([]);
  },
});

export { expect };

/**
 * File one day of leave for whoever `employee` is signed in as, and return its path.
 *
 * Specs that decide requests need requests to decide. The seed ships some, but a spec that consumes them is
 * only repeatable until they run out - so anything that approves something files its own first. Two refusals
 * are the app being right rather than a failure, and both are walked past: leave that overlaps leave this
 * person already has, and a day that is a weekend or a holiday.
 */
export async function fileLeave(employee: Page, reason: string): Promise<string> {
  const types = await employee.request.get("/v1/leave-types?page_size=1");
  const leaveType = ((await types.json()) as { results?: { path: string }[] }).results?.[0]?.path;
  if (!leaveType) throw new Error("e2e: the org has no leave types to request");

  // A different starting day per call, so repeat runs (and retries) do not collide with their own leftovers.
  let day = new Date(Date.UTC(2027, 0, 1 + Math.floor(Math.random() * 300)));
  for (let tries = 0; tries < 12; tries++) {
    const ymd = day.toISOString().slice(0, 10);
    const res = await employee.request.post("/v1/leave-requests", {
      headers: SPA_HEADERS,
      data: { leave_type: leaveType, start_date: ymd, end_date: ymd, reason },
    });
    if (res.status() === 200) return ((await res.json()) as { path: string }).path;
    const body = await res.text();
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
  await expect(page.getByRole("main")).toBeVisible();
  if (heading) await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
}
