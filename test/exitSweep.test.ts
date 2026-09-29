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
import { clearCachePrefix } from "../src/lib/cache";
import { exitDueEmployees } from "../src/services/noticePeriods";
import { setTransitionState } from "../src/services/transitions";
import { disableEmployee, enableEmployee } from "../src/services/employees";
import { dayStartMs, orgToday } from "../src/services/orgDay";

// THE NIGHTLY EXIT. A leaver used to keep signing in until somebody clicked "Mark exited" or completed the
// offboarding, while the notice-period form promised it happened on the last working day. The sweep ends access
// the day after, and leaves the offboarding checklist open for the work still owed.
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const DAY = 86_400_000;
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

let today = 0;
beforeEach(async () => {
  for (const t of [schema.auditLog, schema.notifications, schema.noticePeriods, schema.transitionTasks, schema.transitions, schema.users, schema.employees, schema.roles, schema.settings]) await deps.db.delete(t);
  clearCachePrefix("");
  await deps.db.insert(schema.roles).values([{ name: "employee", label: "Employee" }]);
  today = dayStartMs(await orgToday(deps));
});

let n = 0;
/** An employee with a live login, reporting to `managerId` when given. */
async function person(managerId: string | null = null) {
  const uuid = genId();
  n += 1;
  await deps.db.insert(schema.employees).values({ uuid, code: `04-${String(n).padStart(3, "0")}`, firstName: "Test", lastName: `P${n}`, workEmail: `p${n}@example.com`, managerId });
  await deps.db.insert(schema.users).values({ uuid: genId(), code: `u-${n}`, email: `p${n}@example.com`, employeeId: uuid });
  return uuid;
}
async function offboarding(employeeId: string, anchor: number) {
  const uuid = genId();
  await deps.db.insert(schema.transitions).values({ uuid, code: `t-${uuid}`, employeeId, kind: "offboarding", name: "Offboarding", anchorDate: new Date(anchor) });
  return uuid;
}
async function notice(employeeId: string, lastWorkingDay: number, transitionId: string | null = null) {
  const uuid = genId();
  await deps.db.insert(schema.noticePeriods).values({ uuid, code: `n-${uuid}`, employeeId, noticeDate: new Date(lastWorkingDay - 30 * DAY), lastWorkingDay: new Date(lastWorkingDay), transitionId });
  return uuid;
}
const employeeRow = async (id: string) => (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, id)))[0]!;
const loginOf = async (id: string) => (await deps.db.select().from(schema.users).where(eq(schema.users.employeeId, id)))[0]!;
const terminations = async (id: string) => (await deps.db.select().from(schema.auditLog)).filter((r) => r.action === "employee.terminate" && r.entityId === id).length;
const hr = { uuid: "hr-user", email: "hr@example.com", role: "hr_admin", status: "active", employeeId: null, employeeCode: null } as unknown as AppUser;

describe("the nightly exit sweep", () => {
  it("exits a serving notice the day after its last working day, and leaves the checklist open", async () => {
    const mgr = await person();
    const leaver = await person(mgr);
    const tr = await offboarding(leaver, today - DAY);
    const np = await notice(leaver, today - DAY, tr);

    expect(await exitDueEmployees(deps)).toBe(1);

    const e = await employeeRow(leaver);
    expect(e.status).toBe("terminated");
    expect(e.disabled).toBe(true);
    expect(+new Date(e.endDate!)).toBe(today - DAY);
    expect((await loginOf(leaver)).status).toBe("disabled");
    expect((await deps.db.select().from(schema.noticePeriods).where(eq(schema.noticePeriods.uuid, np)))[0]!.status).toBe("completed");
    expect((await deps.db.select().from(schema.transitions).where(eq(schema.transitions.uuid, tr)))[0]!.state).toBe("ACTIVE");
    const told = await deps.db.select().from(schema.notifications).where(eq(schema.notifications.recipientId, mgr));
    expect(told.map((r) => r.type)).toEqual(["notice.exited"]);
  });

  it("leaves someone alone on their last working day itself", async () => {
    const leaver = await person();
    await notice(leaver, today);
    expect(await exitDueEmployees(deps)).toBe(0);
    expect((await employeeRow(leaver)).status).toBe("active");
    expect((await loginOf(leaver)).status).toBe("active");
  });

  it("is a no-op the second time, and a later manual complete does not terminate again", async () => {
    const leaver = await person();
    const tr = await offboarding(leaver, today - 2 * DAY);
    await notice(leaver, today - 2 * DAY, tr);
    expect(await exitDueEmployees(deps)).toBe(1);
    expect(await exitDueEmployees(deps)).toBe(0);
    await setTransitionState(deps, hr, tr, "COMPLETED");
    expect(await terminations(leaver)).toBe(1);
  });

  it("exits an offboarding started with no notice once its anchor date has passed", async () => {
    const leaver = await person();
    await offboarding(leaver, today - DAY);
    expect(await exitDueEmployees(deps)).toBe(1);
    expect((await employeeRow(leaver)).status).toBe("terminated");
    expect((await loginOf(leaver)).status).toBe("disabled");
  });

  it("lets a serving notice own the date over an older offboarding anchor", async () => {
    const leaver = await person();
    const tr = await offboarding(leaver, today - DAY);
    await notice(leaver, today + 7 * DAY, tr);
    expect(await exitDueEmployees(deps)).toBe(0);
    expect((await employeeRow(leaver)).status).toBe("active");
  });
});

describe("employee :disable / :enable", () => {
  it("disabling the record disables the login too", async () => {
    const id = await person();
    await disableEmployee(deps, hr, id);
    expect((await employeeRow(id)).disabled).toBe(true);
    expect((await loginOf(id)).status).toBe("disabled");
  });

  it("enabling someone who exited reactivates them, keeps the end date, and leaves the login off", async () => {
    const id = await person();
    await offboarding(id, today - DAY);
    await exitDueEmployees(deps);
    await enableEmployee(deps, hr, id);
    const e = await employeeRow(id);
    expect(e.status).toBe("active");
    expect(e.disabled).toBe(false);
    expect(+new Date(e.endDate!)).toBe(today - DAY);
    expect((await loginOf(id)).status).toBe("disabled");
  });
});
