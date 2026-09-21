/// <reference types="vite/client" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.values(migrationModules).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { app } from "../src/index";
import { budgetFor } from "../src/middleware/rateLimit";
import { keyedCounter } from "../src/lib/isolateRate";

// Per-caller request budgets inside /v1 (middleware/rateLimit.ts).
//
// Authentication bounds WHO, not HOW OFTEN. Everything under /v1 was authenticated and authorized and had no
// ceiling at all, so a leaked API key reading entirely inside its own scope, or a client stuck in a loop,
// could drive the expensive surfaces - PDF rendering, the cross-collection fan-outs, the batch transport - as
// fast as the network allowed. None of that is an access-control failure, so nothing else in the app had an
// opinion about it.
//
// What is tested here is the LOGIC, not the numbers: which surface a path is charged to, that one caller
// cannot spend another's allowance, and the two traps - a batch's sub-requests must not be charged again, and
// a 429 has to carry the Retry-After a client backs off on.

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const b = env as unknown as Bindings;
let deps: Deps;

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
  await deps.db.insert(schema.roles).values([{ name: "super_admin", label: "Super" }, { name: "employee", label: "Employee" }]).onConflictDoNothing();
  await deps.db.insert(schema.accessRules).values([
    { subject: "super_admin", subjectKind: "role", namespace: "*", pattern: "**", scopeKind: "all", scopeCode: "", matchCode: null, level: "admin", effect: "allow" },
    { subject: "super_admin", subjectKind: "role", namespace: "*", pattern: "**", scopeKind: "all", scopeCode: "", matchCode: null, level: null, effect: "allow" },
  ]).onConflictDoNothing();
  // The dev-auth bypass (DEV_FAKE_EMAIL, set for the whole suite) is the ambient credential; give it a user.
  await deps.db.insert(schema.users).values({ uuid: genId(), code: `u-${genId().slice(0, 4)}`, email: "dev@example.com", role: "super_admin" }).onConflictDoNothing();
});

const call = (path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { "X-Requested-By": "hrms-spa", ...(init.headers as Record<string, string>) } }, b as unknown as Record<string, unknown>);

describe("keyedCounter: the budget belongs to the caller, not the isolate", () => {
  it("counts each key separately", () => {
    const rate = keyedCounter(2);
    expect(rate.throttled("a", 0)).toBe(false);
    expect(rate.throttled("a", 0)).toBe(false);
    expect(rate.throttled("a", 0)).toBe(true);
    // b has spent nothing - one noisy caller must not close the door on everyone else, which is exactly what
    // a single shared counter would do.
    expect(rate.throttled("b", 0)).toBe(false);
  });

  it("resets when the window rolls over", () => {
    const rate = keyedCounter(1, 1000);
    expect(rate.throttled("a", 0)).toBe(false);
    expect(rate.throttled("a", 500)).toBe(true);
    expect(rate.throttled("a", 1000)).toBe(false);
  });

  it("stays bounded in memory without ever granting more than the budget", () => {
    const rate = keyedCounter(1, 1000, 4);
    // Fill past the cap with expired windows, which is what the sweep is for.
    for (let i = 0; i < 20; i++) expect(rate.throttled(`k${i}`, i * 2000)).toBe(false);
    // A sweep must never hand a caller a fresh allowance inside their own window.
    const now = 100_000;
    expect(rate.throttled("live", now)).toBe(false);
    expect(rate.throttled("live", now)).toBe(true);
  });

  it("spends as many units as the call costs", () => {
    const rate = keyedCounter(10);
    // A batch envelope of four sub-reads is four reads of work, so it spends four (middleware/rateLimit.ts).
    expect(rate.throttled("a", 0, 4)).toBe(false);
    expect(rate.throttled("a", 0, 4)).toBe(false);
    expect(rate.throttled("a", 0, 4)).toBe(true); // 12 > 10
    // Still per key: an expensive caller does not spend anybody else's allowance.
    expect(rate.throttled("b", 0, 10)).toBe(false);
  });

  it("never lets a call cost less than one", () => {
    const rate = keyedCounter(3);
    // A cost derived from a request body is a number a client can influence, so zero, a fraction and a
    // negative must all still spend a whole unit - otherwise declaring one buys unlimited free calls.
    for (const cost of [0, 0.4, -5]) expect(rate.throttled("a", 0, cost)).toBe(false);
    expect(rate.throttled("a", 0, 0)).toBe(true); // three units spent, not zero
  });

  it("refuses a call that cannot fit the budget, and still spends it", () => {
    const rate = keyedCounter(5);
    // The work is what is bounded, so a single oversized request must not slip through under a budget too
    // small to hold it - and must not leave the window looking untouched afterwards either.
    expect(rate.throttled("a", 0, 9)).toBe(true);
    expect(rate.throttled("a", 0)).toBe(true);
  });

  it("retryAfterSeconds is what is LEFT of the window, not its length", () => {
    // Before anything is counted there is no window to be part-way through, so the full length is the only
    // honest answer.
    const rate = keyedCounter(1, 60_000);
    expect(rate.retryAfterSeconds).toBe(60);
    // A window opened at t=0 and refused at t=59s clears one second later. Advertising 60 there parks a client
    // that honours the header for a whole extra window over a burst that has already passed.
    expect(rate.throttled("k", 0)).toBe(false);
    expect(rate.throttled("k", 59_000)).toBe(true);
    expect(rate.retryAfterSeconds).toBe(1);
    // Never 0: a `Retry-After: 0` invites the retry the same window would refuse again.
    expect(rate.throttled("k", 59_999)).toBe(true);
    expect(rate.retryAfterSeconds).toBe(1);
    // The next window is reported from its own start.
    expect(rate.throttled("k", 60_000)).toBe(false);
    expect(rate.throttled("k", 75_000)).toBe(true);
    expect(rate.retryAfterSeconds).toBe(45);
  });
});

