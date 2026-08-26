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
import { createTransition, updateTransition, setTransitionState } from "../src/services/transitions";
import { DEFAULT_TRANSITION_TEMPLATES } from "../src/domain/transitions";

// A process can be opened before anyone has picked a template - the hire hand-off does exactly that when the
// "Onboard a new hire" rule fires with a template id HR has since renamed. The checklist is then chosen after
// the fact, and it has to land on THAT process rather than a second one.
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

const TABLES = [schema.transitionTasks, schema.transitions, schema.backgroundChecks, schema.notifications, schema.auditLog, schema.eventLog, schema.settings, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

async function seedActor(): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: "hr", label: "HR" }).onConflictDoNothing();
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({ uuid: employeeId, code: `04-${genId().slice(0, 3)}`, firstName: "Hr", lastName: "User", workEmail: `${employeeId}@test.example`, status: "active" });
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${uuid}@test.example`, role: "hr", employeeId });
  return { uuid, email: `${uuid}@test.example`, role: "hr", status: "active", employeeId, employeeCode: null } as unknown as AppUser;
}

async function seedHire(): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.employees).values({ uuid, code: `04-${genId().slice(0, 3)}`, firstName: "New", lastName: "Hire", workEmail: `${uuid}@test.example`, status: "active" });
  return uuid;
}

const tasksOf = (transitionId: string) =>
  deps.db.select().from(schema.transitionTasks).where(eq(schema.transitionTasks.transitionId, transitionId));

const ONBOARDING = DEFAULT_TRANSITION_TEMPLATES.templates.find((t) => t.kind === "onboarding")!;

describe("choosing a template after the process was opened", () => {
  it("fills an empty checklist, dates it from the anchor, and renames the generic process", async () => {
    const actor = await seedActor();
    const hire = await seedHire();
    // What a rule naming a template that no longer exists leaves behind: a process with no tasks.
    const opened = await createTransition(deps, actor, { employee: `employees/${hire}`, kind: "onboarding", template: "renamed-away", anchor_date: "2026-09-01" });
    expect(opened.name).toBe("Onboarding");
    expect(await tasksOf(opened.uuid)).toHaveLength(0);

    const filled = await updateTransition(deps, actor, opened.uuid, { template: ONBOARDING.id });
    expect(filled.name).toBe(ONBOARDING.name);
    const tasks = await tasksOf(opened.uuid);
    expect(tasks).toHaveLength(ONBOARDING.tasks.length);
    // Due dates still derive from the anchor the process was opened with.
    const first = ONBOARDING.tasks[0]!;
    const landed = tasks.find((t) => t.title === first.title)!;
    expect(landed.dueDate && new Date(landed.dueDate).toISOString().slice(0, 10)).toBe("2026-08-30"); // anchor - 2 days
  });

  it("moves the anchor and the checklist together when both arrive in one patch", async () => {
    const actor = await seedActor();
    const hire = await seedHire();
    const opened = await createTransition(deps, actor, { employee: `employees/${hire}`, kind: "onboarding" });
    await updateTransition(deps, actor, opened.uuid, { template: ONBOARDING.id, anchor_date: "2026-10-05" });
    const tasks = await tasksOf(opened.uuid);
    const first = tasks.find((t) => t.title === ONBOARDING.tasks[0]!.title)!;
    expect(first.dueDate && new Date(first.dueDate).toISOString().slice(0, 10)).toBe("2026-10-03");
  });

  it("refuses to double a checklist that already exists", async () => {
    const actor = await seedActor();
    const hire = await seedHire();
    const started = await createTransition(deps, actor, { employee: `employees/${hire}`, kind: "onboarding", template: ONBOARDING.id, anchor_date: "2026-09-01" });
    await expect(updateTransition(deps, actor, started.uuid, { template: ONBOARDING.id })).rejects.toThrow(/already has a checklist/);
    expect(await tasksOf(started.uuid)).toHaveLength(ONBOARDING.tasks.length);
  });

  it("rejects an unknown template, the wrong kind, and a process that is no longer active", async () => {
    const actor = await seedActor();
    const hire = await seedHire();
    const opened = await createTransition(deps, actor, { employee: `employees/${hire}`, kind: "onboarding" });
    await expect(updateTransition(deps, actor, opened.uuid, { template: "nope" })).rejects.toThrow(/template not found/);
    const offboarding = DEFAULT_TRANSITION_TEMPLATES.templates.find((t) => t.kind === "offboarding")!;
    await expect(updateTransition(deps, actor, opened.uuid, { template: offboarding.id })).rejects.toThrow(/offboarding/);
    await setTransitionState(deps, actor, opened.uuid, "CANCELLED");
    await expect(updateTransition(deps, actor, opened.uuid, { template: ONBOARDING.id })).rejects.toThrow(/active process/);
  });
});
