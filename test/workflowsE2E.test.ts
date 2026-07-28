/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
// Glob every migration (ordered by filename) instead of importing one by name, so squashing or adding
// migrations never breaks this suite. Concatenated in journal order to build the schema for miniflare.
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { emitEvent } from "../src/services/eventBus";
import { invalidateAutomationCache } from "../src/services/automationEngine";
import { AUTOMATIONS } from "../bootstrap/collections/automations";
import { genId } from "../src/lib/idCodec";
import type { AppUser } from "../src/env";
import { createOvertimeRequest, approveOvertimeRequest } from "../src/services/overtimeRequests";
import { createTicket } from "../src/services/tickets";

// Events are emitted with a null actor (the "who" isn't a seeded users row, and no tested rule targets the
// actor recipient) - keeps event_log's actor FK happy.
const actor = null;

// End-to-end workflow tests. Unlike the rest of the suite (pure), these run the REAL engine against a REAL D1
// (miniflare): emitEvent -> event_log -> dispatchAutomations -> actions. `apiCall` actions re-dispatch through
// the app's own middleware (app.fetch) against this same DB, so a rule that "creates a ticket" really inserts a
// ticket row. Each test seeds ONLY the rule(s) under test so assertions are deterministic.

// A valid 32-byte base64 key so makeDeps' encryptor/idCodec construct. (No encryption is exercised here.)
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;


const b = env as unknown as Bindings; // the pool's ProvidedEnv, typed as our worker Bindings

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
});

// Tables the tests write to, cleared before each (FK-safe order: children before employees).
const TABLES = [
  schema.ticketTodos, schema.tickets, schema.notifications, schema.transitions, schema.checkIns, schema.goals,
  schema.bonuses, schema.workflowInstances, schema.jobs, schema.automationRuns, schema.eventLog,
  schema.automations, schema.jobRequisitions, schema.overtimeRequests, schema.backgroundChecks, schema.users, schema.employees, schema.roles,
];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

// Insert a seeded rule BY NAME (so we test the real shipped definition), optionally overriding enabled.
async function seedRule(name: string, enabled = true) {
  const a = AUTOMATIONS.find((r) => r.name === name);
  if (!a) throw new Error(`no seeded automation named "${name}"`);
  await deps.db.insert(schema.automations).values({
    uuid: genId(), code: `aut-${genId().slice(0, 4)}`, name: a.name, description: a.description,
    triggerType: a.trigger, conditionJson: a.condition ? JSON.stringify(a.condition) : null,
    actionsJson: JSON.stringify(a.actions), enabled,
  });
  invalidateAutomationCache(); // the engine caches the enabled set for 5s; drop it so the new rule is seen now
}

async function seedEmployee(over: Partial<typeof schema.employees.$inferInsert> = {}): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.employees).values({
    uuid, code: over.code ?? `04-${genId().slice(0, 3)}`, firstName: "Test", lastName: "User",
    workEmail: `${uuid}@test.example`, status: "active", ...over,
  });
  return uuid;
}

// A real users row (its role FK needs a roles row) so a service call has a valid, loggable actor.
async function seedActor(employeeId: string): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  const uuid = genId();
  const email = `${uuid}@test.example`;
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email, role: "employee", employeeId });
  return { uuid, email, role: "employee", status: "active", employeeId, employeeCode: null } as unknown as AppUser;
}

const ticketsFor = (emp: string) => deps.db.select().from(schema.tickets).where(eq(schema.tickets.employeeId, emp));
const notifsFor = (emp: string) => deps.db.select().from(schema.notifications).where(eq(schema.notifications.recipientId, emp));

describe("workflows e2e: new-hire provisioning (on-behalf ticket create)", () => {
  it("raises IT + facilities tickets OWNED BY the new hire, and notifies hire + manager", async () => {
    const mgr = await seedEmployee({ code: "04-900" });
    const hire = await seedEmployee({ code: "04-901", managerId: mgr, departmentId: null });
    await seedRule("Provision IT & workspace for new hires");

    await emitEvent(deps, actor, "employee.created", { subject: `employees/${hire}`, employeeId: hire, payload: { departmentId: null, startDate: null } });

    const tickets = await ticketsFor(hire);
    expect(tickets.length).toBe(2); // two apiCall POST /v1/tickets, on behalf of the hire
    expect(new Set(tickets.map((t) => t.category))).toEqual(new Set(["it", "facilities"]));
    expect(tickets.every((t) => t.employeeId === hire)).toBe(true); // owned by the hire, not "system"

    expect((await notifsFor(hire)).length).toBe(1); // notify subject ("setting up your workspace")
    expect((await notifsFor(mgr)).length).toBe(1); // notifyManager

    const runs = await deps.db.select().from(schema.automationRuns);
    expect(runs.length).toBe(1);
    expect(runs[0]!.status).toBe("done");
  });
});

