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
import type { ListScope } from "../src/domain/access";
import { listLeaveRequests } from "../src/services/leaveRequests";
import { listRemoteWorkRequests } from "../src/services/remoteWorkRequests";
import { dashboardSummary } from "../src/services/dashboardSummary";

// What a leave CALENDAR needs from the server, and could not get before: a window of dates, and a headcount to
// divide by. Both had to move server-side because a client can only filter the rows a 100-row page happened to
// return - a month drawn from that is silently incomplete, and "3 of 100 away" is a lie in a 400-person org.

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

beforeEach(async () => {
  await deps.db.delete(schema.leaveRequests);
  await deps.db.delete(schema.remoteWorkRequests);
  await deps.db.delete(schema.leaveTypes);
  await deps.db.delete(schema.employees);
});

const A = { uuid: genId(), code: "04-001-001" };
const B = { uuid: genId(), code: "04-001-002" };
const TYPE = genId();
const all = (): ListScope => ({ breadth: "all", deptCode: null, ownerId: null, seeRestricted: true });
const user = (employeeId: string | null): AppUser => ({ employeeId } as unknown as AppUser);
const day = (s: string) => new Date(Date.parse(s + "T00:00:00Z"));

// One leave per person per window, named by its code so assertions read as dates.
async function seedLeave(rows: { code: string; start: string; end: string; emp?: { uuid: string; code: string } }[]) {
  await deps.db.insert(schema.leaveTypes).values({ uuid: TYPE, code: "01-001", name: "annual" });
  await deps.db.insert(schema.leaveRequests).values(
    rows.map((r) => ({
      uuid: genId(),
      code: `${(r.emp ?? A).code}-${r.code}`,
      employeeId: (r.emp ?? A).uuid,
      leaveTypeId: TYPE,
      startDate: day(r.start),
      endDate: day(r.end),
      days: 1,
      state: "APPROVED" as const,
    })),
  );
}

async function seedEmployees() {
  await deps.db.insert(schema.employees).values([
    { uuid: A.uuid, code: A.code, firstName: "A", lastName: "A", workEmail: "a@x.test", status: "active" },
    { uuid: B.uuid, code: B.code, firstName: "B", lastName: "B", workEmail: "b@x.test", status: "active" },
  ]);
}

const codes = async (from?: string, to?: string) =>
  (await listLeaveRequests(deps, all(), 50, undefined, undefined, undefined, undefined, from, to)).items
    .map((r: typeof schema.leaveRequests.$inferSelect) => (r.code ?? "").split("-").pop())
    .sort();

describe("leave-requests list: date window", () => {
  beforeEach(async () => {
    await seedEmployees();
    await seedLeave([
      { code: "before", start: "2026-05-20", end: "2026-05-31" }, // ends the day before the window
      { code: "crossin", start: "2026-05-28", end: "2026-06-02" }, // starts before, reaches into it
      { code: "inside", start: "2026-06-10", end: "2026-06-12" },
      { code: "crossout", start: "2026-06-28", end: "2026-07-03" }, // starts inside, runs past the end
      { code: "after", start: "2026-07-01", end: "2026-07-04" }, // starts the day after the window
      { code: "spanning", start: "2026-01-01", end: "2026-12-31" }, // swallows the window whole
    ]);
  });

  it("returns every leave OVERLAPPING the window, including the ones crossing its edges", async () => {
    expect(await codes("2026-06-01", "2026-06-30")).toEqual(["crossin", "crossout", "inside", "spanning"]);
  });

  it("counts a leave that touches the window on its last day only", async () => {
    expect(await codes("2026-06-02", "2026-06-02")).toEqual(["crossin", "spanning"]);
  });

  it("takes either bound alone", async () => {
    expect(await codes("2026-07-01", undefined)).toEqual(["after", "crossout", "spanning"]);
    expect(await codes(undefined, "2026-05-31")).toEqual(["before", "crossin", "spanning"]);
  });

  it("is a no-op without bounds, and ignores an unparseable one", async () => {
    const everything = ["after", "before", "crossin", "crossout", "inside", "spanning"];
    expect(await codes()).toEqual(everything);
    expect(await codes("not-a-date", "also-not")).toEqual(everything);
  });
});

describe("remote-work-requests list: the same date window", () => {
  it("windows the overlay collection the calendar draws beside leave", async () => {
    await seedEmployees();
    await deps.db.insert(schema.remoteWorkRequests).values([
      { uuid: genId(), code: `${A.code}-r1`, employeeId: A.uuid, startDate: day("2026-06-10"), endDate: day("2026-06-12"), state: "APPROVED" as const },
      { uuid: genId(), code: `${A.code}-r2`, employeeId: A.uuid, startDate: day("2026-08-01"), endDate: day("2026-08-02"), state: "APPROVED" as const },
    ]);
    const inJune = await listRemoteWorkRequests(deps, all(), 50, undefined, undefined, undefined, "2026-06-01", "2026-06-30");
    expect(inJune.items.map((r) => r.code)).toEqual([`${A.code}-r1`]);
  });
});

describe("dashboard summary: headcount", () => {
  it("counts people still employed, with everyone (leavers included) as the extra", async () => {
    await seedEmployees();
    // B left yesterday, the way the exit transition records it (disabled + an end date); A has neither.
    await deps.db.update(schema.employees).set({ disabled: true, endDate: new Date(Date.now() - 86_400_000) }).where(eq(schema.employees.uuid, B.uuid));
    const out = await dashboardSummary(deps, user(A.uuid), new Map([["employees", all()]]), "headcount");
    expect(out.headcount).toEqual({ value: 1, extra: 2 });
  });

  it("keeps someone whose last working day is still ahead of them", async () => {
    await seedEmployees();
    await deps.db.update(schema.employees).set({ endDate: new Date(Date.now() + 30 * 86_400_000) }).where(eq(schema.employees.uuid, B.uuid));
    const out = await dashboardSummary(deps, user(A.uuid), new Map([["employees", all()]]), "headcount");
    expect(out.headcount).toEqual({ value: 2, extra: 2 });
  });

  it("is absent when the caller may not list employees", async () => {
    await seedEmployees();
    const out = await dashboardSummary(deps, user(A.uuid), new Map(), "headcount");
    expect(out.headcount).toBeUndefined();
  });
});
