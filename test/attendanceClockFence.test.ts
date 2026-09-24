/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { clockIn, clockOut } from "../src/services/attendance";

// Real-D1 (miniflare) test for the attendance clock's network fence (ATTENDANCE_ALLOWED_IPS) and its one
// exception: an APPROVED remote-work request eases the fence for exactly the approved period.
//
// Days are read in the ORG timezone, which defaults to Asia/Kolkata (UTC+5:30) with the settings table empty -
// so the UTC instants below are chosen for the IST wall clock they land on, and one case deliberately punches
// on a UTC day that is already the NEXT IST day.
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
const b = env as unknown as Bindings;

const FENCE = "198.51.100.0/24, 2001:db8::/32";
const INSIDE = "198.51.100.9";
const OUTSIDE = "203.0.113.7";

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
});

const TABLES = [schema.attendanceSessions, schema.remoteWorkRequests, schema.settings, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

let actor: AppUser;
async function seedActor(): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({ uuid: employeeId, code: `04-${genId().slice(0, 3)}`, firstName: "Test", lastName: "User", workEmail: `${employeeId}@test.example`, status: "active" });
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${uuid}@test.example`, role: "employee", employeeId });
  actor = { uuid, email: `${uuid}@test.example`, role: "employee", status: "active", employeeId, employeeCode: null } as unknown as AppUser;
  return actor;
}

// Deps pinned to one instant, so "now" is the punch time the fence judges.
const at = (iso: string): Deps => ({ ...deps, clock: { now: () => new Date(iso) } });

const ymd = (s: string) => new Date(Date.parse(`${s}T00:00:00Z`));
async function seedRemoteWork(opts: { start: string; end: string; state: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED"; startSession?: number; endSession?: number }) {
  await deps.db.insert(schema.remoteWorkRequests).values({
    uuid: genId(),
    code: `${actor.employeeId!.slice(0, 4)}-${genId().slice(0, 4)}`,
    employeeId: actor.employeeId!,
    startDate: ymd(opts.start),
    endDate: ymd(opts.end),
    startSession: opts.startSession ?? 1,
    endSession: opts.endSession ?? 2,
    state: opts.state,
  });
}

describe("attendance clock fence: no fence configured", () => {
  it("punches from any address, including one that cannot be established", async () => {
    await seedActor();
    await expect(clockIn(at("2026-03-10T04:00:00Z"), actor, { ip: OUTSIDE, allowList: undefined })).resolves.toBeTruthy();
    await expect(clockOut(at("2026-03-10T12:00:00Z"), actor, { ip: null, allowList: undefined })).resolves.toBeTruthy();
  });
});

describe("attendance clock fence: on-network", () => {
  it("allows a punch from inside the fence and refuses one from outside", async () => {
    await seedActor();
    await expect(clockIn(at("2026-03-10T04:00:00Z"), actor, { ip: INSIDE, allowList: FENCE })).resolves.toBeTruthy();
    await expect(clockIn(at("2026-03-10T04:05:00Z"), actor, { ip: OUTSIDE, allowList: FENCE })).rejects.toThrow(/approved network/);
  });
  it("fences clock-out the same way, and a refused clock-out closes from the network afterwards", async () => {
    await seedActor();
    await expect(clockIn(at("2026-03-10T04:00:00Z"), actor, { ip: INSIDE, allowList: FENCE })).resolves.toBeTruthy();
    await expect(clockOut(at("2026-03-10T12:00:00Z"), actor, { ip: OUTSIDE, allowList: FENCE }))
      .rejects.toMatchObject({ httpStatus: 403, type: "/errors/clock-network-fence" });
    await expect(clockOut(at("2026-03-10T12:00:00Z"), actor, { ip: null, allowList: FENCE })).rejects.toThrow(/approved network/);
    // The refusal left the session open; it is still the caller's and still closable from an allowed network.
    const closed = await clockOut(at("2026-03-10T12:05:00Z"), actor, { ip: INSIDE, allowList: FENCE });
    expect(closed.clockOut).not.toBeNull();
  });
  // The web clock branches on this type to offer the remote-work request instead of a dead-end toast, and
  // the API boundary uses it to suppress the "request access" offer (the caller holds the verb fine). Both
  // read the TYPE, never the sentence, so the type is the contract.
  it("refuses with its own problem type, not a bare permission-denied", async () => {
    await seedActor();
    await expect(clockIn(at("2026-03-10T04:00:00Z"), actor, { ip: OUTSIDE, allowList: FENCE }))
      .rejects.toMatchObject({ httpStatus: 403, type: "/errors/clock-network-fence" });
  });
  it("fails closed when the client IP cannot be established", async () => {
    await seedActor();
    await expect(clockIn(at("2026-03-10T04:00:00Z"), actor, { ip: null, allowList: FENCE })).rejects.toThrow(/approved network/);
    await expect(clockIn(at("2026-03-10T04:00:00Z"), actor, { ip: "not-an-ip", allowList: FENCE })).rejects.toThrow(/approved network/);
  });
});

describe("attendance clock fence: approved remote work eases it, for that period only", () => {
  it("an APPROVED request covering the punch day admits an off-network punch", async () => {
    await seedActor();
    await seedRemoteWork({ start: "2026-03-09", end: "2026-03-11", state: "APPROVED" });
    await expect(clockIn(at("2026-03-10T04:00:00Z"), actor, { ip: OUTSIDE, allowList: FENCE })).resolves.toBeTruthy();
    await expect(clockOut(at("2026-03-10T12:00:00Z"), actor, { ip: OUTSIDE, allowList: FENCE })).resolves.toBeTruthy();
  });
  it("fences again on the days either side of the approved period", async () => {
    await seedActor();
    await seedRemoteWork({ start: "2026-03-09", end: "2026-03-11", state: "APPROVED" });
    await expect(clockIn(at("2026-03-08T04:00:00Z"), actor, { ip: OUTSIDE, allowList: FENCE })).rejects.toThrow(/approved network/);
    await expect(clockIn(at("2026-03-12T04:00:00Z"), actor, { ip: OUTSIDE, allowList: FENCE })).rejects.toThrow(/approved network/);
  });
  it("only APPROVED counts - a pending, rejected or cancelled request is no exemption", async () => {
    for (const state of ["PENDING", "REJECTED", "CANCELLED"] as const) {
      await seedActor();
      await seedRemoteWork({ start: "2026-03-09", end: "2026-03-11", state });
      await expect(clockIn(at("2026-03-10T04:00:00Z"), actor, { ip: OUTSIDE, allowList: FENCE })).rejects.toThrow(/approved network/);
      for (const t of TABLES) await deps.db.delete(t);
    }
  });
  it("someone else's approved remote work is no exemption", async () => {
    await seedActor();
    await seedRemoteWork({ start: "2026-03-09", end: "2026-03-11", state: "APPROVED" });
    const other = await seedActor(); // reassigns `actor` - the approval above belongs to the previous employee
    await expect(clockIn(at("2026-03-10T04:00:00Z"), other, { ip: OUTSIDE, allowList: FENCE })).rejects.toThrow(/approved network/);
  });
  it("honors half-day sessions: a PM-only approval does not admit a morning punch", async () => {
    await seedActor();
    await seedRemoteWork({ start: "2026-03-10", end: "2026-03-10", state: "APPROVED", startSession: 2, endSession: 2 });
    // 03:30Z = 09:00 IST (first half) vs 08:30Z = 14:00 IST (second half).
    await expect(clockIn(at("2026-03-10T03:30:00Z"), actor, { ip: OUTSIDE, allowList: FENCE })).rejects.toThrow(/approved network/);
    await expect(clockIn(at("2026-03-10T08:30:00Z"), actor, { ip: OUTSIDE, allowList: FENCE })).resolves.toBeTruthy();
  });
  it("honors an AM-only approval the same way", async () => {
    await seedActor();
    await seedRemoteWork({ start: "2026-03-10", end: "2026-03-10", state: "APPROVED", startSession: 1, endSession: 1 });
    await expect(clockIn(at("2026-03-10T03:30:00Z"), actor, { ip: OUTSIDE, allowList: FENCE })).resolves.toBeTruthy();
    // The closing punch is judged at its own instant: by 14:00 local the AM-only approval has run out.
    await expect(clockOut(at("2026-03-10T08:30:00Z"), actor, { ip: OUTSIDE, allowList: FENCE })).rejects.toThrow(/approved network/);
    await expect(clockOut(at("2026-03-10T06:00:00Z"), actor, { ip: OUTSIDE, allowList: FENCE })).resolves.toBeTruthy();
  });
  it("places the punch on its ORG-timezone day, not its UTC day", async () => {
    await seedActor();
    await seedRemoteWork({ start: "2026-03-11", end: "2026-03-11", state: "APPROVED" });
    // 2026-03-10T19:00Z is already 00:30 IST on 2026-03-11 - inside the approval.
    await expect(clockIn(at("2026-03-10T19:00:00Z"), actor, { ip: OUTSIDE, allowList: FENCE })).resolves.toBeTruthy();
  });
  it("respects a non-default org timezone from settings", async () => {
    await seedActor();
    await deps.db.insert(schema.settings).values({ key: "attendance", value: JSON.stringify({ timezone: "America/New_York" }) });
    await seedRemoteWork({ start: "2026-03-10", end: "2026-03-10", state: "APPROVED" });
    // 2026-03-11T02:00Z is 22:00 on 2026-03-10 in New York - still the approved day there.
    await expect(clockIn(at("2026-03-11T02:00:00Z"), actor, { ip: OUTSIDE, allowList: FENCE })).resolves.toBeTruthy();
  });
});
