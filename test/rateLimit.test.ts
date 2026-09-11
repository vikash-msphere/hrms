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

  it("retryAfterSeconds describes the window", () => {
    expect(keyedCounter(1, 60_000).retryAfterSeconds).toBe(60);
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

  it("charges the cross-collection fan-outs to the fan-out budget", () => {
    for (const p of ["/v1/search", "/v1/people-analytics", "/v1/dashboard-summary", "/v1/approvals-summary", "/v1/activity-counts", "/v1/table-views/abc:run"]) {
      expect(budgetFor("GET", p).name, p).toBe("fan-out");
    }
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
    let last = await call("/v1/personal-documents:previewLetter", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    // Below the ceiling the limiter is transparent: whatever the route answers (a validation error here) is
    // NOT a 429. That is the half that proves the assertion after the loop is about the budget.
    expect(last.status).not.toBe(429);
    for (let i = 0; i < limit + 2 && last.status !== 429; i++) {
      last = await call("/v1/personal-documents:previewLetter", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
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
    // one envelope would be charged up to twenty times - making the transport that exists to cost less the
    // fastest way to hit a limit. The `api` budget is 900 and one envelope carries 20 reads; if they were
    // counted, 50 envelopes would exhaust it.
    const requests = Array.from({ length: 20 }, () => ({ path: "/v1/holidays" }));
    let last: Response | undefined;
    for (let i = 0; i < 60; i++) {
      last = await call("/v1/batch:run", { method: "POST", body: JSON.stringify({ requests }), headers: { "content-type": "application/json" } });
      if (last.status === 429) break;
    }
    expect(last!.status).not.toBe(429);
  });
});