describe("budgetFor: which surface a request is charged to", () => {
  it("charges document rendering to the render budget", () => {
    for (const p of [
      "/v1/personal-documents:generateLetter",
      "/v1/personal-documents:generateForm16",
      "/v1/personal-documents:previewLetter",
      "/v1/payslips:previewTemplate",
      "/v1/payroll-runs/abc:bankFile",
    ]) {
      expect(budgetFor("POST", p).name, p).toBe("render");
    }
  });

  // The list above was written from the personal-documents surfaces and stopped there, so every PDF the app
  // builds somewhere else fell through to the catch-all at 3000 - seventy-five times the ceiling meant for a
  // render, on the one class of request that exhausts an invocation rather than a database.
  it("charges the renderers that live outside personal-documents to the render budget too", () => {
    for (const p of [
      "/v1/reviews/abc:pdf",                 // services/reviews.ts       renderLetterPdf
      "/v1/offers/abc:letter",               // services/offerLetter.ts   renderLetterPdf
      "/v1/personal-documents/abc:print",    // services/letterPrint.ts   renderLetterPdf
      "/v1/letterheads/abc:preview",         // services/letterheads.ts   renderLetterPdf
      "/v1/payroll-runs/abc:previewPayslip", // services/payroll.ts       renderPayslipPdf
    ]) {
      expect(budgetFor("POST", p).name, p).toBe("render");
    }
  });

  // The mirror of the bug above, and the reason the letterhead entry is matched on its collection rather than
  // on the `:preview` spelling: these two hand back the slip the publish job ALREADY rendered, read out of R2
  // and decrypted. Charging an object read to a budget sized for PDF construction would put an employee
  // opening their own payslips under a ceiling of forty a minute.
  it("leaves the stored-object reads on the catch-all", () => {
    expect(budgetFor("POST", "/v1/payslips/abc:preview").name).toBe("api");
    expect(budgetFor("POST", "/v1/payslips/abc:download").name).toBe("api");
  });

  it("charges the cross-collection fan-outs to the fan-out budget", () => {
    for (const p of ["/v1/search", "/v1/people-analytics", "/v1/table-views/abc:run"]) {
      expect(budgetFor("GET", p).name, p).toBe("fan-out");
    }
  });

  // The three counts the SPA fires on EVERY page mount (the approvals badge, the tab-bar dots, the KPI tiles)
  // are not gesture-driven and their width does not grow with the org, so they are budgeted as navigation
  // rather than as scripted fan-out. Sharing the fan-out bucket meant the chrome of ordinary browsing spent a
  // ceiling written for abuse - and starved ⌘K search, which was refused on a run that made 18 searches.
  it("charges the per-navigation chrome counts to their own budget, above the fan-out one", () => {
    for (const p of ["/v1/dashboard-summary", "/v1/approvals-summary", "/v1/activity-counts"]) {
      expect(budgetFor("GET", p).name, p).toBe("summary");
    }
    expect(budgetFor("GET", "/v1/approvals-summary").limit).toBeGreaterThan(budgetFor("GET", "/v1/search").limit);
    // Still under the catch-all: each one is several COUNT queries where an ordinary read is one.
    expect(budgetFor("GET", "/v1/approvals-summary").limit).toBeLessThan(budgetFor("GET", "/v1/employees").limit);
  });

  // `:run` is a verb several collections use, so a loose match on it in the fan-out entry claimed
  // `/v1/batch:run` first and charged the transport the whole SPA reads through to the tighter budget.
  // First match wins, so this pins the ordering as much as the mapping.
  it("charges the batch envelope to its own budget, not to the fan-out one", () => {
    expect(budgetFor("POST", "/v1/batch:run").name).toBe("batch");
    expect(budgetFor("POST", "/v1/cron-runs:run").name).toBe("fan-out");
  });

  it("charges an ordinary read to the catch-all", () => {
    expect(budgetFor("GET", "/v1/employees").name).toBe("api");
    expect(budgetFor("PATCH", "/v1/holidays/abc").name).toBe("api");
  });

  it("the expensive surfaces are bounded well below the catch-all", () => {
    // The ordering of the table is load-bearing (first match wins), so a fan-out path must not be scored as
    // an ordinary read - which is what would happen if the catch-all were ever moved above it.
    expect(budgetFor("GET", "/v1/search").limit).toBeLessThan(budgetFor("GET", "/v1/employees").limit);
    expect(budgetFor("POST", "/v1/personal-documents:generateLetter").limit).toBeLessThan(budgetFor("GET", "/v1/search").limit);
  });
});

