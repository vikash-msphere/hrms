/// <reference types="vite/client" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Bindings } from "../src/env";
import { GRANTS, EVERYONE_GRANT } from "../bootstrap/authz/grants";
import { DEFAULT_POLICY, OWNER_REFS, REFERENCES, SUPPORTED_SCOPES } from "../bootstrap/authz/policy";
import { compileGrant, rulesToGrant, type CompiledRule } from "../src/domain/compileGrants";
import { decide, resolveRequest } from "../src/domain/permissions";
import { CARD_WORK_VERBS } from "../src/domain/boardAccess";

// The board access section of migration 0004 carries board access to a LIVE database: every existing board, card
// and sprint is re-coded under the visibility segment (everyone keeps seeing and working every board), a
// per-record rule on an old code follows it, the seeded roles' org-wide board rules become the segment rules the
// seed now writes, the project manager role arrives, and the policy manifest files cards and sprints under their
// board. Every earlier migration and 0004's earlier sections are applied first, and the section's own schema
// statements once; each test lays down the database as the OLD seed left it and applies the section's data
// statements - twice, since a re-run must change nothing. The section runs from its header to the end of 0004.
const migrations = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const paths = Object.keys(migrations).sort();
const release = paths.find((p) => p.includes("0004_release_four"))!;
const whole = migrations[release]!;
const start = whole.indexOf("-- Board access: a department on a board, and per-board visibility.");
if (start < 0) throw new Error("board access section not found in 0004_release_four.sql");
const section = whole.slice(start);
const db = (env as unknown as Bindings).DB;
const statements = (sql: string) => sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
// A statement is schema when its first line of SQL (past the comment header) alters or indexes a table.
const isSchema = (s: string) => /^(ALTER TABLE|CREATE INDEX)/m.test(s.replace(/^--.*$/gm, "").trim().split("\n")[0] ?? "");
const run = async (list: string[]) => { for (const s of list) await db.prepare(s).run(); };
const migrate = () => run(statements(section).filter((s) => !isSchema(s)));

beforeAll(async () => {
  for (const p of paths.filter((p) => p < release)) await run(statements(migrations[p]!));
  await run(statements(whole.slice(0, start)));
  await run(statements(section).filter(isSchema));
  for (const p of paths.filter((p) => p > release)) await run(statements(migrations[p]!));
});

beforeEach(async () => {
  for (const t of ["access_rules", "cards", "sprints", "boards", "policy", "users", "employees", "roles"]) await db.prepare(`DELETE FROM ${t}`).run();
});

let n = 0;
const id = () => `m${String(++n).padStart(11, "0")}0`;
const insertRule = (subject: string, r: CompiledRule, kind = "role") =>
  db.prepare("INSERT INTO access_rules (uuid, subject, subject_kind, namespace, pattern, scope_kind, scope_code, match_code, level, effect, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'acl', 0, 0)")
    .bind(id(), subject, kind, r.namespace, r.pattern, r.scopeKind, r.scopeCode, r.matchCode, r.level, r.effect).run();

const all = (pattern: string, level: CompiledRule["level"]): CompiledRule => ({ namespace: pattern.split(".")[0]!, pattern, scopeKind: "all", scopeCode: "", matchCode: null, level, effect: "allow" });

// The board rules as the seed wrote them before this change, per role. A role's current rules OUTSIDE boards,
// cards and sprints are unchanged, so the old state is those plus these.
const OLD_EMPLOYEE = [all("boards.**", "read"), all("sprints.**", "read"), all("cards.**", "write"), all("boards.*.metrics", null), ...CARD_WORK_VERBS.map((v) => all(`cards.*.${v}`, null))];
const OLD_EXTRA: Record<string, CompiledRule[]> = {
  employee: OLD_EMPLOYEE,
  manager: [...OLD_EMPLOYEE.filter((r) => r.pattern !== "boards.**" && r.pattern !== "sprints.**"), all("boards.**", "write"), all("sprints.**", "write"), all("boards.**", null), all("sprints.**", null)],
  hr_admin: [...OLD_EMPLOYEE.filter((r) => r.pattern !== "boards.**" && r.pattern !== "sprints.**"), all("boards.**", "write"), all("sprints.**", "write"), all("boards.**", null), all("sprints.**", null), all("cards.**", null)],
  payroll_admin: [...OLD_EMPLOYEE, all("cards.**", null)],
};
const BOARD_NS = new Set(["boards", "cards", "sprints"]);
const OLD_ROLES = ["employee", "manager", "hr_admin", "payroll_admin"] as const;

