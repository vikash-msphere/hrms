/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { bustRef } from "../src/lib/refData";
import { grantFor } from "../src/domain/grants";
import { DEFAULT_POLICY } from "../src/domain/manifests";
import { createLeaveRequest, approveLeaveRequest } from "../src/services/leaveRequests";
import { accrueLeave } from "../src/services/leaveAccrual";

// The leave POLICY, end to end through the create path: the rules are pure (test/leaveRestrictions.test.ts
// pins those), so what this file is for is everything around them - that the org baseline and a type's
// overrides combine the way they claim to, that the reads the rules need actually happen, that a soft rule
// lands on the row instead of refusing it, and that an org which has configured NOTHING still takes the path
// it took before any of this existed.

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
  deps = makeDeps(b);
});

const TABLES = [schema.leaveRequests, schema.leaveBalances, schema.leaveTypes, schema.noticePeriods, schema.notifications, schema.auditLog, schema.eventLog, schema.settings, schema.users, schema.employees, schema.roles, schema.codeSequences];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  deps.refCache?.clear();
  // Every case here is about policy, not about the calendar, so the clock is pinned: 2026-03-02 is a Monday.
  deps.clock = { now: () => new Date("2026-03-02T06:00:00.000Z") };
});

async function setSetting(key: string, value: unknown) {
  const json = JSON.stringify(value);
  await deps.db.insert(schema.settings).values({ key, value: json }).onConflictDoUpdate({ target: schema.settings.key, set: { value: json } });
  bustRef(deps, "settings");
}

async function seedEmployee(startDate = "2020-01-01"): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.employees).values({
    uuid, code: `04-${genId().slice(0, 5)}`, firstName: "Test", lastName: "User",
    workEmail: `${uuid}@test.example`, status: "active", startDate: new Date(Date.parse(`${startDate}T00:00:00Z`)),
  });
  return uuid;
}

async function seedLeaveType(over: Partial<typeof schema.leaveTypes.$inferInsert> = {}): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.leaveTypes).values({
    uuid, code: `lt-${genId().slice(0, 4)}`, name: "Annual", accrualDaysPerYear: 0, paid: false, ...over,
  });
  bustRef(deps, "leave_types");
  return uuid;
}

