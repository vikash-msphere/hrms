/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { and, eq, like } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { createTicket, routeTicket, listTickets } from "../src/services/tickets";

// Real-D1 (miniflare) test for the ticket servicing-department: a category's configured department is stamped
// onto new tickets, the department's managers get the per-object read share (like category members), :route
// moves that share, and the list filters by department. Exercises the actual services end to end.
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

const TABLES = [schema.tickets, schema.accessRules, schema.settings, schema.eventLog, schema.auditLog, schema.users, schema.employees, schema.departments, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

// The IT and Facilities departments, each led by one manager who has a login. The requester belongs to neither.
type World = { actor: AppUser; itDept: string; facDept: string; itMgr: string; itMgrUser: string; facMgr: string; facMgrUser: string };
async function seedWorld(): Promise<World> {
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  const mkEmp = async (code: string, first: string) => {
    const uuid = genId();
    await deps.db.insert(schema.employees).values({ uuid, code, firstName: first, lastName: "T", workEmail: `${uuid}@t.example`, status: "active" });
    return uuid;
  };
  const mkUser = async (employeeId: string) => {
    const uuid = genId();
    await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${uuid}@t.example`, role: "employee", employeeId });
    return uuid;
  };
  const requester = await mkEmp("04-001-001", "Req");
  const itMgr = await mkEmp("04-002-001", "ItMgr");
  const facMgr = await mkEmp("04-003-001", "FacMgr");
  const itMgrUser = await mkUser(itMgr);
  const facMgrUser = await mkUser(facMgr);
  const reqUser = await mkUser(requester);

  const itDept = genId();
  const facDept = genId();
  await deps.db.insert(schema.departments).values([
    { uuid: itDept, code: "02", name: "IT", managerIds: JSON.stringify([itMgr]) },
    { uuid: facDept, code: "03", name: "Facilities", managerIds: JSON.stringify([facMgr]) },
  ]);

  // Category "it" defaults its servicing department to IT; no configured assignee/members.
  await deps.db.insert(schema.settings).values({
    key: "ticket-categories",
    value: JSON.stringify({ categories: [{ key: "it", name: "IT support", assignee: null, members: [], department: `departments/${itDept}` }] }),
  });

  const actor = { uuid: reqUser, email: `${reqUser}@t.example`, role: "employee", status: "active", employeeId: requester, employeeCode: null } as unknown as AppUser;
  return { actor, itDept, facDept, itMgr, itMgrUser, facMgr, facMgrUser };
}

// Does this user account hold a read share on this ticket code?
const hasShare = (userUuid: string, ticketCode: string) =>
  deps.db.select({ id: schema.accessRules.uuid }).from(schema.accessRules)
    .where(and(eq(schema.accessRules.subject, userUuid), eq(schema.accessRules.subjectKind, "user"), eq(schema.accessRules.pattern, `tickets.${ticketCode}.**`), eq(schema.accessRules.effect, "allow")))
    .limit(1).then((r) => r.length > 0);

const ALL: Parameters<typeof listTickets>[1] = { breadth: "all", deptCode: null, ownerId: null, seeRestricted: true };

describe("ticket servicing department", () => {
  it("stamps the category's department on create and shares it with that department's managers", async () => {
    const w = await seedWorld();
    const t = await createTicket(deps, w.actor, { category: "it", subject: "Laptop dead" });
    expect(t.departmentId).toBe(w.itDept);
    expect(await hasShare(w.itMgrUser, t.code!)).toBe(true); // IT lead sees their queue
    expect(await hasShare(w.facMgrUser, t.code!)).toBe(false); // Facilities lead does not
  });

  it("an explicit department overrides the category default", async () => {
    const w = await seedWorld();
    const t = await createTicket(deps, w.actor, { category: "it", subject: "Broken chair", department: `departments/${w.facDept}` });
    expect(t.departmentId).toBe(w.facDept);
    expect(await hasShare(w.facMgrUser, t.code!)).toBe(true);
    expect(await hasShare(w.itMgrUser, t.code!)).toBe(false);
  });

  it(":route moves the department and re-homes the manager read share", async () => {
    const w = await seedWorld();
    const t = await createTicket(deps, w.actor, { category: "it", subject: "Reassign me" });
    const routed = await routeTicket(deps, w.actor, t.uuid, `departments/${w.facDept}`);
    expect(routed.departmentId).toBe(w.facDept);
    expect(await hasShare(w.facMgrUser, t.code!)).toBe(true); // new dept lead gains read
    expect(await hasShare(w.itMgrUser, t.code!)).toBe(false); // old dept lead loses it
  });

  it("clearing the department (route to null) revokes the previous manager's share", async () => {
    const w = await seedWorld();
    const t = await createTicket(deps, w.actor, { category: "it", subject: "Unroute me" });
    const routed = await routeTicket(deps, w.actor, t.uuid, null);
    expect(routed.departmentId).toBeNull();
    expect(await hasShare(w.itMgrUser, t.code!)).toBe(false);
  });

  it("falls back to the org default department when the category has none", async () => {
    const w = await seedWorld();
    // A category with NO configured department + an org-wide default department = Facilities.
    await deps.db.update(schema.settings).set({ value: JSON.stringify({ categories: [{ key: "misc", name: "Misc", assignee: null, members: [], department: null }] }) }).where(eq(schema.settings.key, "ticket-categories"));
    await deps.db.insert(schema.settings).values({ key: "organization", value: JSON.stringify({ default_department: `departments/${w.facDept}` }) });
    const t = await createTicket(deps, w.actor, { category: "misc", subject: "Where do I go" });
    expect(t.departmentId).toBe(w.facDept);
  });

  it("filters the list to one servicing department", async () => {
    const w = await seedWorld();
    const it = await createTicket(deps, w.actor, { category: "it", subject: "IT one" });
    const fac = await createTicket(deps, w.actor, { category: "it", subject: "Fac one", department: `departments/${w.facDept}` });
    const onlyFac = await listTickets(deps, ALL, 50, undefined, undefined, undefined, w.actor, `departments/${w.facDept}`);
    const ids = onlyFac.items.map((r) => r.uuid);
    expect(ids).toContain(fac.uuid);
    expect(ids).not.toContain(it.uuid);
  });
});
