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
import { bustRef } from "../src/lib/refData";
import type { ListScope } from "../src/domain/access";
import {
  approveLateEarlyRequest, approvedExcusals, cancelLateEarlyRequest, createLateEarlyRequest, listLateEarlyRequests, rejectLateEarlyRequest,
} from "../src/services/lateEarlyRequests";
import { validateSettingValue } from "../src/routes/settings";
import { NOTIFICATION_CATEGORIES, categoryOf } from "../src/domain/notificationConfig";
import { EVENT_TYPES } from "../src/domain/events";

// Filing and deciding a late arrival / early departure request, end to end through the database.
//
// The rules themselves are pure and pinned in test/punctuality.test.ts. What is pinned HERE is that the service
// hands them the right facts (the org's policy, the day's holidays and leave, the person's other requests this
// month), acts on the verdict (refuse, flag, approve on filing), and decides exactly once.

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let base: Deps;
const b = env as unknown as Bindings;

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  base = makeDeps(b);
});

const TABLES = [
  schema.lateEarlyRequests, schema.lopAdjustments, schema.auditLog, schema.eventLog, schema.notifications, schema.automationRuns,
  schema.leaveRequests, schema.leaveTypes, schema.holidays, schema.settings, schema.users, schema.employees, schema.roles, schema.codeSequences,
];
beforeEach(async () => {
  for (const t of TABLES) await base.db.delete(t);
});

// Monday 2 March 2026, 08:00 in Asia/Kolkata (the default org zone): before the 09:00 shift starts.
const MON = "2026-03-02";
const NOW = "2026-03-02T02:30:00.000Z";
const at = (iso: string): Deps => {
  const d = makeDeps(b); // fresh per-request caches: settings and holidays are memoized per Deps
  return { ...d, clock: { now: () => new Date(iso) } };
};
let deps: Deps;

const AYA = { id: genId(), code: "04-001-001" };
const MGR = { id: genId(), code: "04-001-002" };
let aya: AppUser;
let mgr: AppUser;

async function actorFor(employeeId: string, code: string, role: string): Promise<AppUser> {
  await base.db.insert(schema.roles).values({ name: role, label: role }).onConflictDoNothing();
  const uuid = genId();
  const email = `${uuid}@x.test`;
  await base.db.insert(schema.users).values({ uuid, code: `u-${uuid.slice(0, 6)}`, email, role, employeeId });
  return { uuid, email, role, status: "active", employeeId, employeeCode: code } as unknown as AppUser;
}

async function seed(punctuality?: unknown) {
  await base.db.insert(schema.employees).values([
    { uuid: MGR.id, code: MGR.code, firstName: "Mo", lastName: "Manager", workEmail: "mgr@x.test", status: "active" },
    { uuid: AYA.id, code: AYA.code, firstName: "Aya", lastName: "One", workEmail: "aya@x.test", status: "active", managerId: MGR.id },
  ]);
  aya = await actorFor(AYA.id, AYA.code, "employee");
  mgr = await actorFor(MGR.id, MGR.code, "manager");
  await base.db.insert(schema.settings).values({ key: "attendance", value: JSON.stringify({ timezone: "Asia/Kolkata", work_days: [1, 2, 3, 4, 5], shift_start: "09:00", shift_end: "18:00", grace_minutes: 15 }), updatedAt: new Date() });
  if (punctuality !== undefined) await base.db.insert(schema.settings).values({ key: "punctuality", value: JSON.stringify(punctuality), updatedAt: new Date() });
  deps = at(NOW);
  bustRef(deps, "settings");
}

const file = (over: Record<string, unknown> = {}, who: AppUser = aya, d: Deps = deps) =>
  createLateEarlyRequest(d, who, { date: MON, kind: "late_arrival", at: "10:30", reason: "Clinic appointment", ...over });