describe("workflows e2e: durable waitFor (loan disbursement SLA)", () => {
  it("suspends on loan.approved, then resumes and notifies on loan.disbursed", async () => {
    const emp = await seedEmployee({ code: "04-902" });
    await seedRule("Track loan disbursement");

    await emitEvent(deps, actor, "loan.approved", { subject: `loans/${genId()}`, employeeId: emp, payload: { amount: 100000, emiAmount: 5000 } });

    // Immediate notify (EMI) + a waiting workflow instance awaiting loan.disbursed.
    expect((await notifsFor(emp)).length).toBe(1);
    let insts = await deps.db.select().from(schema.workflowInstances);
    expect(insts.length).toBe(1);
    expect(insts[0]!.status).toBe("waiting");
    expect(insts[0]!.awaitedTypes ?? "").toContain("loan.disbursed");

    // The correlated event resumes it (first arm wins -> done) and fires the arm's notify.
    await emitEvent(deps, actor, "loan.disbursed", { subject: `loans/${genId()}`, employeeId: emp, payload: { amount: 100000 } });
    insts = await deps.db.select().from(schema.workflowInstances);
    expect(insts[0]!.status).toBe("done");
    expect((await notifsFor(emp)).length).toBe(2); // + "your loan has been disbursed"
  });
});

describe("workflows e2e: {{today}} + fan-out + condition (milestone anniversary)", () => {
  it("awards a bonus stamped today and broadcasts, only when years >= 3", async () => {
    const emp = await seedEmployee({ code: "04-903" });
    await seedRule("Reward milestone work anniversaries"); // condition years >= 3

    // Below threshold: nothing happens.
    await emitEvent(deps, actor, "schedule.workAnniversary", { subject: `employees/${emp}`, employeeId: emp, payload: { years: 1 } });
    expect((await deps.db.select().from(schema.bonuses)).length).toBe(0);

    // At/above threshold: a bonus dated today + the employee notify.
    await emitEvent(deps, actor, "schedule.workAnniversary", { subject: `employees/${emp}`, employeeId: emp, payload: { years: 5 } });
    const bonuses = await deps.db.select().from(schema.bonuses).where(eq(schema.bonuses.employeeId, emp));
    expect(bonuses.length).toBe(1);
    const today = new Date().toISOString().slice(0, 10);
    expect(new Date(bonuses[0]!.awardDate).toISOString().slice(0, 10)).toBe(today); // {{today}} resolved
    expect((await notifsFor(emp)).length).toBeGreaterThanOrEqual(1);
  });
});

describe("workflows e2e: condition gate + apiCall PATCH (close requisition)", () => {
  async function seedReq(): Promise<string> {
    const uuid = genId();
    await deps.db.insert(schema.jobRequisitions).values({ uuid, code: `jr-${genId().slice(0, 4)}`, title: "Engineer", status: "open" });
    return uuid;
  }
  it("marks the requisition filled when openings <= 1", async () => {
    const req = await seedReq();
    await seedRule("Close the requisition when filled");
    await emitEvent(deps, actor, "offer.accepted", { subject: `offers/${genId()}`, payload: { requisitionId: req, openings: 1 } });
    const row = (await deps.db.select().from(schema.jobRequisitions).where(eq(schema.jobRequisitions.uuid, req)))[0]!;
    expect(row.status).toBe("filled");
  });
  it("leaves it open when openings > 1 (condition fails)", async () => {
    const req = await seedReq();
    await seedRule("Close the requisition when filled");
    await emitEvent(deps, actor, "offer.accepted", { subject: `offers/${genId()}`, payload: { requisitionId: req, openings: 3 } });
    const row = (await deps.db.select().from(schema.jobRequisitions).where(eq(schema.jobRequisitions.uuid, req)))[0]!;
    expect(row.status).toBe("open");
  });
});

describe("workflows e2e: a newly-wired emit drives a rule (overtime SLA, service-level)", () => {
  it("createOvertimeRequest emits overtime.requested; the SLA suspends; approval resolves it", async () => {
    const mgr = await seedEmployee({ code: "04-950" });
    const emp = await seedEmployee({ code: "04-951", managerId: mgr });
    const empActor = await seedActor(emp);
    await seedRule("Overtime decision SLA");

    // Drive the REAL service (not a hand-emitted event) - proves the emit we added actually fires.
    const ot = await createOvertimeRequest(deps, empActor, { employee: `employees/${emp}`, start_time: "2026-07-01T09:00:00Z", end_time: "2026-07-01T12:00:00Z" });

    expect((await deps.db.select().from(schema.eventLog).where(eq(schema.eventLog.type, "overtime.requested"))).length).toBe(1);
    let insts = await deps.db.select().from(schema.workflowInstances);
    expect(insts.length).toBe(1);
    expect(insts[0]!.status).toBe("waiting");
    expect(insts[0]!.awaitedTypes ?? "").toContain("overtime.approved");

    await approveOvertimeRequest(deps, empActor, ot.uuid); // emits overtime.approved (same subject) -> resumes
    insts = await deps.db.select().from(schema.workflowInstances);
    expect(insts[0]!.status).toBe("done");
    expect((await deps.db.select().from(schema.eventLog).where(eq(schema.eventLog.type, "overtime.approved"))).length).toBe(1);
  });
});

