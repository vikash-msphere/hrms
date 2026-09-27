/// <reference types="vite/client" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Bindings } from "../src/env";
import type { Policy } from "../src/domain/manifests";
import { DEFAULT_POLICY } from "../bootstrap/authz/policy";
import { rulesToGrant, type CompiledRule } from "../src/domain/compileGrants";
import { decide, type SelfContext } from "../src/domain/permissions";
import { base32ToBytes } from "../src/lib/idCodec";
import { parseRulePattern } from "../src/http/serialize";

// Migration 0001 makes `employees.probation_end_date` a redacted field on the LIVE database: it edits the stored
// policy manifest (production never reads DEFAULT_POLICY) and gives every 2-token employee row grant a sibling
// field-read rule, because a pattern with no `**` tail never reaches `employees.<code>.probation_end_date`. It
// runs once against real roles nobody here can see, so this replays it against the shapes those rows can be in
// and asks the real engine who can read the field afterwards.
const migrations = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const paths = Object.keys(migrations).sort();
const base = paths.filter((p) => !p.includes("0001_redact_probation_end_date"));
const target = paths.find((p) => p.includes("0001_redact_probation_end_date"))!;
const db = (env as unknown as Bindings).DB;

async function runSql(sql: string) {
  for (const stmt of sql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await db.prepare(s).run();
  }
}
const migrate = () => runSql(migrations[target]!);

type Row = { uuid: string; subject: string; subject_kind: string; pattern: string; scope_kind: string; scope_code: string; match_code: string | null; level: string | null; effect: string; status: string; expires_at: number | null };
async function rules(): Promise<Row[]> {
  return (await db.prepare("SELECT uuid, subject, subject_kind, pattern, scope_kind, scope_code, match_code, level, effect, status, expires_at FROM access_rules ORDER BY subject, pattern").all<Row>()).results;
}
async function manifest(): Promise<Policy> {
  const row = await db.prepare("SELECT value_json FROM policy WHERE key = 'manifest'").first<{ value_json: string }>();
  return JSON.parse(row!.value_json) as Policy;
}
async function setManifest(p: unknown) {
  await db.prepare("DELETE FROM policy WHERE key = 'manifest'").run();
  await db.prepare("INSERT INTO policy (key, value_json, updated_at) VALUES ('manifest', ?, 0)").bind(JSON.stringify(p)).run();
}

// The manifest as production stored it before this change: everything DEFAULT_POLICY has, minus the new entry.
const { employees: _added, ...redactedBefore } = DEFAULT_POLICY.redacted_fields ?? {};
const manifestBefore = { ...DEFAULT_POLICY, redacted_fields: redactedBefore };

let seq = 0;
async function rule(subject: string, pattern: string, level: string | null, extra: { effect?: string; status?: string; kind?: string; scope?: string; scopeCode?: string; expires?: number } = {}) {
  seq++;
  await db
    .prepare("INSERT INTO access_rules (uuid, subject, subject_kind, namespace, pattern, scope_kind, scope_code, match_code, level, effect, status, expires_at, created_at, updated_at) VALUES (?, ?, ?, 'employees', ?, ?, ?, NULL, ?, ?, ?, ?, 0, 0)")
    .bind(`seed${String(seq).padStart(9, "0")}`, subject, extra.kind ?? "role", pattern, extra.scope ?? "all", extra.scopeCode ?? "", level, extra.effect ?? "allow", extra.status ?? "active", extra.expires ?? null)
    .run();
}

const grantOf = (rows: Row[], subject: string) =>
  rulesToGrant(
    rows
      .filter((r) => r.subject === subject && r.status === "active")
      .map((r): CompiledRule => ({ namespace: "employees", pattern: r.pattern, scopeKind: r.scope_kind as CompiledRule["scopeKind"], scopeCode: r.scope_code, matchCode: r.match_code, level: r.level as CompiledRule["level"], effect: r.effect as CompiledRule["effect"] })),
  );
const readsProbation = (rows: Row[], subject: string, code: string, self: SelfContext) =>
  decide(grantOf(rows, subject), { kind: "standard", resource: `employees.${code}.probation_end_date`, level: "read" }, self).allow;

beforeAll(async () => {
  await runSql(base.map((p) => migrations[p]).join("\n--> statement-breakpoint\n"));
});

