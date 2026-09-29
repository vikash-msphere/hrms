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
import { clearCache } from "../src/lib/cache";
import { createTicket, assertCategoryRoles, syncCategoryServiceRoles, storedTicketCategories } from "../src/services/tickets";
import { loadObjectRulesForRequest } from "../src/lib/policyLoad";
import { grantFor } from "../bootstrap/authz/grants";
import { mergeGrants, rulesToGrant } from "../src/domain/compileGrants";
import { decide, resolveRequest } from "../src/domain/permissions";

// Real-D1 (miniflare) test for a ticket category's servicing ROLES. A role named on a category gets, on every
// ticket filed under it, `tickets.<code>.**` at write plus the same pattern as a verb rule - written at create,
// and re-shared across the existing queue when a settings save adds or removes the role. The decision is checked
// the way the middleware makes it: the caller's role grant overlaid with the per-object rules the loader returns.
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

const TABLES = [schema.tickets, schema.accessRules, schema.settings, schema.eventLog, schema.auditLog, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  clearCache(); // the settings list and the per-object rules are cached per instance, and each test rewrites both
});

const IT = { key: "it", name: "IT & Systems", roles: ["it_admin"] };
const HR = { key: "hr", name: "HR" };

async function seedWorld(categories: object[]) {
  await deps.db.insert(schema.roles).values([{ name: "employee", label: "Employee" }, { name: "it_admin", label: "IT Admin" }, { name: "hr_admin", label: "HR Admin" }]);
  const requester = genId();
  await deps.db.insert(schema.employees).values({ uuid: requester, code: "04-001-001", firstName: "Req", lastName: "T", workEmail: `${requester}@t.example`, status: "active" });
  const reqUser = genId();
  await deps.db.insert(schema.users).values({ uuid: reqUser, code: "u-req", email: `${reqUser}@t.example`, role: "employee", employeeId: requester });
  await deps.db.insert(schema.settings).values({ key: "ticket-categories", value: JSON.stringify({ categories }) });
  return { uuid: reqUser, email: `${reqUser}@t.example`, role: "employee", status: "active", employeeId: requester, employeeCode: "04-001-001" } as unknown as AppUser;
}

const rolePair = (role: string, code: string) =>
  deps.db.select({ level: schema.accessRules.level, source: schema.accessRules.source, matchCode: schema.accessRules.matchCode }).from(schema.accessRules)
    .where(and(eq(schema.accessRules.subject, role), eq(schema.accessRules.subjectKind, "role"), eq(schema.accessRules.pattern, `tickets.${code}.**`)));

// May a holder of `role` (and nothing else) do this to the ticket, as the middleware decides it?
async function roleMay(role: string, method: string, code: string, verb?: string) {
  clearCache();
  const rows = await loadObjectRulesForRequest(deps, genId(), [role], "tickets", [code]);
  const grant = mergeGrants(grantFor(role), rulesToGrant(rows));
  return decide(grant, resolveRequest(method, `/v1/tickets/${code}${verb ? `:${verb}` : ""}`, false), { employeeCode: "0b-001" }).allow;
}

describe("ticket category servicing roles", () => {
  it("a ticket filed under a serviced category is shared with the role at write and every verb", async () => {
    const actor = await seedWorld([IT, HR]);
    const t = await createTicket(deps, actor, { category: "it", subject: "Laptop will not boot" });
    const rows = await rolePair("it_admin", t.code!);
    expect(rows.map((r) => r.level).sort()).toEqual([null, "write"].sort());
    expect(rows.every((r) => r.source === "ticket-share" && r.matchCode === t.code)).toBe(true);
    expect(await roleMay("it_admin", "GET", t.code!)).toBe(true);
    expect(await roleMay("it_admin", "POST", t.code!, "resolve")).toBe(true);
    expect(await roleMay("it_admin", "POST", t.code!, "assign")).toBe(true);
  });

  it("a ticket under another desk is not shared with the role, and the role cannot reach it", async () => {
    const actor = await seedWorld([IT, HR]);
    const t = await createTicket(deps, actor, { category: "hr", subject: "Payslip question" });
    expect(await rolePair("it_admin", t.code!)).toHaveLength(0);
    expect(await roleMay("it_admin", "GET", t.code!)).toBe(false);
    expect(await roleMay("it_admin", "POST", t.code!, "resolve")).toBe(false);
  });

  it("adding a role to a category shares the tickets already filed there; taking it off revokes them", async () => {
    const actor = await seedWorld([{ key: "it", name: "IT & Systems" }, HR]);
    const a = await createTicket(deps, actor, { category: "it", subject: "One" });
    const other = await createTicket(deps, actor, { category: "hr", subject: "Two" });
    expect(await rolePair("it_admin", a.code!)).toHaveLength(0);

    const before = await storedTicketCategories(deps);
    const withRole = { categories: [IT, HR] };
    await syncCategoryServiceRoles(deps, actor, before, withRole);
    expect(await rolePair("it_admin", a.code!)).toHaveLength(2);
    expect(await rolePair("it_admin", other.code!)).toHaveLength(0);
    // Idempotent: re-running the same save writes nothing new.
    await syncCategoryServiceRoles(deps, actor, before, withRole);
    expect(await rolePair("it_admin", a.code!)).toHaveLength(2);

    await syncCategoryServiceRoles(deps, actor, withRole, { categories: [{ key: "it", name: "IT & Systems" }, HR] });
    expect(await rolePair("it_admin", a.code!)).toHaveLength(0);
    expect(await roleMay("it_admin", "GET", a.code!)).toBe(false);
  });

  it("taking a role off never deletes a rule an admin authored for that role on the same ticket", async () => {
    const actor = await seedWorld([IT, HR]);
    const t = await createTicket(deps, actor, { category: "it", subject: "Printer jam" });
    await deps.db.insert(schema.accessRules).values({
      subject: "it_admin", subjectKind: "role", namespace: "tickets", pattern: `tickets.${t.code}.**`, scopeKind: "exact",
      scopeCode: t.code!, matchCode: t.code!, level: "read", effect: "allow", source: "acl",
    });
    await syncCategoryServiceRoles(deps, actor, { categories: [IT, HR] }, { categories: [{ key: "it", name: "IT & Systems" }, HR] });
    const left = await rolePair("it_admin", t.code!);
    expect(left).toEqual([{ level: "read", source: "acl", matchCode: t.code }]);
  });

  it("removing a whole category revokes its role shares", async () => {
    const actor = await seedWorld([IT, HR]);
    const t = await createTicket(deps, actor, { category: "it", subject: "VPN down" });
    await syncCategoryServiceRoles(deps, actor, { categories: [IT, HR] }, { categories: [HR] });
    expect(await rolePair("it_admin", t.code!)).toHaveLength(0);
  });

  it("refuses a role the org does not have, and `everyone`", async () => {
    await seedWorld([HR]);
    await expect(assertCategoryRoles(deps, { categories: [{ key: "it", name: "IT", roles: ["it_admn"] }] })).rejects.toThrow(/it_admn/);
    await expect(assertCategoryRoles(deps, { categories: [{ key: "it", name: "IT", roles: ["everyone"] }] })).rejects.toThrow(/everyone/);
    await expect(assertCategoryRoles(deps, { categories: [IT, HR] })).resolves.toBeUndefined();
  });
});