/** An actor carrying the REAL grant for their role, because the on-behalf exemption is decided from it. */
async function seedActor(employeeId: string, role = "employee"): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: role, label: role }).onConflictDoNothing();
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${uuid}@test.example`, role, employeeId });
  const emp = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, employeeId)).limit(1))[0];
  return {
    uuid, email: `${uuid}@test.example`, role, status: "active", employeeId,
    employeeCode: emp?.code ?? null,
    grant: grantFor(role),
    policy: DEFAULT_POLICY,
  } as unknown as AppUser;
}

/** An unpaid type by default, so the balance check never masks the policy being tested. */
async function fixture(typeOver: Partial<typeof schema.leaveTypes.$inferInsert> = {}, startDate = "2020-01-01") {
  const employeeId = await seedEmployee(startDate);
  const leaveTypeId = await seedLeaveType(typeOver);
  const actor = await seedActor(employeeId);
  return { employeeId, leaveTypeId, actor };
}

const file = (deps_: Deps, actor: AppUser, leaveTypeId: string, from: string, to = from, over: Record<string, unknown> = {}) =>
  createLeaveRequest(deps_, actor, { leave_type: `leave-types/${leaveTypeId}`, start_date: from, end_date: to, ...over });

describe("the org baseline and a type's overrides", () => {
  it("enforces an org-wide rule on a type that says nothing of its own", async () => {
    await setSetting("leave_restrictions", { timing: { advance_notice: { tiers: [{ up_to_days: 1, notice_days: 2 }] } } });
    const { actor, leaveTypeId } = await fixture();
    // Today is the 2nd; the 3rd is one day's notice where two are required.
    await expect(file(deps, actor, leaveTypeId, "2026-03-03")).rejects.toThrow(/notice/i);
    await expect(file(deps, actor, leaveTypeId, "2026-03-05")).resolves.toBeTruthy();
  });

  it("lets a type OVERRIDE the org rule", async () => {
    await setSetting("leave_restrictions", { timing: { advance_notice: { tiers: [{ up_to_days: 1, notice_days: 2 }] } } });
    const { actor, leaveTypeId } = await fixture({ restrictions: { timing: { advance_notice: { tiers: [{ up_to_days: 1, notice_days: 0 }] } } } });
    await expect(file(deps, actor, leaveTypeId, "2026-03-03")).resolves.toBeTruthy();
  });

  it("lets a type EXEMPT itself from the org rule with an explicit null", async () => {
    await setSetting("leave_restrictions", { timing: { advance_notice: { tiers: [{ up_to_days: 1, notice_days: 2 }] } } });
    const { actor, leaveTypeId } = await fixture({ restrictions: { timing: { advance_notice: null } } });
    await expect(file(deps, actor, leaveTypeId, "2026-03-03")).resolves.toBeTruthy();
  });
});

describe("who gets the planning exemptions", () => {
  // The notice, blackout, weekday and back-dating rules are waived for HR filing on somebody else's behalf.
  // WHO COUNTS AS HR IS AN AUTHZ QUESTION, and it used to be read straight off the payload: naming another
  // employee in the body set the flag, and the create gate on this collection is collection-level (that is how
  // self-service works), so it decides nothing about whose leave is being filed. Any employee could therefore
  // file leave that skipped the org's notice policy simply by addressing it to a colleague.
  it("does not hand the exemption to an employee who names a colleague", async () => {
    await setSetting("leave_restrictions", { timing: { advance_notice: { tiers: [{ up_to_days: 99, notice_days: 30 }] } } });
    const { actor, leaveTypeId } = await fixture();
    const colleague = await seedEmployee();
    await expect(
      createLeaveRequest(deps, actor, {
        leave_type: `leave-types/${leaveTypeId}`,
        employee: `employees/${colleague}`,
        start_date: "2026-03-03",
        end_date: "2026-03-03",
      }),
    ).rejects.toThrow(/notice/i);
  });

  it("does hand it to a caller whose reach goes past their own rows", async () => {
    await setSetting("leave_restrictions", { timing: { advance_notice: { tiers: [{ up_to_days: 99, notice_days: 30 }] } } });
    const { leaveTypeId } = await fixture();
    const subject = await seedEmployee();
    const hr = await seedActor(await seedEmployee(), "hr_admin");
    await expect(
      createLeaveRequest(deps, hr, {
        leave_type: `leave-types/${leaveTypeId}`,
        employee: `employees/${subject}`,
        start_date: "2026-03-03",
        end_date: "2026-03-03",
      }),
    ).resolves.toBeTruthy();
  });
});

describe("rules that need the employee's history", () => {
  it("counts leave already booked in the month against a monthly cap", async () => {
    await setSetting("leave_restrictions", { quota: { max_days_per_month: 2 } });
    const { actor, leaveTypeId } = await fixture();
    await file(deps, actor, leaveTypeId, "2026-03-10", "2026-03-11"); // 2 days, at the cap
    await expect(file(deps, actor, leaveTypeId, "2026-03-17")).rejects.toThrow(/capped at 2 days/i);
    // The next month is a fresh cap.
    await expect(file(deps, actor, leaveTypeId, "2026-04-07")).resolves.toBeTruthy();
  });

  it("keeps a minimum gap between requests of the same type", async () => {
    await setSetting("leave_restrictions", { quota: { min_gap_days: 10 } });
    const { actor, leaveTypeId } = await fixture();
    await file(deps, actor, leaveTypeId, "2026-03-10");
    await expect(file(deps, actor, leaveTypeId, "2026-03-12")).rejects.toThrow(/between requests/i);
    await expect(file(deps, actor, leaveTypeId, "2026-03-30")).resolves.toBeTruthy();
  });

  it("refuses two types the policy won't let run back to back", async () => {
    const { employeeId, actor } = await fixture();
    const sickId = await seedLeaveType({ name: "Sick" });
    const annualId = await seedLeaveType({ name: "Annual", restrictions: { combinations: { no_combination_with: [`leave-types/${sickId}`], gap_days: 0 } } });
    void employeeId;
    await file(deps, actor, sickId, "2026-03-10", "2026-03-11");
    await expect(file(deps, actor, annualId, "2026-03-12")).rejects.toThrow(/back to back/i);
  });

  it("holds the combination rule from whichever side declares it", async () => {
    // Same pair, with the rule written on the OTHER type: the new request's own policy says nothing.
    const { actor } = await fixture();
    const annualId = await seedLeaveType({ name: "Annual" });
    await seedLeaveType({ name: "Sick", restrictions: { combinations: { no_combination_with: [`leave-types/${annualId}`], gap_days: 0 } } });
    const sickId = (await deps.db.select().from(schema.leaveTypes).where(eq(schema.leaveTypes.name, "Sick")).limit(1))[0]!.uuid;
    await file(deps, actor, sickId, "2026-03-10", "2026-03-11");
    await expect(file(deps, actor, annualId, "2026-03-12")).rejects.toThrow(/back to back/i);
  });
});

describe("the exit process", () => {
  it("blocks leave inside a notice period being served", async () => {
    const { employeeId, actor, leaveTypeId } = await fixture({ restrictions: { exit: { during_notice: "blocked" } } });
    await deps.db.insert(schema.noticePeriods).values({
      uuid: genId(), code: `04-${genId().slice(0, 5)}`, employeeId, type: "resignation",
      noticeDate: new Date(Date.parse("2026-03-01T00:00:00Z")), lastWorkingDay: new Date(Date.parse("2026-03-31T00:00:00Z")), status: "serving",
    });
    await expect(file(deps, actor, leaveTypeId, "2026-03-10")).rejects.toThrow(/serving notice/i);
    // Past the last working day the rule has nothing to say (the employment question is a different one).
    await expect(file(deps, actor, leaveTypeId, "2026-04-07")).resolves.toBeTruthy();
  });

  it("says nothing to somebody with no notice period", async () => {
    const { actor, leaveTypeId } = await fixture({ restrictions: { exit: { during_notice: "blocked" } } });
    await expect(file(deps, actor, leaveTypeId, "2026-03-10")).resolves.toBeTruthy();
  });
});

describe("the joining month", () => {
  it("credits nothing for a joining month past the cutoff, and refuses leave in it", async () => {
    const startDate = "2026-03-20";
    // Accruing but UNPAID, so the balance check (which runs before the policy, and would refuse this for a
    // different and less interesting reason) stays out of the way of the rule being tested.
    const { actor, employeeId, leaveTypeId } = await fixture(
      { accrualDaysPerYear: 12, paid: false, restrictions: { accrual: { joining_rule: { cutoff_day: 15, if_after: "none" } } } },
      startDate,
    );
    deps.clock = { now: () => new Date("2026-03-25T06:00:00.000Z") };
    await accrueLeave(deps);
    const bal = (await deps.db.select().from(schema.leaveBalances).where(and(eq(schema.leaveBalances.employeeId, employeeId), eq(schema.leaveBalances.leaveTypeId, leaveTypeId))).limit(1))[0];
    expect(bal?.balanceDays ?? 0).toBe(0); // the joining month earned nothing
    await expect(file(deps, actor, leaveTypeId, "2026-03-26")).rejects.toThrow(/joining month/i);
  });
});

describe("soft rules", () => {
  it("files the request anyway and records what it broke", async () => {
    await setSetting("leave_restrictions", {
      timing: { advance_notice: { tiers: [{ up_to_days: 1, notice_days: 5 }] } },
      soft_rules: ["advance_notice"],
    });
    const { actor, leaveTypeId } = await fixture();
    const row = await file(deps, actor, leaveTypeId, "2026-03-03");
    expect(row.policyWarnings).toHaveLength(1);
    expect(row.policyWarnings![0]!.code).toBe("advance_notice");
    // And the trail says a waiver happened, which is where "who let this through" is answered later.
    const entries = await deps.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "leave_request.create"));
    expect(JSON.stringify(entries[0]?.meta ?? {})).toMatch(/policy waived: advance_notice/);
  });
});

describe("the sandwich rule", () => {
  it("charges the weekend inside a block when the type says so", async () => {
    // Fri 6 -> Mon 9 March 2026 across a weekend.
    const plain = await fixture();
    const plainRow = await file(deps, plain.actor, plain.leaveTypeId, "2026-03-06", "2026-03-09");
    expect(plainRow.days).toBe(2);

    const sandwiched = await fixture({ restrictions: { counting: { sandwich: { weekends: "intervening", holidays: "exclude" } } } });
    const row = await file(deps, sandwiched.actor, sandwiched.leaveTypeId, "2026-03-06", "2026-03-09");
    expect(row.days).toBe(4); // the Saturday and Sunday come off the balance too
  });
});

describe("the document rule", () => {
  it("is checked on APPROVAL, not when the request is filed", async () => {
    const { actor, leaveTypeId } = await fixture({ restrictions: { request: { document_required_over_days: 1 } } });
    // Filing works: the row has to exist before a file can be attached to it.
    const row = await file(deps, actor, leaveTypeId, "2026-03-10", "2026-03-11");
    await expect(approveLeaveRequest(deps, actor, row.uuid)).rejects.toThrow(/supporting document/i);
    // With the document attached, the same approval goes through.
    await deps.db.insert(schema.attachments).values({
      uuid: genId(), collection: "leave-requests", objectId: row.uuid, slot: "", r2Key: `attachments/leave-requests/${row.uuid}/x`,
      fileName: "note.pdf", contentType: "application/pdf", sizeBytes: 10, uploadedBy: actor.uuid,
    });
    await expect(approveLeaveRequest(deps, actor, row.uuid)).resolves.toBeTruthy();
  });
});

describe("an org with no policy", () => {
  it("still files leave, and reads nothing extra to do it", async () => {
    const { actor, leaveTypeId } = await fixture();
    // No settings row, no type blob: `historyWindow` answers null, so none of the policy reads are issued and
    // the path is the one that existed before any of this. The assertion that matters is that it still works.
    const row = await file(deps, actor, leaveTypeId, "2026-03-10", "2026-03-11");
    expect(row.days).toBe(2);
    expect(row.policyWarnings).toBeNull();
  });
});
