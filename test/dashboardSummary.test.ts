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
import type { ListScope } from "../src/domain/access";
import { dashboardSummary } from "../src/services/dashboardSummary";

// The summary endpoint's contract: every aggregate equals what the caller would have counted from the
// corresponding list response - same scope binding, same soft-delete filter, same predicate - and a
// collection absent from the scopes map contributes nothing at all.

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

const TABLES = [schema.tickets, schema.cards, schema.boards, schema.loans, schema.timeEntries, schema.transitionTasks, schema.transitions, schema.employees];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

const A = { uuid: genId(), code: "04-001-001" };
const B = { uuid: genId(), code: "04-001-002" };

const user = (employeeId: string | null): AppUser => ({ employeeId } as unknown as AppUser);
const all = (): ListScope => ({ breadth: "all", deptCode: null, ownerId: null, seeRestricted: true });
const own = (ownerId: string): ListScope => ({ breadth: "own", deptCode: null, ownerId, seeRestricted: false });

const DAY = 86_400_000;
const utcToday = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

async function seed() {
  await deps.db.insert(schema.employees).values([
    { uuid: A.uuid, code: A.code, firstName: "A", lastName: "A", workEmail: "a@x.test", status: "active" },
    { uuid: B.uuid, code: B.code, firstName: "B", lastName: "B", workEmail: "b@x.test", status: "active" },
  ]);
  // Tickets: A has 2 OPEN + 1 RESOLVED + 1 soft-deleted OPEN; B has 1 OPEN.
  await deps.db.insert(schema.tickets).values([
    { uuid: genId(), code: `${A.code}-t1`, employeeId: A.uuid, subject: "a1", priority: "medium", state: "OPEN" },
    { uuid: genId(), code: `${A.code}-t2`, employeeId: A.uuid, subject: "a2", priority: "medium", state: "OPEN" },
    { uuid: genId(), code: `${A.code}-t3`, employeeId: A.uuid, subject: "a3", priority: "medium", state: "RESOLVED" },
    { uuid: genId(), code: `${A.code}-t4`, employeeId: A.uuid, subject: "a4", priority: "medium", state: "OPEN", deleteTime: new Date() },
    { uuid: genId(), code: `${B.code}-t1`, employeeId: B.uuid, subject: "b1", priority: "medium", state: "OPEN" },
  ]);
  // Cards: A one open+blocked, one open due yesterday, one DELIVERED blocked (must not count); B one open blocked.
  const today = utcToday();
  const board = genId();
  await deps.db.insert(schema.boards).values({ uuid: board, code: "01-001", name: "Board" });
  await deps.db.insert(schema.cards).values([
    { uuid: genId(), code: `${A.code}-c1`, boardId: board, employeeId: A.uuid, assigneeId: A.uuid, columnKey: "doing", rank: 1, title: "a1", blocked: true },
    { uuid: genId(), code: `${A.code}-c2`, boardId: board, employeeId: A.uuid, assigneeId: A.uuid, columnKey: "doing", rank: 2, title: "a2", dueDate: new Date(today.getTime() - DAY) },
    { uuid: genId(), code: `${A.code}-c3`, boardId: board, employeeId: A.uuid, assigneeId: A.uuid, columnKey: "done", rank: 3, title: "a3", blocked: true, deliveredAt: new Date() },
    { uuid: genId(), code: `${B.code}-c1`, boardId: board, employeeId: B.uuid, assigneeId: B.uuid, columnKey: "doing", rank: 4, title: "b1", blocked: true },
  ]);
  // Loans: A disbursed with balance owed, B closed (must not count).
  await deps.db.insert(schema.loans).values([
    { uuid: genId(), code: `${A.code}-l1`, employeeId: A.uuid, kind: "loan", principal: 1000, repaid: 250, status: "DISBURSED" },
    { uuid: genId(), code: `${B.code}-l1`, employeeId: B.uuid, kind: "loan", principal: 500, repaid: 500, status: "CLOSED" },
  ]);
}

describe("dashboard summary aggregates", () => {
  it("counts with an all-breadth scope and carries the documented extras", async () => {
    await seed();
    const scopes = new Map<string, ListScope>([["tickets", all()], ["cards", all()], ["loans", all()]]);
    const out = await dashboardSummary(deps, user(A.uuid), scopes, "open_tickets,cards_blocked,cards_overdue,my_open_cards,loans_outstanding");
    expect(out.open_tickets).toEqual({ value: 3 }); // A's two + B's one; resolved + soft-deleted excluded
    expect(out.cards_blocked).toEqual({ value: 2 }); // delivered blocked card excluded
    expect(out.cards_overdue).toEqual({ value: 1 });
    expect(out.my_open_cards).toEqual({ value: 2 }); // caller A's open cards only
    expect(out.loans_outstanding).toEqual({ value: 1, extra: 750 }); // extra = outstanding total
  });

  it("binds an own-breadth scope to the owner column", async () => {
    await seed();
    const scopes = new Map<string, ListScope>([["tickets", own(A.uuid)], ["cards", own(B.uuid)]]);
    const out = await dashboardSummary(deps, user(B.uuid), scopes, "open_tickets,cards_blocked,my_open_cards");
    expect(out.open_tickets).toEqual({ value: 2 }); // only A's live OPEN tickets
    expect(out.cards_blocked).toEqual({ value: 1 }); // only B's
    expect(out.my_open_cards).toEqual({ value: 1 }); // B's own open card
  });

  it("omits keys whose collection the middleware did not scope, and unknown keys", async () => {
    await seed();
    const scopes = new Map<string, ListScope>([["tickets", all()]]);
    const out = await dashboardSummary(deps, user(A.uuid), scopes, "open_tickets,cards_blocked,loans_outstanding,not_a_kpi");
    expect(Object.keys(out)).toEqual(["open_tickets"]);
  });

  it("joins transition tasks through their ACTIVE parent under the transitions scope", async () => {
    await seed();
    const tActive = genId();
    const tDone = genId();
    await deps.db.insert(schema.transitions).values([
      { uuid: tActive, code: `${A.code}-tr1`, employeeId: A.uuid, kind: "onboarding", name: "A onboarding", state: "ACTIVE" },
      { uuid: tDone, code: `${B.code}-tr1`, employeeId: B.uuid, kind: "onboarding", name: "B onboarding", state: "COMPLETED" },
    ]);
    await deps.db.insert(schema.transitionTasks).values([
      { uuid: genId(), code: `${A.code}-tk1`, transitionId: tActive, subjectId: A.uuid, assigneeId: A.uuid, title: "todo", status: "TODO", position: 1 },
      { uuid: genId(), code: `${A.code}-tk2`, transitionId: tActive, subjectId: A.uuid, assigneeId: A.uuid, title: "done", status: "DONE", position: 2 },
      { uuid: genId(), code: `${B.code}-tk1`, transitionId: tDone, subjectId: B.uuid, assigneeId: B.uuid, title: "orphan", status: "TODO", position: 1 },
    ]);
    const out = await dashboardSummary(deps, user(A.uuid), new Map([["transitions", all()]]), "transitions_active,onboarding_tasks_pending");
    expect(out.transitions_active).toEqual({ value: 1, extra: 1 });
    expect(out.onboarding_tasks_pending).toEqual({ value: 1 }); // the COMPLETED transition's TODO doesn't count
  });
});
