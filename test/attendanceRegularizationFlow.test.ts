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
import { createRegularization, approveRegularization } from "../src/services/attendanceRegularizations";
import { listSessions } from "../src/services/attendance";
import type { ListScope } from "../src/domain/access";

// Real-D1 (miniflare) flow test for the reimagined attendance correction: a regularization carries the whole
// day's intended sessions; approving it supersedes that day's existing punches and writes the requested ones as
// `correction` sessions, so the derived day recomputes with no double-count and nothing to reconcile by hand.
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
const b = env as unknown as Bindings;
const ALL: ListScope = { breadth: "all", deptCode: null, ownerId: null, seeRestricted: true };

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
});

const TABLES = [schema.attendanceSessions, schema.attendanceRegularizations, schema.notifications, schema.auditLog, schema.eventLog, schema.settings, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

async function seedActor(): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({ uuid: employeeId, code: `04-${genId().slice(0, 3)}`, firstName: "Test", lastName: "User", workEmail: `${employeeId}@test.example`, status: "active" });
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${uuid}@test.example`, role: "employee", employeeId });
  return { uuid, email: `${uuid}@test.example`, role: "employee", status: "active", employeeId, employeeCode: null } as unknown as AppUser;
}

async function punch(employeeId: string, clockIn: string, clockOut: string) {
  await deps.db.insert(schema.attendanceSessions).values({
    code: `04-${genId().slice(0, 6)}`, employeeId, clockIn: new Date(clockIn), clockOut: new Date(clockOut), source: "clock",
  });
}

const liveSessions = (employeeId: string) =>
  listSessions(deps, ALL, 100).then(({ items }) => items.filter((s) => s.employeeId === employeeId));

describe("attendance regularization: whole-day correction supersedes existing punches", () => {
  it("approving a multi-session correction replaces the day's punches (no double-count)", async () => {
    const actor = await seedActor();
    // A single wrong punch on 2026-07-14 IST (03:30Z = 09:00 IST .. 06:30Z = 12:00 IST).
    await punch(actor.employeeId!, "2026-07-14T03:30:00.000Z", "2026-07-14T06:30:00.000Z");

    const reg = await createRegularization(deps, actor, {
      date: "2026-07-14",
      sessions: [
        { clock_in: "2026-07-14T03:30:00.000Z", clock_out: "2026-07-14T07:30:00.000Z" }, // 09:00-13:00 IST
        { clock_in: "2026-07-14T08:30:00.000Z", clock_out: "2026-07-14T12:40:00.000Z" }, // 14:00-18:10 IST
      ],
      reason: "forgot to clock the afternoon",
    });
    expect(reg.state).toBe("PENDING");
    expect(reg.sessions).toHaveLength(2);

    await approveRegularization(deps, actor, reg.uuid);

    // The original clock punch is soft-superseded (still in the table for audit, but hidden from lists).
    const all = await deps.db.select().from(schema.attendanceSessions).where(eq(schema.attendanceSessions.employeeId, actor.employeeId!));
    const superseded = all.filter((s) => s.supersededBy === reg.uuid);
    expect(superseded).toHaveLength(1);
    expect(superseded[0]!.source).toBe("clock");

    // The live view shows exactly the two requested correction sessions - the old punch is gone.
    const live = await liveSessions(actor.employeeId!);
    expect(live).toHaveLength(2);
    expect(live.every((s) => s.source === "correction")).toBe(true);
    expect(live.every((s) => s.supersededBy === null)).toBe(true);
  });

  it("an empty-sessions correction clears the day", async () => {
    const actor = await seedActor();
    await punch(actor.employeeId!, "2026-07-15T03:30:00.000Z", "2026-07-15T12:00:00.000Z");

    const reg = await createRegularization(deps, actor, { date: "2026-07-15", sessions: [], reason: "clocked the wrong day" });
    await approveRegularization(deps, actor, reg.uuid);

    const live = await liveSessions(actor.employeeId!);
    expect(live).toHaveLength(0);
  });

  it("rejects overlapping or reversed sessions", async () => {
    const actor = await seedActor();
    await expect(createRegularization(deps, actor, { date: "2026-07-16", sessions: [{ clock_in: "2026-07-16T09:00:00.000Z", clock_out: "2026-07-16T08:00:00.000Z" }] })).rejects.toThrow();
    await expect(createRegularization(deps, actor, {
      date: "2026-07-16",
      sessions: [
        { clock_in: "2026-07-16T03:00:00.000Z", clock_out: "2026-07-16T07:00:00.000Z" },
        { clock_in: "2026-07-16T06:00:00.000Z", clock_out: "2026-07-16T09:00:00.000Z" },
      ],
    })).rejects.toThrow();
  });
});