describe("filing", () => {
  it("files a late arrival against the shift it moves, owned by the person", async () => {
    await seed();
    const row = await file();
    expect(row).toMatchObject({ state: "PENDING", kind: "late_arrival", at: "10:30", minutes: 90, overLimit: false, autoApproved: false, employeeId: AYA.id });
    // Owner-embedded, like every other employee-owned request - it is what `me` and `my-dept` rules match.
    expect(row.code?.startsWith(AYA.code)).toBe(true);
  });

  it("refuses a day nobody works, and a whole-day company holiday", async () => {
    await seed();
    await expect(file({ date: "2026-03-07" })).rejects.toThrow(/not a working day/);
    await base.db.insert(schema.holidays).values({ uuid: genId(), code: "h-1", name: "Holi", date: new Date(`${MON}T00:00:00.000Z`) });
    await expect(file({}, aya, at(NOW))).rejects.toThrow(/holiday/);
  });

  it("does not let a regional or half-day holiday refuse somebody who may be working", async () => {
    await seed();
    await base.db.insert(schema.holidays).values([
      { uuid: genId(), code: "h-2", name: "City day", date: new Date(`${MON}T00:00:00.000Z`), location: "Pune" },
      { uuid: genId(), code: "h-3", name: "Half day", date: new Date(`${MON}T00:00:00.000Z`), halfDay: true },
    ]);
    await expect(file({}, aya, at(NOW))).resolves.toMatchObject({ state: "PENDING" });
  });

  it("refuses a day already on approved leave for the whole of it", async () => {
    await seed();
    const typeId = genId();
    await base.db.insert(schema.leaveTypes).values({ uuid: typeId, code: "lt-1", name: "Casual" });
    await base.db.insert(schema.leaveRequests).values({ uuid: genId(), code: "lr-1", employeeId: AYA.id, leaveTypeId: typeId, startDate: new Date(`${MON}T00:00:00.000Z`), endDate: new Date(`${MON}T00:00:00.000Z`), days: 1, state: "APPROVED" });
    await expect(file()).rejects.toThrow(/approved leave/);
  });

  it("holds one live request per day and kind, and frees the day again once one is refused", async () => {
    await seed();
    const first = await file();
    await expect(file()).rejects.toThrow(/already a late arrival request for that day/);
    // The other kind is a different question about the same day.
    await expect(file({ kind: "early_departure", at: "16:00" })).resolves.toMatchObject({ state: "PENDING" });
    await rejectLateEarlyRequest(deps, mgr, first.uuid, "Not this week");
    await expect(file()).resolves.toMatchObject({ state: "PENDING" });
  });

  it("refuses past the monthly allowance, or accepts it flagged, as the policy says", async () => {
    await seed({ requests: { monthly_count: 1 } });
    await file();
    await expect(file({ date: "2026-03-03" })).rejects.toThrow(/monthly allowance/);

    await base.db.update(schema.settings).set({ value: JSON.stringify({ requests: { monthly_count: 1, over_limit: "allow" } }) }).where(eq(schema.settings.key, "punctuality"));
    const flagged = await file({ date: "2026-03-03" }, aya, at(NOW));
    expect(flagged).toMatchObject({ state: "PENDING", overLimit: true });
  });

  it("approves a short request on filing, with nobody named as the approver, and says so to automations", async () => {
    await seed({ requests: { auto_approve_minutes: 60 } });
    const row = await file({ at: "10:00" });
    expect(row).toMatchObject({ state: "APPROVED", autoApproved: true, decidedBy: null });
    const events = await base.db.select().from(schema.eventLog);
    expect(events.map((e) => e.type)).toContain("lateEarly.approved");
    // A longer one still goes to a person.
    expect(await file({ kind: "early_departure", at: "16:00" })).toMatchObject({ state: "PENDING", autoApproved: false });
  });

  it("with 'before the time it covers', refuses a late arrival asked for after the shift started", async () => {
    await seed({ requests: { before_time: true } });
    // 09:30 in Asia/Kolkata on the day itself.
    await expect(file({}, aya, at("2026-03-02T04:00:00.000Z"))).rejects.toThrow(/before the shift starts/);
    await expect(file({}, aya, at(NOW))).resolves.toMatchObject({ state: "PENDING" });
  });

  it("refuses a day outside the person's employment, which nothing ever judges", async () => {
    await seed();
    await base.db.update(schema.employees).set({ startDate: new Date("2026-03-03T00:00:00Z") }).where(eq(schema.employees.uuid, AYA.id));
    await expect(file()).rejects.toThrow(/before they joined/);
    await base.db.update(schema.employees).set({ startDate: null, endDate: new Date("2026-03-01T00:00:00Z") }).where(eq(schema.employees.uuid, AYA.id));
    await expect(file()).rejects.toThrow(/after their last working day/);
  });

  it("refuses everything while the org has switched requests off", async () => {
    await seed({ requests: { enabled: false } });
    await expect(file()).rejects.toThrow(/switched off/);
  });

  it("refuses a malformed request before consulting any policy", async () => {
    await seed();
    await expect(file({ kind: "lunch" })).rejects.toThrow(/kind must be one of/);
    await expect(file({ at: "25:00" })).rejects.toThrow(/HH:MM/);
    await expect(file({ date: "03/02/2026" })).rejects.toThrow(/date is required/);
  });
});

