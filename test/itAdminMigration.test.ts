/// <reference types="vite/client" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Bindings } from "../src/env";
import { GRANTS, grantFor, EVERYONE_GRANT } from "../bootstrap/authz/grants";
import { compileGrant, mergeGrants, rulesToGrant, type CompiledRule } from "../src/domain/compileGrants";
import { decide, resolveRequest } from "../src/domain/permissions";

// Migration 0004 adds it_admin to a LIVE database, takes the asset rules off hr_admin, gives HR the PIN reset,
// and hands the IT ticket desk to the new role. Every other migration is applied first; each test then lays down
// a database as the seed left it (plus the edits an org could have made since) and applies 0004 - twice, because
// every statement has to be a no-op the second time.
const migrations = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const paths = Object.keys(migrations).sort();
const target = paths.find((p) => p.includes("0004_it_admin_role"))!;
const db = (env as unknown as Bindings).DB;

async function runSql(sql: string) {
  for (const stmt of sql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await db.prepare(s).run();
  }
}
const migrate = () => runSql(migrations[target]!);

beforeAll(async () => {
  for (const p of paths.filter((p) => p !== target)) await runSql(migrations[p]!);
});

beforeEach(async () => {
  for (const t of ["access_rules", "tickets", "settings", "users", "employees", "roles"]) await db.prepare(`DELETE FROM ${t}`).run();
});

let n = 0;
const id = () => `m${String(++n).padStart(11, "0")}0`;

async function insertRule(subject: string, r: CompiledRule, source = "acl") {
  await db
    .prepare("INSERT INTO access_rules (uuid, subject, subject_kind, namespace, pattern, scope_kind, scope_code, match_code, level, effect, source, created_at, updated_at) VALUES (?, ?, 'role', ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)")
    .bind(id(), subject, r.namespace, r.pattern, r.scopeKind, r.scopeCode, r.matchCode, r.level, r.effect, source)
    .run();
}

// hr_admin as the seed wrote it before this change: today's rules plus the asset rules it has since lost.
const HR_ASSET_ROWS: CompiledRule[] = [
  ...[["assets.**", "write"], ["asset-categories.**", "write"], ["asset-requests.**", "read"], ["stocktakes.**", "write"], ["settings.asset-tags", "write"]].map(([p, l]) => ({ namespace: p!.split(".")[0]!, pattern: p!, scopeKind: "all" as const, scopeCode: "", matchCode: null, level: l as "read" | "write", effect: "allow" as const })),
  ...["assets.**", "asset-categories.**", "stocktakes.**", "asset-requests.*.approve", "asset-requests.*.reject", "asset-requests.*.issue"].map((p) => ({ namespace: p.split(".")[0]!, pattern: p, scopeKind: "all" as const, scopeCode: "", matchCode: null, level: null, effect: "allow" as const })),
];
const NEW_HR = new Set(["users", "users.**", "users.**.resetPin"]);

async function seedOldState(categories: object[] | null) {
  for (const [name, label] of [["employee", "Employee"], ["hr_admin", "HR Admin"]]) {
    await db.prepare("INSERT INTO roles (name, label, protected, provisioned, created_at, updated_at) VALUES (?, ?, 1, ?, 0, 0)").bind(name, label, name === "employee" ? 1 : 0).run();
  }
  for (const r of compileGrant(GRANTS.employee)) await insertRule("employee", r);
  const hrToday = compileGrant(GRANTS.hr_admin).filter((r) => !NEW_HR.has(r.pattern) && !(r.pattern === "asset-categories.**" && r.level === "read"));
  for (const r of [...hrToday, ...HR_ASSET_ROWS]) await insertRule("hr_admin", r);
  // A per-record share an admin authored for hr_admin on one asset: not a seeded rule, so it must survive.
  await insertRule("hr_admin", { namespace: "assets", pattern: "assets.0000k.**", scopeKind: "exact", scopeCode: "0000k", matchCode: "0000k", level: "read", effect: "allow" });

  await db.prepare("INSERT INTO employees (uuid, code, first_name, last_name, work_email, status, created_at, updated_at) VALUES ('e00000000000a', '04-001', 'Req', 'T', 'req@t.example', 'active', 0, 0)").run();
  for (const [uuid, code, category] of [["t00000000000a", "04-001-1", "it"], ["t00000000000c", "04-001-2", "hr"]]) {
    await db
      .prepare("INSERT INTO tickets (uuid, code, employee_id, category, subject, priority, state, created_at, updated_at) VALUES (?, ?, 'e00000000000a', ?, 'x', 'medium', 'OPEN', 0, 0)")
      .bind(uuid, code, category)
      .run();
  }
  if (categories) await db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('ticket-categories', ?, 0)").bind(JSON.stringify({ categories })).run();
}

