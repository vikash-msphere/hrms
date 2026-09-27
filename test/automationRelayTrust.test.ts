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
import type { AppUser, Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { seedManifest } from "./seedManifest";
import { emitEvent } from "../src/services/eventBus";
import { invalidateAutomationCache } from "../src/services/automationEngine";
import { createAutomation, updateAutomation, deleteAutomation, setAutomationEnabled } from "../src/services/automations";
import { grantFor } from "../bootstrap/authz/grants";
import { genId } from "../src/lib/idCodec";
import type { Action } from "../src/domain/automations";

/**
 * WHO IS ALLOWED TO POINT SUPER AUTHORITY AT SOMETHING.
 *
 * An automation's actions run as the system principal, so authoring an `apiCall`/`webhook`/`email` action is
 * equivalent to holding super - which is why only a super admin may write one. These are the two ways that
 * gate was reachable around:
 *
 *   1. The verbs that decide whether an existing privileged rule RUNS - `:enable`, `:disable`, delete - asked
 *      nothing. `bootstrap.sql` ships privileged rules disabled on purpose (one of them auto-approves salary
 *      advances), and arming one is the same act as authoring it.
 *   2. `emitEvent` is deliberately NOT privileged, so an hr_admin may author it - and it re-emits an event
 *      whose SUBJECT is inherited from whatever triggered the relaying rule. A privileged rule that templates
 *      the subject into its path (`POST /v1/{{subject}}:approve` is a shipped seed) would then run, as super,
 *      against a record the relayer chose.
 *
 * Real engine, real D1 (as workflowsE2E does), because both fixes are about what actually dispatches.
 */

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

const TABLES = [
  schema.tickets, schema.notifications, schema.auditLog, schema.automationRuns, schema.eventLog,
  schema.automations, schema.users, schema.employees, schema.roles,
];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  invalidateAutomationCache();
});

async function seedEmployee(): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.employees).values({
    uuid, code: `04-${genId().slice(0, 3)}`, firstName: "Test", lastName: "User",
    workEmail: `${uuid}@test.example`, status: "active",
  });
  return uuid;
}

// A real users row (its role FK needs a roles row), so the audit entry these services write has a valid actor.
async function seedActor(role: "super_admin" | "hr_admin"): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: role, label: role }).onConflictDoNothing();
  const uuid = genId();
  const email = `${uuid}@test.example`;
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email, role });
  return { uuid, email, role, status: "active", employeeId: null, employeeCode: null, grant: grantFor(role) } as unknown as AppUser;
}

// The rule that costs real authority: creates a ticket through the app's own middleware, as the system actor.
const PRIVILEGED_ACTIONS: Action[] = [
  { kind: "apiCall", method: "POST", path: "/v1/tickets", body: { employee: "employees/{{employeeId}}", category: "it", subject: "Raised by a rule" } },
];

async function insertRule(over: { trigger: string; actions: Action[]; superAuthored?: boolean; disabled?: boolean }): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.automations).values({
    uuid, code: `aut-${genId().slice(0, 4)}`, name: `rule ${uuid.slice(0, 4)}`,
    triggerType: over.trigger, actionsJson: JSON.stringify(over.actions),
    superAuthored: over.superAuthored ?? true, disabled: over.disabled ?? false,
  });
  invalidateAutomationCache(); // the engine caches the enabled set for 5s; drop it so the new rule is seen now
  return uuid;
}

const runsFor = (automationId: string) => deps.db.select().from(schema.automationRuns).where(eq(schema.automationRuns.automationId, automationId));