describe("workflows e2e: cross-section action-item + data-passing (expiring doc -> ticket)", () => {
  it("opens an HR ticket owned by the employee and the notify cites it (captureAs -> results)", async () => {
    const emp = await seedEmployee({ code: "04-970" });
    await seedRule("Open a renewal task for an expiring document"); // condition daysLeft <= 15

    await emitEvent(deps, actor, "document.expiring", { subject: `personal-documents/${genId()}`, employeeId: emp, payload: { daysLeft: 10, title: "Passport" } });

    const tickets = await ticketsFor(emp);
    expect(tickets.length).toBe(1);
    expect(tickets[0]!.category).toBe("hr"); // opened on behalf of the employee, into the HR queue
    expect(tickets[0]!.subject).toBe("Renew an expiring document");

    const notifs = await notifsFor(emp);
    expect(notifs.length).toBe(1);
    expect(notifs[0]!.body).toContain("Renew an expiring document"); // {{results.renewalTicket.subject}} resolved
  });
});

describe("workflows e2e: correlation trace links one workflow's event + runs", () => {
  it("all runs from one inbound event share its trace; independent events get distinct traces", async () => {
    const emp = await seedEmployee({ code: "04-990" });
    await seedRule("New hire: complete-your-profile goal");
    await seedRule("Initiate a new hire's background check"); // a second rule on the same trigger

    await emitEvent(deps, actor, "employee.created", { subject: `employees/${emp}`, employeeId: emp, payload: {} });

    const runs = await deps.db.select().from(schema.automationRuns);
    expect(runs.length).toBe(2); // both rules fired
    const trace = runs[0]!.correlationId;
    expect(trace).toBeTruthy();
    expect(runs.every((r) => r.correlationId === trace)).toBe(true); // same workflow execution
    expect(runs.every((r) => r.employeeId === emp)).toBe(true); // cause denormalized onto each run
    const ev = (await deps.db.select().from(schema.eventLog).where(eq(schema.eventLog.type, "employee.created")))[0]!;
    expect(ev.correlationId).toBe(trace); // the triggering event shares the trace

    // A second, independent hire is its own workflow - distinct trace (root-per-emit isolation).
    const emp2 = await seedEmployee({ code: "04-991" });
    await emitEvent(deps, actor, "employee.created", { subject: `employees/${emp2}`, employeeId: emp2, payload: {} });
    const other = (await deps.db.select().from(schema.automationRuns).where(eq(schema.automationRuns.employeeId, emp2)))[0]!;
    expect(other.correlationId).toBeTruthy();
    expect(other.correlationId).not.toBe(trace);
  });
});

describe("workflows e2e: apiCall creates a record in another module (new hire -> goal)", () => {
  it("creates a complete-your-profile goal owned by the new hire", async () => {
    const emp = await seedEmployee({ code: "04-985" });
    await seedRule("New hire: complete-your-profile goal");

    await emitEvent(deps, actor, "employee.created", { subject: `employees/${emp}`, employeeId: emp, payload: { departmentId: null, startDate: null } });

    const goals = await deps.db.select().from(schema.goals).where(eq(schema.goals.employeeId, emp));
    expect(goals.length).toBe(1);
    expect(goals[0]!.title).toBe("Complete your employee profile");
  });
});

describe("workflows e2e: state-changing chain (IT ticket -> auto-append triage checklist)", () => {
  it("appends the standard triage todos to a new IT ticket via apiCall :addTodos", async () => {
    const emp = await seedEmployee({ code: "04-980" });
    const empActor = await seedActor(emp);
    await seedRule("Seed a triage checklist on IT tickets"); // condition category == it

    // Raising the ticket emits ticket.created -> the rule runs :addTodos on that same ticket.
    const ticket = await createTicket(deps, empActor, { category: "it", subject: "Laptop won't boot" });

    const todos = await deps.db.select().from(schema.ticketTodos).where(eq(schema.ticketTodos.ticketId, ticket.uuid));
    expect(todos.length).toBe(4); // the four triage steps were added by the automation
    expect(todos.map((t) => t.text)).toContain("Resolve & verify the fix");
  });
});

describe("workflows e2e: condition gate on a real field (extended-leave coverage)", () => {
  it("nudges the manager only when leave is 5+ days", async () => {
    const mgr = await seedEmployee({ code: "04-960" });
    const emp = await seedEmployee({ code: "04-961", managerId: mgr });
    await seedRule("Extended leave: arrange coverage"); // condition days >= 5

    await emitEvent(deps, actor, "leave.approved", { subject: `leave-requests/${genId()}`, employeeId: emp, payload: { days: 2 } });
    expect((await notifsFor(mgr)).length).toBe(0);

    await emitEvent(deps, actor, "leave.approved", { subject: `leave-requests/${genId()}`, employeeId: emp, payload: { days: 7 } });
    expect((await notifsFor(mgr)).length).toBe(1);
  });
});
