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
import { importLeaveHistory } from "../src/services/leaveHistoryImport";
import { createLeaveRequest, cancelLeaveRequest } from "../src/services/leaveRequests";

// Leave taken before HRMS, brought in as history (services/leaveHistoryImport.ts). What is pinned: it lands as
// approved leave the policy counts, it touches nothing else (balance, notifications, events), it can only be
// history, and taking it back out refunds nothing and is not the person's own act.

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
});

const TABLES = [
  schema.leaveRequests, schema.leaveBalances, schema.leaveTypes, schema.notifications, schema.eventLog,
  schema.automationRuns, schema.auditLog, schema.users, schema.employees, schema.roles, schema.settings,
];

// Saturday 26 September 2026 in IST; HRMS records start on Thursday the 24th.
const NOW = "2026-09-26T06:00:00Z";
const short = (p: string) => `${p}-${genId().slice(0, 6)}`;
const hr = { uuid: genId(), email: "hr@t.example", role: "super_admin", status: "active", employeeId: null, employeeCode: null } as unknown as AppUser;

let emp: string;
let self: AppUser;
let earned: string;
beforeEach(async () => {
  deps = makeDeps(b);
  deps.clock = { now: () => new Date(NOW) };
  for (const t of TABLES) await deps.db.delete(t);
  await deps.db.insert(schema.roles).values([{ name: "super_admin", label: "Super admin" }, { name: "employee", label: "Employee" }]).onConflictDoNothing();
  await deps.db.insert(schema.users).values({ uuid: hr.uuid, code: short("u"), email: hr.email, role: "super_admin" });
  emp = genId();
  await deps.db.insert(schema.employees).values({
    uuid: emp, code: "04-003-001", firstName: "Test", lastName: "Leaver", workEmail: `${emp}@t.example`, status: "active",
    startDate: new Date("2024-01-15T00:00:00Z"), trackedFrom: new Date("2026-09-24T00:00:00Z"),
  });
  const selfUser = genId();
  await deps.db.insert(schema.users).values({ uuid: selfUser, code: short("u"), email: `${selfUser}@t.example`, role: "employee", employeeId: emp });
  self = { uuid: selfUser, email: `${selfUser}@t.example`, role: "employee", status: "active", employeeId: emp, employeeCode: "04-003-001" } as unknown as AppUser;
  earned = genId();
  await deps.db.insert(schema.leaveTypes).values({ uuid: earned, code: short("lt"), name: "Earned Leave", paid: true });
  await deps.db.insert(schema.leaveBalances).values({ code: "04-003-001-001", employeeId: emp, leaveTypeId: earned, balanceDays: 10 });
});

const item = (over: Record<string, unknown> = {}) => ({ employee: `employees/${emp}`, leave_type: `leave-types/${earned}`, start_date: "2026-03-02", end_date: "2026-03-06", ...over });
const balance = async () => (await deps.db.select().from(schema.leaveBalances).where(eq(schema.leaveBalances.employeeId, emp)))[0]!.balanceDays;