type Row = CompiledRule & { subject: string; source: string };
const rulesOf = async (subject: string) =>
  (await db.prepare("SELECT subject, namespace, pattern, scope_kind AS scopeKind, scope_code AS scopeCode, match_code AS matchCode, level, effect, source FROM access_rules WHERE subject = ? AND subject_kind = 'role'").bind(subject).all<Row>()).results;
const categoriesNow = async () => (JSON.parse((await db.prepare("SELECT value FROM settings WHERE key = 'ticket-categories'").first<{ value: string }>())!.value) as { categories: { key: string; roles?: string[] }[] }).categories;
const itShares = async (code: string) => (await rulesOf("it_admin")).filter((r) => r.pattern === `tickets.${code}.**` && r.source === "ticket-share");

const SAMPLE: [string, string][] = [
  ["GET", "/v1/assets/0000k"], ["PATCH", "/v1/assets/0000k"], ["POST", "/v1/assets/0000k:verify"], ["POST", "/v1/stocktakes"],
  ["GET", "/v1/asset-categories/0000m"], ["PATCH", "/v1/asset-categories/0000m"], ["POST", "/v1/asset-requests/04-001-1:issue"],
  ["PATCH", "/v1/settings/asset-tags"], ["GET", "/v1/users"], ["POST", "/v1/users/0000p:resetPin"], ["PATCH", "/v1/users/0000p"],
  ["GET", "/v1/leave-requests/04-001-1"], ["POST", "/v1/leave-requests"], ["GET", "/v1/employees/04-001"], ["GET", "/v1/tickets/04-001-1"],
  ["GET", "/v1/access-rules"], ["GET", "/v1/roles"], ["PATCH", "/v1/settings/ticket-categories"],
];
// What the migrated broad rows decide, next to what the seed decides for a fresh install.
function parity(role: "it_admin" | "hr_admin", rows: Row[]) {
  const migrated = mergeGrants(rulesToGrant(rows.filter((r) => r.matchCode === null)), EVERYONE_GRANT);
  for (const [m, p] of SAMPLE) {
    const ctx = { employeeCode: "04-001" };
    expect(decide(migrated, resolveRequest(m, p, false), ctx).allow, `${role} ${m} ${p}`).toBe(decide(grantFor(role), resolveRequest(m, p, false), ctx).allow);
  }
}

describe("migration 0004: it_admin, HR without assets, HR resets PINs", () => {
  it("creates it_admin deciding as the seeded role does, and moves the asset rules off hr_admin", async () => {
    await seedOldState([{ key: "it", name: "IT & Systems" }, { key: "hr", name: "HR" }]);
    await migrate();
    expect(await db.prepare("SELECT label FROM roles WHERE name = 'it_admin'").first()).toEqual({ label: "IT Admin" });
    parity("it_admin", await rulesOf("it_admin"));
    const hr = await rulesOf("hr_admin");
    parity("hr_admin", hr);
    // The admin-authored per-record share is untouched.
    expect(hr.some((r) => r.pattern === "assets.0000k.**" && r.level === "read")).toBe(true);
  });

  it("services the IT desk: roles on the `it` category, and a share on each IT ticket only", async () => {
    await seedOldState([{ key: "it", name: "IT & Systems" }, { key: "hr", name: "HR" }]);
    await migrate();
    const cats = await categoriesNow();
    expect(cats.find((c) => c.key === "it")!.roles).toEqual(["it_admin"]);
    expect(cats.find((c) => c.key === "hr")!.roles).toBeUndefined();
    expect((await itShares("04-001-1")).map((r) => r.level).sort()).toEqual([null, "write"].sort());
    expect(await itShares("04-001-2")).toHaveLength(0);
  });

  it("is a no-op the second time", async () => {
    await seedOldState([{ key: "it", name: "IT & Systems" }]);
    await migrate();
    const once = { it: (await rulesOf("it_admin")).length, hr: (await rulesOf("hr_admin")).length, cats: await categoriesNow() };
    await migrate();
    expect({ it: (await rulesOf("it_admin")).length, hr: (await rulesOf("hr_admin")).length, cats: await categoriesNow() }).toEqual(once);
  });

  it("leaves a desk whose roles the org already set alone, and shares nothing from it", async () => {
    await seedOldState([{ key: "it", name: "IT & Systems", roles: [] }]);
    await migrate();
    expect((await categoriesNow())[0]!.roles).toEqual([]);
    expect(await itShares("04-001-1")).toHaveLength(0);
  });

  it("with no settings row (the service's default names it_admin), shares the IT tickets", async () => {
    await seedOldState(null);
    await migrate();
    expect(await itShares("04-001-1")).toHaveLength(2);
    expect(await itShares("04-001-2")).toHaveLength(0);
  });
});