async function seedOldState() {
  for (const name of [...OLD_ROLES, "everyone"]) await db.prepare("INSERT INTO roles (name, label, protected, created_at, updated_at) VALUES (?, ?, 1, 0, 0)").bind(name, name).run();
  for (const role of OLD_ROLES) {
    for (const r of compileGrant(GRANTS[role]).filter((r) => !BOARD_NS.has(r.namespace) || r.pattern === "cards.draft")) await insertRule(role, r);
    for (const r of OLD_EXTRA[role]!) await insertRule(role, r);
  }
  for (const r of compileGrant(EVERYONE_GRANT)) await insertRule("everyone", r);
  // One board of each kind of history: a flat code, two cards coded under the people who filed them, a sprint.
  await db.prepare("INSERT INTO employees (uuid, code, first_name, last_name, work_email, status, created_at, updated_at) VALUES ('e00000000000a', '04-001', 'A', 'B', 'a@t.example', 'active', 0, 0)").run();
  await db.prepare("INSERT INTO boards (uuid, code, name, created_at, updated_at) VALUES ('b00000000000a', '01', 'General', 0, 0)").run();
  await db.prepare("INSERT INTO sprints (uuid, code, board_id, name, state, created_at, updated_at) VALUES ('s00000000000a', '01', 'b00000000000a', 'S1', 'planning', 0, 0)").run();
  for (const [uuid, code, seq] of [["c00000000000a", "04-001-001", 1], ["c00000000000c", "04-001-002", 40]] as const) {
    await db.prepare("INSERT INTO cards (uuid, code, board_id, seq, employee_id, column_key, rank, title, created_at, updated_at) VALUES (?, ?, 'b00000000000a', ?, 'e00000000000a', 'backlog', 0, 'T', 0, 0)").bind(uuid, code, seq).run();
  }
  // A per-record share an admin authored on the first card, for a user: it must follow the card to its new code.
  await insertRule("u00000000000a", { namespace: "cards", pattern: "cards.04-001-001.**", scopeKind: "exact", scopeCode: "04-001-001", matchCode: "04-001-001", level: "read", effect: "allow" }, "user");
  // The manifest as the old seed wrote it.
  const oldPolicy = {
    ...DEFAULT_POLICY,
    owner_refs: { ...OWNER_REFS, cards: { employee: { collection: "employees" } } },
    references: { ...REFERENCES, sprints: { board: { collection: "boards", level: "read" } } },
    supported_scopes: { ...SUPPORTED_SCOPES, cards: ["self", "reports", "org", "dept", "all"] },
  };
  await db.prepare("INSERT INTO policy (key, value_json, updated_at) VALUES ('manifest', ?, 0)").bind(JSON.stringify(oldPolicy)).run();
}

type Row = CompiledRule & { subject: string };
const rulesOf = async (subject: string) =>
  (await db.prepare("SELECT subject, namespace, pattern, scope_kind AS scopeKind, scope_code AS scopeCode, match_code AS matchCode, level, effect FROM access_rules WHERE subject = ?").bind(subject).all<Row>()).results;
const codeOf = async (table: string, uuid: string) => (await db.prepare(`SELECT code FROM ${table} WHERE uuid = ?`).bind(uuid).first<{ code: string }>())!.code;

// Board requests that separate every level: each segment, each verb family, create gates.
const SAMPLE: [string, string][] = [
  ["GET", "/v1/boards"], ["POST", "/v1/boards"], ["GET", "/v1/boards/ve-01"], ["PATCH", "/v1/boards/ve-01"], ["POST", "/v1/boards/ve-01:configure"],
  ["POST", "/v1/boards/ve-01:metrics"], ["GET", "/v1/boards/vr-01"], ["GET", "/v1/boards/vp-01"], ["POST", "/v1/boards/vp-01:share"],
  ["GET", "/v1/cards"], ["POST", "/v1/cards"], ["PATCH", "/v1/cards/ve-01-001"], ["POST", "/v1/cards/ve-01-001:move"], ["POST", "/v1/cards/vr-01-001:move"],
  ["GET", "/v1/cards/vr-01-001"], ["POST", "/v1/cards/vr-01-001:watch"], ["GET", "/v1/cards/vp-01-001"],
  ["POST", "/v1/sprints"], ["GET", "/v1/sprints/ve-01-001"], ["POST", "/v1/sprints/ve-01-001:activate"], ["GET", "/v1/sprints/vp-01-001"],
];
const SELF = { employeeCode: "04-001" };

describe("migration 0004: board access on a live database", () => {
  it("every seeded role decides board requests exactly as the new seed does - and a re-run changes nothing", async () => {
    await seedOldState();
    await migrate();
    const once = (await db.prepare("SELECT count(*) AS n FROM access_rules").first<{ n: number }>())!.n;
    await migrate();
    expect((await db.prepare("SELECT count(*) AS n FROM access_rules").first<{ n: number }>())!.n).toBe(once);
    for (const role of [...OLD_ROLES, "project_manager"] as const) {
      const migrated = rulesToGrant(await rulesOf(role));
      for (const [m, p] of SAMPLE) {
        expect(decide(migrated, resolveRequest(m, p, false), SELF).allow, `${role} ${m} ${p}`).toBe(decide(GRANTS[role], resolveRequest(m, p, false), SELF).allow);
      }
    }
  });

  it("re-codes boards, cards and sprints under the everyone-works-it segment, and carries a record's share with it", async () => {
    await seedOldState();
    await migrate();
    await migrate();
    expect(await codeOf("boards", "b00000000000a")).toBe("ve-01");
    expect(await codeOf("cards", "c00000000000a")).toBe("ve-01-001");
    expect(await codeOf("cards", "c00000000000c")).toBe("ve-01-018"); // task 40 in base32
    expect(await codeOf("sprints", "s00000000000a")).toBe("ve-01-001");
    const [share] = await rulesOf("u00000000000a");
    expect(share).toMatchObject({ pattern: "cards.ve-01-001.**", scopeCode: "ve-01-001", matchCode: "ve-01-001" });
  });

  it("files a card under its board, asks write on the board for a sprint, and drops the employee-relative card tiers", async () => {
    await seedOldState();
    await migrate();
    await migrate();
    const policy = JSON.parse((await db.prepare("SELECT value_json FROM policy WHERE key = 'manifest'").first<{ value_json: string }>())!.value_json);
    expect(policy.owner_refs.cards).toEqual(OWNER_REFS.cards);
    expect(policy.references.sprints).toEqual(REFERENCES.sprints);
    expect(policy.supported_scopes.cards).toBeUndefined();
  });

  it("does nothing to a fresh database, which the seed then fills", async () => {
    await migrate();
    expect((await db.prepare("SELECT count(*) AS n FROM access_rules").first<{ n: number }>())!.n).toBe(0);
    expect((await db.prepare("SELECT count(*) AS n FROM roles").first<{ n: number }>())!.n).toBe(0);
  });
});
