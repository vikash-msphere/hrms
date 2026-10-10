/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { app } from "../src/index";
import { seedManifest } from "./seedManifest";
import { createOvertimeRequest } from "../src/services/overtimeRequests";
import { createLoan, rejectLoan } from "../src/services/loans";
import { requireRejectReason } from "../src/services/decisionGuard";

// Every request rejection must say why (http/rejectBody.ts on the wire, services/decisionGuard.ts in the
// service). Pinned through the real app for one collection that always took an optional note (overtime) and
// one that took no body at all until now (loans), and once at the service for a caller that skips the route.

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
const b = env as unknown as Bindings;

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  await seedManifest(b.DB);
  deps = makeDeps(b);
});

const DEV_EMAIL = "dev@example.com"; // the dev-auth bypass (vitest.config.ts) is the ambient credential
const TABLES = [schema.loanRepayments, schema.loans, schema.overtimeRequests, schema.notifications, schema.eventLog, schema.auditLog, schema.accessRules, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  await deps.db.insert(schema.roles).values([{ name: "super_admin", label: "Super" }, { name: "employee", label: "Employee" }]).onConflictDoNothing();
  await deps.db.insert(schema.accessRules).values([
    { subject: "super_admin", subjectKind: "role", namespace: "*", pattern: "**", scopeKind: "all", scopeCode: "", matchCode: null, level: "admin", effect: "allow" },
    { subject: "super_admin", subjectKind: "role", namespace: "*", pattern: "**", scopeKind: "all", scopeCode: "", matchCode: null, level: null, effect: "allow" },
  ]);
  await deps.db.insert(schema.users).values({ uuid: genId(), code: `u-${genId().slice(0, 4)}`, email: DEV_EMAIL, role: "super_admin", status: "active" });
});

const short = (p: string) => `${p}-${genId().slice(0, 6)}`;

async function person(): Promise<AppUser> {
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({ uuid: employeeId, code: short("04"), firstName: "T", lastName: "U", workEmail: `${employeeId}@t.example`, status: "active" });
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: short("u"), email: `${uuid}@t.example`, role: "employee", employeeId });
  return { uuid, email: `${uuid}@t.example`, role: "employee", roles: ["employee"], status: "active", employeeId, employeeCode: null } as unknown as AppUser;
}

const reject = (path: string, body?: unknown) =>
  app.request(
    `/v1/${path}:reject`,
    {
      method: "POST",
      headers: { "X-Requested-By": "hrms-spa", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    b as unknown as Record<string, unknown>,
  );

describe("a rejection needs a reason", () => {
  it("refuses an overtime :reject with no reason or a blank one, and leaves the request pending", async () => {
    const me = await person();
    const ot = await createOvertimeRequest(deps, me, { start_time: "2099-01-01T18:00:00Z", end_time: "2099-01-01T20:00:00Z" });

    expect((await reject(`overtime-requests/${ot.uuid}`)).status).toBe(400);
    expect((await reject(`overtime-requests/${ot.uuid}`, { reason: "   " })).status).toBe(400);
    // The old optional field is not a reason: the body is strict, so it is refused rather than ignored.
    expect((await reject(`overtime-requests/${ot.uuid}`, { note: "Not budgeted" })).status).toBe(400);
    const row = (await deps.db.select().from(schema.overtimeRequests).where(eq(schema.overtimeRequests.uuid, ot.uuid)))[0]!;
    expect(row.state).toBe("PENDING");
  });

  it("stores the reason on the row, returns it on the wire, and tells the requester", async () => {
    const me = await person();
    const loan = await createLoan(deps, me, { principal: 20_000, installments: 4, reason: "Moving house" });

    const res = await reject(`loans/${loan.uuid}`, { reason: "  Over the advance limit for your grade  " });
    expect(res.status).toBe(200);
    const wire = (await res.json()) as Record<string, unknown>;
    expect(wire.status).toBe("REJECTED");
    expect(wire.decision_note).toBe("Over the advance limit for your grade"); // trimmed
    expect(wire.reason).toBe("Moving house"); // the requester's own reason is a different field, untouched

    const notes = await deps.db.select().from(schema.notifications).where(eq(schema.notifications.type, "loan.rejected"));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toContain("Over the advance limit for your grade");
  });

  it("is refused at the service too, for a caller that does not come through the route", async () => {
    const me = await person();
    const boss = await person();
    const loan = await createLoan(deps, me, { principal: 5_000, installments: 1 });
    await expect(rejectLoan(deps, boss, loan.uuid, "  ")).rejects.toThrow(/say why/);
    expect((await deps.db.select().from(schema.loans).where(eq(schema.loans.uuid, loan.uuid)))[0]!.status).toBe("PENDING");
    expect(() => requireRejectReason("x".repeat(1001))).toThrow(/1000/);
    expect(requireRejectReason("  ok  ")).toBe("ok");
  });
});