describe("migration 0001: access rules", () => {
  beforeAll(async () => {
    await setManifest(manifestBefore);
    await rule("hr_admin", "employees.*", "write"); // org-wide write: keeps it
    await rule("hr_admin", "employees.**", null); // verb allow: no level, no sibling
    await rule("payroll_admin", "employees.*", "read"); // org-wide READ: directory breadth, loses it
    await rule("manager", "employees.my-dept", "read", { scope: "dept" }); // team: keeps it
    await rule("employee", "employees.me", "read", { scope: "self" }); // self: keeps it
    await rule("employee", "employees", "read"); // list capability, not a row: nothing to copy
    await rule("everyone", "employees.**", "read"); // an ACL-shaped rule already reaches the field
    await rule("u-branch", "employees.04-*", "read", { kind: "user", scope: "subtree", scopeCode: "04", expires: 4_102_444_800_000 }); // temporary branch share: copied with its expiry
    await rule("hr_pending", "employees.*", "write", { status: "pending" }); // inert until approved: not copied
    await rule("blocked", "employees.*", null, { effect: "deny" }); // a deny: not copied
    await migrate();
  });

  it("adds exactly one sibling field-read rule per qualifying row grant", async () => {
    const added = (await rules()).filter((r) => r.pattern.includes("probation_end_date"));
    expect(added.map((r) => [r.subject, r.pattern, r.level, r.effect, r.status, r.scope_kind, r.scope_code])).toEqual([
      ["employee", "employees.me.probation_end_date.**", "read", "allow", "active", "self", ""],
      ["hr_admin", "employees.*.probation_end_date.**", "read", "allow", "active", "all", ""],
      ["manager", "employees.my-dept.probation_end_date.**", "read", "allow", "active", "dept", ""],
      ["u-branch", "employees.04-*.probation_end_date.**", "read", "allow", "active", "subtree", "04"],
    ]);
    expect(added.find((r) => r.subject === "u-branch")!.expires_at).toBe(4_102_444_800_000);
  });

  it("writes ids the wire codec accepts, and patterns the ACL editor reads as field rules", async () => {
    const added = (await rules()).filter((r) => r.pattern.includes("probation_end_date"));
    for (const r of added) {
      expect(base32ToBytes(r.uuid, 8), `uuid ${r.uuid}`).not.toBeNull();
      expect(parseRulePattern(r.pattern, r.level).field).toBe("probation_end_date");
    }
    expect(new Set(added.map((r) => r.uuid)).size).toBe(added.length);
  });

  it("is idempotent", async () => {
    const before = await rules();
    await migrate();
    expect(await rules()).toEqual(before);
  });

  it("leaves the field with HR, the management line and the person, and takes it from org-wide readers", async () => {
    const rows = await rules();
    const member = "04-1c-e02";
    const outsider = "05-aa-e03";
    expect(readsProbation(rows, "hr_admin", outsider, { employeeCode: "04-1c-h01" })).toBe(true);
    expect(readsProbation(rows, "manager", member, { employeeCode: "04-1c-m01" })).toBe(true);
    expect(readsProbation(rows, "manager", outsider, { employeeCode: "04-1c-m01" })).toBe(false);
    expect(readsProbation(rows, "employee", member, { employeeCode: member })).toBe(true);
    expect(readsProbation(rows, "employee", outsider, { employeeCode: member })).toBe(false);
    expect(readsProbation(rows, "payroll_admin", member, { employeeCode: "02-pp-p01" })).toBe(false);
  });
});

describe("migration 0001: policy manifest", () => {
  beforeEach(async () => {
    await db.prepare("DELETE FROM access_rules").run();
  });

  it("adds the entry and keeps every other redacted field", async () => {
    await setManifest(manifestBefore);
    await migrate();
    const p = await manifest();
    expect(p.redacted_fields).toEqual({ ...redactedBefore, employees: ["probation_end_date"] });
    expect(p.protected_fields).toEqual(DEFAULT_POLICY.protected_fields);
  });

  it("creates `redacted_fields` on a manifest written before it existed", async () => {
    const { redacted_fields: _none, ...older } = manifestBefore;
    await setManifest(older);
    await migrate();
    expect((await manifest()).redacted_fields).toEqual({ employees: ["probation_end_date"] });
  });

  it("appends to an `employees` entry an admin already wrote, once", async () => {
    await setManifest({ ...manifestBefore, redacted_fields: { ...redactedBefore, employees: ["job_title"] } });
    await migrate();
    await migrate();
    expect((await manifest()).redacted_fields?.employees).toEqual(["job_title", "probation_end_date"]);
  });
});