describe("the limiter in the request chain", () => {
  it("refuses with 429 and a Retry-After once a budget is spent", async () => {
    const { limit } = budgetFor("POST", "/v1/personal-documents:previewLetter");
    // THE PRECONDITION, checked rather than assumed. The counter is a FIXED 60s window opened by the first
    // call (lib/isolateRate.ts), and the middleware reads `Date.now()` with no seam - so this test only means
    // anything if all `limit + 2` calls land inside one window. Unloaded that is 42 requests in ~300ms, but
    // under a saturated gate a worker can stall, and if the window rolls mid-loop the counter resets, 429
    // never comes and the assertion below fails with nothing to say about why.
    //
    // This once failed in a full-gate run and never reproduced (the run in question was starved by an
    // unmemoized Intl formatter, since fixed). It is left instrumented rather than rewritten because the two
    // candidate fixes - a clock seam in the middleware, or exhausting the budget through the limiter directly
    // - are both design choices for whoever owns this, and a guess would produce a test that passes for the
    // wrong reason.
    const startedAt = Date.now();
    let last = await call("/v1/personal-documents:previewLetter", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    // Below the ceiling the limiter is transparent: whatever the route answers (a validation error here) is
    // NOT a 429. That is the half that proves the assertion after the loop is about the budget.
    expect(last.status).not.toBe(429);
    for (let i = 0; i < limit + 2 && last.status !== 429; i++) {
      last = await call("/v1/personal-documents:previewLetter", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    }
    const elapsed = Date.now() - startedAt;
    if (last.status !== 429 && elapsed >= 60_000) {
      throw new Error(`the rate-limit window rolled over mid-test (${elapsed}ms for ${limit + 2} calls, window is 60000ms), so the budget reset and 429 was never reachable - this is the test losing its precondition under load, not the limiter failing`);
    }
    expect(last.status).toBe(429);
    // Without this header a client cannot honour the refusal and simply retries into a closed door.
    expect(last.headers.get("Retry-After")).toBe("60");
    const body = (await last.json()) as { type?: string; detail?: string };
    expect(body.type).toBe("/errors/resource-exhausted");
    expect(body.detail).toContain("render");
  });

  it("does not charge a batch's sub-requests a second time", async () => {
    // routes/batch.ts re-dispatches each sub-request through the WHOLE chain, so without the __sharedCtx skip
    // one envelope would be charged up to twenty times OVER AND ABOVE the sub-read cost the envelope already
    // paid on the way in - making the transport that exists to cost less the fastest way to hit a limit.
    // 20 envelopes of 20 is 400 sub-reads, comfortably inside the batch budget; charged again per sub-request
    // it would be 8,000 and refuse.
    const requests = Array.from({ length: 20 }, () => ({ path: "/v1/holidays" }));
    let last: Response | undefined;
    for (let i = 0; i < 20; i++) {
      last = await call("/v1/batch:run", { method: "POST", body: JSON.stringify({ requests }), headers: { "content-type": "application/json" } });
      if (last.status === 429) break;
    }
    expect(last!.status).not.toBe(429);
  });

  it("charges a malformed envelope one unit rather than refusing it as over budget", async () => {
    // The route's validator is what rejects a bad envelope, with a 400 that says so. A limiter that threw its
    // own error over an unreadable body would answer 429 to what is really a client mistake.
    const res = await call("/v1/batch:run", { method: "POST", body: "not json", headers: { "content-type": "application/json" } });
    expect(res.status).not.toBe(429);
    // And a 400, not the 500 an unmapped HTTPException used to produce - see test/errorHandler.test.ts. Pinned
    // here too because this is the request that found it: the limiter reads the same unparseable body first.
    expect(res.status).toBe(400);
  });

  // A sub-request is skipped by the limiter outright (the `__sharedCtx` branch), which is right for the
  // envelope's own count - it was charged on the way in - and wrong for everything else: a sub-read never
  // touched the budget its own path matches. So a GET fan-out was reachable through the transport at the
  // batch budget's 6000 a minute rather than the 120 it gets when called directly, fifty times the ceiling
  // written for the surfaces whose cost is a query per collection. Not a hole only an attacker would find
  // either: web/src/lib/getCoalescer.ts is a universal GET coalescer, so the SPA already sends every one of
  // them through here, and the fan-out budget bound nobody who used the transport at all.
  it("charges a fan-out carried inside an envelope to the fan-out budget", async () => {
    const fanOut = budgetFor("GET", "/v1/search").limit;
    const perEnvelope = 20;
    const requests = Array.from({ length: perEnvelope }, () => ({ path: "/v1/search?q=ab" }));
    let sent = 0;
    let last: Response | undefined;
    // Bounded at three times what the fan-out budget allows, so a failure here reads as "never refused"
    // rather than "refused late" - and it is still far short of what the batch budget alone would permit,
    // which is the whole point.
    for (; sent < (fanOut / perEnvelope) * 3; sent++) {
      last = await call("/v1/batch:run", { method: "POST", body: JSON.stringify({ requests }), headers: { "content-type": "application/json" } });
      if (last.status === 429) break;
    }
    expect(last!.status).toBe(429);
    // NAMED fan-out, not batch: the envelope's own budget is nowhere near spent, and a client told "too many
    // batch requests" would coalesce less, which is the opposite of the fix.
    const body = (await last!.json()) as { detail?: string };
    expect(body.detail).toContain("fan-out");
    // Charged per sub-read, so the budget is gone in about limit/20 envelopes rather than limit of them.
    expect(sent).toBeLessThanOrEqual(fanOut / perEnvelope);
    // Spending a fan-out budget means actually issuing the fan-out: about `limit` real searches against D1
    // before the refusal arrives, which is the one test in this suite that does not fit the 5s default. It
    // passed alone and failed inside the full run, which is the shape of a timeout that is really a load
    // measurement - so the budget is stated here rather than left to depend on how busy the machine is.
  }, 30_000);

  // LAST in this file on purpose: it drives the batch budget to its ceiling, and the budgets live for the
  // isolate, so anything after it would start out of allowance.
  //
  // The budget is denominated in SUB-READS, not in envelopes. Charged one unit each, it bounded nothing on the
  // fan-out side while being the tightest ceiling anywhere on the SPA's read path - so coalescing reads, which
  // is what the transport exists for, ran a client out of budget sooner than not coalescing did.
  // 20s, not the 5s default: this case drives a real budget to exhaustion through the whole request chain,
  // which is dozens of round trips - about 4s on an idle machine and past the default under any parallel load
  // (a full `vitest run`, a dev server, an e2e lane). It failed as a timeout rather than an assertion, which
  // reads as a broken limiter and is nothing of the kind.
  it("charges a batch envelope its sub-read count, not one per envelope", { timeout: 20_000 }, async () => {
    const { limit } = budgetFor("POST", "/v1/batch:run");
    const requests = Array.from({ length: 20 }, () => ({ path: "/v1/holidays" }));
    let sent = 0;
    for (;;) {
      const res = await call("/v1/batch:run", { method: "POST", body: JSON.stringify({ requests }), headers: { "content-type": "application/json" } });
      if (res.status === 429) break;
      // Counted per envelope, `limit` of them would all be allowed. The loop would then be the assertion's
      // failure mode rather than its result, so it is bounded well below that.
      if (++sent > limit / 10) break;
    }
    // Full envelopes run out after roughly limit/20 of them - the earlier cases in this describe spent some of
    // the same principal's allowance, so the bound is one-sided: what matters is that it is nowhere near
    // `limit` envelopes, which is what counting them one apiece would have allowed.
    expect(sent).toBeLessThanOrEqual(limit / 20);
  });
});