describe("deciding", () => {
  it("is the manager's call, not the requester's", async () => {
    await seed();
    const row = await file();
    await expect(approveLateEarlyRequest(deps, aya, row.uuid)).rejects.toThrow(/own|yourself|somebody else|subject/i);
    const approved = await approveLateEarlyRequest(deps, mgr, row.uuid, "Fine");
    expect(approved).toMatchObject({ state: "APPROVED", decidedBy: mgr.uuid, decisionNote: "Fine" });
  });

  it("decides exactly once when two approvals race", async () => {
    await seed();
    const row = await file();
    const results = await Promise.allSettled([approveLateEarlyRequest(deps, mgr, row.uuid), approveLateEarlyRequest(deps, mgr, row.uuid)]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    const approvals = (await base.db.select().from(schema.eventLog)).filter((e) => e.type === "lateEarly.approved");
    expect(approvals.length).toBe(1);
  });

  it("lets the owner cancel while pending, and once approved until the day is over", async () => {
    await seed();
    const pending = await file();
    expect(await cancelLateEarlyRequest(deps, aya, pending.uuid)).toMatchObject({ state: "CANCELLED", decidedBy: null });
    // Approved for today: they turned up on time after all, so the excusal goes back.
    const today = await file({ at: "10:00" });
    await approveLateEarlyRequest(deps, mgr, today.uuid);
    expect(await cancelLateEarlyRequest(deps, aya, today.uuid)).toMatchObject({ state: "CANCELLED" });
    expect((await approvedExcusals(deps, Date.parse(`${MON}T00:00:00Z`), Date.parse(`${MON}T00:00:00Z`))).size).toBe(0);
    // Approved for tomorrow, read the day after it: that day is over and stays as judged.
    const other = await file({ date: "2026-03-03" });
    await approveLateEarlyRequest(deps, mgr, other.uuid);
    await expect(cancelLateEarlyRequest(at("2026-03-04T04:00:00.000Z"), aya, other.uuid)).rejects.toThrow(/day that is over/);
    // A rejected one is not the owner's to cancel at all.
    const rejected = await file({ date: "2026-03-04" });
    await rejectLateEarlyRequest(deps, mgr, rejected.uuid, "No cover that day");
    await expect(cancelLateEarlyRequest(deps, aya, rejected.uuid)).rejects.toThrow(/only pending requests, or approved ones/);
  });

  it("tells the requester, under a category an org can switch off", async () => {
    await seed();
    const row = await file();
    await approveLateEarlyRequest(deps, mgr, row.uuid);
    const notes = await base.db.select().from(schema.notifications).where(eq(schema.notifications.recipientId, AYA.id));
    expect(notes.map((n) => n.type)).toContain("lateEarly.approved");
    expect(NOTIFICATION_CATEGORIES.map((c) => c.key)).toContain(categoryOf("lateEarly.approved"));
    expect(EVENT_TYPES.map((e) => e.type)).toEqual(expect.arrayContaining(["lateEarly.requested", "lateEarly.approved"]));
  });
});

describe("reading the approved windows back", () => {
  const all = (): ListScope => ({ breadth: "all", deptCode: null, ownerId: null, seeRestricted: true });

  it("returns only APPROVED requests, per person and day, as the moved window", async () => {
    await seed();
    const late = await file();
    await approveLateEarlyRequest(deps, mgr, late.uuid);
    const early = await file({ kind: "early_departure", at: "16:00" });
    await approveLateEarlyRequest(deps, mgr, early.uuid);
    await file({ date: "2026-03-03" }); // still pending - not a window yet
    const windows = await approvedExcusals(deps, Date.parse("2026-03-01T00:00:00Z"), Date.parse("2026-03-31T00:00:00Z"));
    expect(windows.get(AYA.id)?.get(MON)).toEqual({ lateUntil: 630, earlyFrom: 960 });
    expect(windows.get(AYA.id)?.has("2026-03-03")).toBe(false);
  });

  it("narrows a list by person, state and window without widening the scope", async () => {
    await seed();
    await file();
    await file({ date: "2026-03-04" });
    const page = await listLateEarlyRequests(deps, all(), 50, undefined, { employeeId: AYA.id, state: "PENDING", from: "2026-03-03", to: "2026-03-31" });
    expect(page.items.map((r) => r.date.toISOString().slice(0, 10))).toEqual(["2026-03-04"]);
  });
});

describe("the policy blob is validated before it is stored", () => {
  it("routes settings/punctuality through the strict validator", () => {
    expect(() => validateSettingValue("punctuality", { requests: { monthly_count: 2 } })).not.toThrow();
    expect(() => validateSettingValue("punctuality", { requests: { monthly_cout: 2 } })).toThrow(/is not a setting/);
  });
});