describe("a relayed event may not reach super authority it did not come with", () => {
  it("an hr-authored relay cannot fire a privileged rule - and the refusal is a run row, not a silence", async () => {
    const emp = await seedEmployee();
    const privileged = await insertRule({ trigger: "employee.onboarded", actions: PRIVILEGED_ACTIONS });
    await insertRule({
      trigger: "leave.approved",
      superAuthored: false, // what an hr_admin's rule looks like once stored
      actions: [{ kind: "emitEvent", type: "employee.onboarded" }],
    });

    await emitEvent(deps, null, "leave.approved", { subject: `leave-requests/${genId()}`, employeeId: emp, payload: {} });

    expect(await deps.db.select().from(schema.tickets)).toEqual([]); // the apiCall never ran
    const runs = await runsFor(privileged);
    expect(runs.length).toBe(1); // ...and says so where somebody looks, rather than only in the logs
    expect(runs[0]!.status).toBe("skipped");
    expect(runs[0]!.resultJson).toContain("apiCall");
    expect(runs[0]!.resultJson).toContain("no super admin authored");
  });

  it("the same relay authored by a super admin still fires it (the shipped milestone rules are this shape)", async () => {
    const emp = await seedEmployee();
    const privileged = await insertRule({ trigger: "employee.onboarded", actions: PRIVILEGED_ACTIONS });
    await insertRule({ trigger: "leave.approved", superAuthored: true, actions: [{ kind: "emitEvent", type: "employee.onboarded" }] });

    await emitEvent(deps, null, "leave.approved", { subject: `leave-requests/${genId()}`, employeeId: emp, payload: {} });

    expect((await deps.db.select().from(schema.tickets)).length).toBe(1);
    expect((await runsFor(privileged))[0]!.status).toBe("done");
  });

  it("an untrusted relay still runs the ordinary rules - it is not a quarantine", async () => {
    const emp = await seedEmployee();
    const plain = await insertRule({ trigger: "employee.onboarded", actions: [{ kind: "notify", recipient: { of: "subject" }, title: "Welcome" }] });
    await insertRule({ trigger: "leave.approved", superAuthored: false, actions: [{ kind: "emitEvent", type: "employee.onboarded" }] });

    await emitEvent(deps, null, "leave.approved", { subject: `leave-requests/${genId()}`, employeeId: emp, payload: {} });

    expect((await runsFor(plain))[0]!.status).toBe("done");
    expect((await deps.db.select().from(schema.notifications).where(eq(schema.notifications.recipientId, emp))).length).toBe(1);
  });

  it("a direct emit from a service is unaffected (no relay, no gate)", async () => {
    const emp = await seedEmployee();
    const privileged = await insertRule({ trigger: "employee.onboarded", actions: PRIVILEGED_ACTIONS });

    await emitEvent(deps, null, "employee.onboarded", { subject: `employees/${emp}`, employeeId: emp, payload: {} });

    expect((await deps.db.select().from(schema.tickets)).length).toBe(1);
    expect((await runsFor(privileged))[0]!.status).toBe("done");
  });
});

describe("enable / disable / delete are the authoring act too", () => {
  it("an hr_admin may not arm, silence or remove a rule whose actions run as super", async () => {
    const hr = await seedActor("hr_admin");
    const id = await insertRule({ trigger: "employee.onboarded", actions: PRIVILEGED_ACTIONS, disabled: true });

    await expect(setAutomationEnabled(deps, hr, id, true)).rejects.toThrow(/super admin/);
    await expect(setAutomationEnabled(deps, hr, id, false)).rejects.toThrow(/super admin/);
    await expect(deleteAutomation(deps, hr, id)).rejects.toThrow(/super admin/);

    const [row] = await deps.db.select().from(schema.automations).where(eq(schema.automations.uuid, id));
    expect(row!.disabled).toBe(true); // still off, which is how bootstrap.sql ships it
  });

  it("...and may still work the rules that are theirs to work", async () => {
    const hr = await seedActor("hr_admin");
    const id = await insertRule({ trigger: "employee.onboarded", actions: [{ kind: "notify", recipient: { of: "subject" }, title: "Hi" }], disabled: true });

    await setAutomationEnabled(deps, hr, id, true);
    const [row] = await deps.db.select().from(schema.automations).where(eq(schema.automations.uuid, id));
    expect(row!.disabled).toBe(false);
    await deleteAutomation(deps, hr, id);
    expect(await deps.db.select().from(schema.automations).where(eq(schema.automations.uuid, id))).toEqual([]);
  });

  it("a super admin arms the privileged rule, as the one who could have written it", async () => {
    const su = await seedActor("super_admin");
    const id = await insertRule({ trigger: "employee.onboarded", actions: PRIVILEGED_ACTIONS, disabled: true });

    await setAutomationEnabled(deps, su, id, true);
    const [row] = await deps.db.select().from(schema.automations).where(eq(schema.automations.uuid, id));
    expect(row!.disabled).toBe(false);
  });
});

describe("trust belongs to whoever last decided what the rule does", () => {
  it("is stamped from the author on create", async () => {
    const hr = await seedActor("hr_admin");
    const su = await seedActor("super_admin");
    const theirs = await createAutomation(deps, hr, { name: "hr", trigger_type: "leave.approved", actions: [{ kind: "emitEvent", type: "employee.onboarded" }] });
    const ours = await createAutomation(deps, su, { name: "su", trigger_type: "leave.approved", actions: [{ kind: "emitEvent", type: "employee.onboarded" }] });
    expect(theirs.superAuthored).toBe(false);
    expect(ours.superAuthored).toBe(true);
  });

  it("is downgraded when a non-super edits a super-authored rule - including an edit that leaves the actions alone", async () => {
    const hr = await seedActor("hr_admin");
    const su = await seedActor("super_admin");
    const rule = await createAutomation(deps, su, { name: "su", trigger_type: "leave.approved", actions: [{ kind: "emitEvent", type: "employee.onboarded" }] });
    expect(rule.superAuthored).toBe(true);

    const edited = await updateAutomation(deps, hr, rule.uuid, { trigger_type: "leave.rejected" });
    expect(edited.superAuthored).toBe(false);
  });
});