describe("leave-requests:importHistory", () => {
  it("previews, then lands approved history that moves nothing else, once", async () => {
    // Monday to Friday, counted like a request; a Saturday-to-Monday one given its days by the file.
    const items = [item(), item({ start_date: "2026-04-04", end_date: "2026-04-06", days: 1.5, reason: "family" })];
    const plan = await importLeaveHistory(deps, hr, items, true);
    expect(plan.counts).toEqual({ created: 2, unchanged: 0, error: 0 });
    expect(plan.results[0]).toMatchObject({ days: 5, days_from: "counted" });
    expect(plan.results[1]).toMatchObject({ days: 1.5, days_from: "file" });
    expect(await deps.db.select().from(schema.leaveRequests)).toHaveLength(0);

    const applied = await importLeaveHistory(deps, hr, items, false);
    expect(applied.counts).toEqual({ created: 2, unchanged: 0, error: 0 });
    const rows = await deps.db.select().from(schema.leaveRequests);
    expect(rows.map((r) => [r.state, r.source, r.days, r.decidedBy]).sort()).toEqual([["APPROVED", "import", 1.5, hr.uuid], ["APPROVED", "import", 5, hr.uuid]]);
    expect(rows.every((r) => r.code?.startsWith("04-003-001-"))).toBe(true);
    // The opening balance already has it taken off: nothing moves, nobody is told, nothing fires.
    expect(await balance()).toBe(10);
    expect(await deps.db.select().from(schema.notifications)).toHaveLength(0);
    expect(await deps.db.select().from(schema.eventLog)).toHaveLength(0);
    expect((await deps.db.select().from(schema.auditLog)).filter((a) => a.action === "leave_request.import")).toHaveLength(2);

    const again = await importLeaveHistory(deps, hr, items, false);
    expect(again.counts).toEqual({ created: 0, unchanged: 2, error: 0 });
    expect(await deps.db.select().from(schema.leaveRequests)).toHaveLength(2);
  });

  it("only takes history: before the records start, after the start date, on free days", async () => {
    await deps.db.insert(schema.leaveRequests).values({
      uuid: genId(), code: short("lr"), employeeId: emp, leaveTypeId: earned, state: "APPROVED", days: 1,
      startDate: new Date("2026-05-11T00:00:00Z"), endDate: new Date("2026-05-11T00:00:00Z"),
    });
    const res = await importLeaveHistory(deps, hr, [
      item({ start_date: "2026-09-22", end_date: "2026-09-24" }),
      item({ start_date: "2024-01-10", end_date: "2024-01-16" }),
      item({ start_date: "2026-05-11", end_date: "2026-05-12" }),
      item({ start_date: "2026-06-01", end_date: "2026-06-03" }),
      item({ start_date: "2026-06-03", end_date: "2026-06-04" }),
      item({ start_date: "2026-06-06", end_date: "2026-06-07" }),
    ], true);
    expect(res.results.map((r) => r.error ?? r.outcome)).toEqual([
      expect.stringMatching(/runs across the day HRMS records start \(2026-09-24\) - split it there/),
      expect.stringMatching(/before this person joined/),
      expect.stringMatching(/overlaps leave already in HRMS/),
      "created",
      expect.stringMatching(/earlier in this file/),
      expect.stringMatching(/no working days/),
    ]);
  });

  it("books leave already approved for dates from the records start: approved, off the balance once", async () => {
    // 5-9 October, approved in the system before HRMS; the opening (10) is the balance before it came off.
    const items = [item({ start_date: "2026-10-05", end_date: "2026-10-09" })];
    const plan = await importLeaveHistory(deps, hr, items, true);
    expect(plan.results[0]).toMatchObject({ kind: "booked", days: 5, outcome: "created" });
    expect(await balance()).toBe(10);

    await importLeaveHistory(deps, hr, items, false);
    const row = (await deps.db.select().from(schema.leaveRequests))[0]!;
    expect(row).toMatchObject({ state: "APPROVED", source: "app", days: 5 });
    expect(await balance()).toBe(5);
    expect(await deps.db.select().from(schema.notifications)).toHaveLength(0);

    // The same file again changes nothing, and the balance is not debited twice.
    const again = await importLeaveHistory(deps, hr, items, false);
    expect(again.counts).toEqual({ created: 0, unchanged: 1, error: 0 });
    expect(await balance()).toBe(5);

    // It is ordinary leave from here on: the person may call it off before it starts, and gets the days back.
    const cancelled = await cancelLeaveRequest(deps, self, row.uuid);
    expect(cancelled.state).toBe("CANCELLED");
    expect(await balance()).toBe(10);
  });

  it("refuses booked paid leave the balance cannot hold, counting the rows before it in the file", async () => {
    const res = await importLeaveHistory(deps, hr, [
      item({ start_date: "2026-10-05", end_date: "2026-10-09" }), // 5 of the 10
      item({ start_date: "2026-10-12", end_date: "2026-10-16" }), // the other 5
      item({ start_date: "2026-10-19", end_date: "2026-10-19" }), // nothing left
    ], false);
    expect(res.results.map((r) => r.outcome)).toEqual(["created", "created", "error"]);
    expect(res.results[2]!.error).toMatch(/not enough Earned Leave balance: 1 day\(s\) booked but 0 left/);
    expect(await balance()).toBe(0);
  });

  it("books unpaid leave with no balance yet, counting its usage", async () => {
    const lwp = genId();
    await deps.db.insert(schema.leaveTypes).values({ uuid: lwp, code: short("lt"), name: "Loss of Pay", paid: false });
    await importLeaveHistory(deps, hr, [item({ leave_type: `leave-types/${lwp}`, start_date: "2026-10-05", end_date: "2026-10-06" })], false);
    const bal = (await deps.db.select().from(schema.leaveBalances).where(eq(schema.leaveBalances.leaveTypeId, lwp)))[0]!;
    expect(bal.balanceDays).toBe(-2);
  });

  it("needs the records-start date first", async () => {
    await deps.db.update(schema.employees).set({ trackedFrom: null }).where(eq(schema.employees.uuid, emp));
    const res = await importLeaveHistory(deps, hr, [item()], true);
    expect(res.results[0]!.error).toMatch(/set when HRMS records start/);
  });

  it("counts toward a lifetime limit", async () => {
    const maternity = genId();
    await deps.db.insert(schema.leaveTypes).values({ uuid: maternity, code: short("lt"), name: "Maternity", paid: false, restrictions: { eligibility: { max_occurrences_lifetime: 1 } } });
    await importLeaveHistory(deps, hr, [item({ leave_type: `leave-types/${maternity}`, start_date: "2025-02-03", end_date: "2025-02-07" })], false);
    await expect(createLeaveRequest(deps, self, { leave_type: `leave-types/${maternity}`, start_date: "2026-10-05", end_date: "2026-10-09" })).rejects.toThrow(/already taken it 1 time/);
  });

  it("is taken back out by HR with no refund, and never by the person it belongs to", async () => {
    await importLeaveHistory(deps, hr, [item()], false);
    const row = (await deps.db.select().from(schema.leaveRequests))[0]!;
    await expect(cancelLeaveRequest(deps, self, row.uuid)).rejects.toThrow(/removed by HR/);
    const cancelled = await cancelLeaveRequest(deps, hr, row.uuid);
    expect(cancelled.state).toBe("CANCELLED");
    expect(await balance()).toBe(10);
    expect(await deps.db.select().from(schema.eventLog)).toHaveLength(0);
  });
});
