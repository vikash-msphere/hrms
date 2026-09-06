/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { createAccessRule, deleteAccessRule, decideAccessRule, purgeExpiredAccessRules, cloneAccessRules } from "../src/services/accessRules";
import { previewAccess } from "../src/services/accessPreview";
import { loadRoleGrantUncached } from "../src/lib/policyLoad";
import { DEFAULT_POLICY } from "../src/domain/manifests";
import { clearCachePrefix } from "../src/lib/cache";
import { invalidateCodeCache } from "../src/lib/authzResolve";

// Rule LIFECYCLE, against real D1: a rule only decides while it is active and unexpired. Two features ride
// that one predicate (lib/policyLoad `live`), and both are the kind of thing that silently fails open or
// closed if it regresses - so each is asserted through the ENGINE (previewAccess / loadRoleGrant), not just
// by reading the row back.
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

const ids = { anaEmp: genId(), boEmp: genId(), carlaEmp: genId(), ana: genId(), bo: genId(), carla: genId() };

// Two access admins: `ana` authors, `bo` approves (four eyes needs two humans).
const actor = (uuid: string, email: string, employeeId: string): AppUser =>
  ({ uuid, email, role: "hr_admin", status: "active", employeeId, employeeCode: null, name: email, grant: { levels: {}, denies: [], customs: [] } as never, policy: DEFAULT_POLICY }) as AppUser;
const ana = () => actor(ids.ana, "ana@test.example", ids.anaEmp);
const bo = () => actor(ids.bo, "bo@test.example", ids.boEmp);

const setApproval = async (enabled: boolean) => {
  const value = JSON.stringify({ enabled });
  await deps.db.insert(schema.settings).values({ key: "access-approval", value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } });
  clearCachePrefix(""); // the settings blob is cached like every other read
};

beforeEach(async () => {
  for (const t of [schema.accessRules, schema.users, schema.employees, schema.roles, schema.settings, schema.auditLog, schema.notifications]) await deps.db.delete(t);
  clearCachePrefix("");
  invalidateCodeCache();
  await deps.db.insert(schema.roles).values([
    { name: "employee", label: "Employee" },
    { name: "hr_admin", label: "HR Admin" },
    { name: "everyone", label: "Everyone" },
  ]);
  await deps.db.insert(schema.employees).values([
    { uuid: ids.anaEmp, code: "04-001", firstName: "Ana", lastName: "T", workEmail: "ana@test.example", status: "active" },
    { uuid: ids.boEmp, code: "04-002", firstName: "Bo", lastName: "T", workEmail: "bo@test.example", status: "active" },
  ]);
  await deps.db.insert(schema.users).values([
    { uuid: ids.ana, code: `u-${genId().slice(0, 6)}`, email: "ana@test.example", role: "hr_admin", employeeId: ids.anaEmp },
    { uuid: ids.bo, code: `u-${genId().slice(0, 6)}`, email: "bo@test.example", role: "hr_admin", employeeId: ids.boEmp },
  ]);
});

const grantEmployeeRead = (extra: Record<string, unknown> = {}) => ({ subject_kind: "role", subject: "employee", collection: "leave-requests", scope: "all", level: "read", ...extra });
const roleCanRead = async () => Boolean((await loadRoleGrantUncached(deps, "employee")).levels?.["leave-requests.**"]);

describe("expiring grants", () => {
  it("decides while unexpired and stops the moment it lapses - without the row being deleted", async () => {
    const soon = new Date(+deps.clock.now() + 60_000).toISOString();
    const rule = await createAccessRule(deps, ana(), grantEmployeeRead({ expire_time: soon }));
    expect(rule.expiresAt).toBeTruthy();
    expect(await roleCanRead()).toBe(true);

    // Move the expiry into the past: the ROW is untouched, the engine simply stops loading it.
    await deps.db.update(schema.accessRules).set({ expiresAt: new Date(+deps.clock.now() - 1000) });
    clearCachePrefix("");
    expect(await roleCanRead()).toBe(false);
    expect((await deps.db.select().from(schema.accessRules)).length).toBe(1); // still there; expiry is not deletion
  });

  it("rejects an expiry in the past (a rule authored dead reads as granted access that does nothing)", async () => {
    await expect(createAccessRule(deps, ana(), grantEmployeeRead({ expire_time: new Date(+deps.clock.now() - 1000).toISOString() }))).rejects.toThrow(/future/);
  });

  it("the nightly purge removes lapsed rules and leaves live ones alone", async () => {
    const temp = await createAccessRule(deps, ana(), grantEmployeeRead({ expire_time: new Date(+deps.clock.now() + 60_000).toISOString() }));
    const permanent = await createAccessRule(deps, ana(), { ...grantEmployeeRead(), collection: "holidays" });
    // Backdate ONLY the temporary rule, so the purge has both a lapsed and a live row to choose between.
    await deps.db.update(schema.accessRules).set({ expiresAt: new Date(+deps.clock.now() - 1000) }).where(eq(schema.accessRules.uuid, temp.uuid));

    expect(await purgeExpiredAccessRules(deps)).toBe(1);
    const left = await deps.db.select().from(schema.accessRules);
    expect(left.map((r) => r.uuid)).toEqual([permanent.uuid]);

    // The lapsed rule is hard-deleted, so the trail is the only surviving record of the access it granted -
    // and it must name that rule, not just count it. A nightly `{ expired: 4 }` says four people somewhere
    // lost something, which is the shape of entry nobody can act on.
    const entries = (await deps.db.select().from(schema.auditLog)).filter((r) => r.action === "access-rule.expire");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entityId).toBe(temp.uuid);
    const meta = JSON.parse(entries[0]!.meta!) as { subject: string; collection: string; pattern: string };
    expect(meta.collection).toBe(temp.namespace); // the access it granted, named ("leave-requests" here)
    expect(meta.pattern).toBeTruthy();
    expect(meta.subject).toBeTruthy();
  });
});

describe("four-eyes approval", () => {
  it("off by default: a rule is active immediately", async () => {
    const rule = await createAccessRule(deps, ana(), grantEmployeeRead());
    expect(rule.status).toBe("active");
    expect(await roleCanRead()).toBe(true);
  });

  it("on: a new grant is INERT until a second admin approves it", async () => {
    await setApproval(true);
    const rule = await createAccessRule(deps, ana(), grantEmployeeRead());
    expect(rule.status).toBe("pending");
    expect(await roleCanRead()).toBe(false); // authored, visible, and granting nothing

    await expect(decideAccessRule(deps, ana(), rule.uuid, "approve")).rejects.toThrow(/someone other than/);
    const approved = await decideAccessRule(deps, bo(), rule.uuid, "approve");
    expect(approved.status).toBe("active");
    clearCachePrefix("");
    expect(await roleCanRead()).toBe(true);
  });

  it("on: a removal KEEPS enforcing until approved, then the rule is gone", async () => {
    const rule = await createAccessRule(deps, ana(), grantEmployeeRead());
    await setApproval(true);
    const id = rule.uuid;

    await deleteAccessRule(deps, ana(), id);
    clearCachePrefix("");
    const marked = (await deps.db.select().from(schema.accessRules))[0]!;
    expect(marked.status).toBe("pending_delete");
    expect(await roleCanRead()).toBe(true); // the removal is a REQUEST; authority is unchanged meanwhile

    await decideAccessRule(deps, bo(), id, "approve");
    clearCachePrefix("");
    expect(await roleCanRead()).toBe(false);
    expect((await deps.db.select().from(schema.accessRules)).length).toBe(0);
  });

  it("rejecting a pending grant drops it; rejecting a pending removal restores the rule", async () => {
    await setApproval(true);
    const pending = await createAccessRule(deps, ana(), grantEmployeeRead());
    await decideAccessRule(deps, bo(), pending.uuid, "reject");
    expect((await deps.db.select().from(schema.accessRules)).length).toBe(0);

    await setApproval(false);
    const live = await createAccessRule(deps, ana(), grantEmployeeRead());
    await setApproval(true);
    const id = live.uuid;
    await deleteAccessRule(deps, ana(), id);
    await decideAccessRule(deps, bo(), id, "reject");
    clearCachePrefix("");
    const row = (await deps.db.select().from(schema.accessRules))[0]!;
    expect(row.status).toBe("active");
    expect(await roleCanRead()).toBe(true);
  });

  it("the preview reports what the engine sees, so a pending grant does not read as granted", async () => {
    await setApproval(true);
    await createAccessRule(deps, ana(), { subject_kind: "user", subject: `users/${ids.bo}`, collection: "leave-requests", scope: "all", level: "read" });
    clearCachePrefix("");
    const [verdict] = await previewAccess(deps, { subjects: [`users/${ids.bo}`], collection: "leave-requests" });
    expect(verdict!.read).toBe(false);
  });
});

describe("the audit trail names the change", () => {
  it("records the rule id, its collection and a readable sentence", async () => {
    await createAccessRule(deps, ana(), grantEmployeeRead());
    const [row] = await deps.db.select().from(schema.auditLog);
    expect(row!.action).toBe("access-rule.create");
    const meta = JSON.parse(row!.meta!) as { rule_id: string; collection: string; sentence: string };
    expect(meta.collection).toBe("leave-requests");
    expect(meta.rule_id).toBeTruthy();
    expect(meta.sentence).toContain("leave requests");
  });

  // Every rule event, not just the create. The delete, the reject and the expiry all HARD-DELETE the row, so
  // an entry that carries only a pattern and a uuid leaves nothing to read back - which is what made the
  // permission feed unreadable: no field diff, no sentence, nothing but an actor and an id.
  it("names the rule on a revocation too, and says who it was for", async () => {
    const rule = await createAccessRule(deps, ana(), grantEmployeeRead());
    await deleteAccessRule(deps, ana(), rule.uuid);
    const entry = (await deps.db.select().from(schema.auditLog)).find((r) => r.action === "access-rule.delete")!;
    const meta = JSON.parse(entry.meta!) as { sentence: string; subject_label: string; scope: string; effect: string };
    expect(meta.sentence).toContain("read access");
    expect(meta.subject_label).toBe("the employee role");
    expect(meta.scope).toBe("all");
    expect(meta.effect).toBe("allow");
    // The label is snapshotted at write time, so the deleted rule still names itself in the feed's Record cell.
    expect(entry.entityName).toBe("employee → leave-requests");
  });

  // A USER rule stores a users uuid: the one fact in the entry a reader can do nothing with. The trail carries
  // the email and the employee ref instead, so the feed can name the person after the row (and the rule) is gone.
  it("resolves a user subject to a person", async () => {
    const rule = await createAccessRule(deps, ana(), { subject_kind: "user", subject: `users/${ids.bo}`, collection: "leave-requests", scope: "all", level: "read" });
    await deleteAccessRule(deps, ana(), rule.uuid);
    const entry = (await deps.db.select().from(schema.auditLog)).find((r) => r.action === "access-rule.delete")!;
    const meta = JSON.parse(entry.meta!) as { subject_label: string; subject_employee: string };
    expect(meta.subject_label).toBe("bo@test.example");
    expect(meta.subject_employee).toBe(`employees/${ids.boEmp}`);
  });

  // A four-eyes decision approves either a grant or a REMOVAL under one action code; without `decided` the two
  // opposite outcomes render identically.
  it("says which pending change a decision decided, and who asked for it", async () => {
    const rule = await createAccessRule(deps, ana(), grantEmployeeRead());
    await setApproval(true);
    await deleteAccessRule(deps, ana(), rule.uuid); // marks pending_delete
    await decideAccessRule(deps, bo(), rule.uuid, "approve");
    const entry = (await deps.db.select().from(schema.auditLog)).find((r) => r.action === "access-rule.approve")!;
    const meta = JSON.parse(entry.meta!) as { decided: string; requested_by: string; sentence: string };
    expect(meta.decided).toBe("removal");
    expect(meta.requested_by).toBe(`employees/${ids.anaEmp}`);
    expect(meta.sentence).toContain("leave requests");
  });

  // The pattern is the only place a verb or a field path lives; a rule about ONE field read as a rule about the
  // whole collection.
  it("reads the field back out of the pattern", async () => {
    await createAccessRule(deps, ana(), grantEmployeeRead({ collection: "employees", field: "bank-account", scope: "all" }));
    const entry = (await deps.db.select().from(schema.auditLog)).find((r) => r.action === "access-rule.create")!;
    const meta = JSON.parse(entry.meta!) as { field: string; sentence: string };
    expect(meta.field).toBe("bank-account");
    expect(meta.sentence).toContain("bank-account");
  });
});

// Copying a role's permissions onto another is what the compare view exists for, and it used to be a CLIENT
// loop of N creates: N requests, N unrelated audit entries, N notifications, and no way to ask the trail who
// copied what onto whom. One request, one correlation id, one summary entry.
describe("copying one subject's rules onto another", () => {
  const manager = () => ({ subject_kind: "role", subject: "manager" }) as const;
  const employee = () => ({ subject_kind: "role", subject: "employee" }) as const;

  beforeEach(async () => {
    await deps.db.insert(schema.roles).values({ name: "manager", label: "Manager" });
    // One holder of the TARGET role, so the notification count is observable (a copy onto a role nobody holds
    // notifies nobody, which would prove nothing about the per-rule cards being suppressed).
    await deps.db.insert(schema.employees).values({ uuid: ids.carlaEmp, code: "04-003", firstName: "Carla", lastName: "T", workEmail: "carla@test.example", status: "active" });
    await deps.db.insert(schema.users).values({ uuid: ids.carla, code: `u-${genId().slice(0, 6)}`, email: "carla@test.example", role: "manager", employeeId: ids.carlaEmp });
    clearCachePrefix("");
  });

  it("copies every active rule and ties the whole copy to one correlation id", async () => {
    await createAccessRule(deps, ana(), grantEmployeeRead());
    await createAccessRule(deps, ana(), grantEmployeeRead({ collection: "attendance" }));
    const before = await deps.db.select().from(schema.auditLog);

    const res = await cloneAccessRules(deps, ana(), { from: employee(), to: manager() });
    expect(res).toMatchObject({ added: 2, skipped: 0, failed: 0, source_total: 2 });
    expect(res.correlation_id).toBeTruthy();

    // The target holds the same two rules, authored as its own.
    const mine = (await deps.db.select().from(schema.accessRules)).filter((r) => r.subject === "manager");
    expect(mine.map((r) => r.pattern).sort()).toEqual(["attendance.**", "leave-requests.**"]);
    expect(mine.every((r) => r.status === "active" && r.level === "read")).toBe(true);

    // ONE act: the two per-rule creates AND the summary all carry the copy's correlation id - which is what
    // lets the feed's act view replay the copy as the single change it was.
    const written = (await deps.db.select().from(schema.auditLog)).filter((r) => !before.some((b) => b.uuid === r.uuid));
    expect(written).toHaveLength(3);
    expect(new Set(written.map((r) => r.correlationId))).toEqual(new Set([res.correlation_id]));
    const summary = written.find((r) => r.action === "access-rule.clone")!;
    const meta = JSON.parse(summary.meta!) as { from_subject: string; subject: string; added: number; sentence: string };
    expect(meta.from_subject).toBe("employee");
    expect(meta.subject).toBe("manager");
    expect(meta.added).toBe(2);
    expect(meta.sentence).toContain("copied from the employee role");
    // The rules authored BEFORE the copy are not part of it.
    expect(before.every((r) => r.correlationId !== res.correlation_id)).toBe(true);
  });

  it("sends ONE notification for the copy, not one per rule", async () => {
    await createAccessRule(deps, ana(), grantEmployeeRead());
    await createAccessRule(deps, ana(), grantEmployeeRead({ collection: "attendance" }));
    await cloneAccessRules(deps, ana(), { from: employee(), to: manager() });
    const notes = (await deps.db.select().from(schema.notifications)).filter((n) => n.recipientId === ids.carlaEmp);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toContain("2 permissions");
  });

  it("is safe to run twice: what the target already holds is skipped, not failed", async () => {
    await createAccessRule(deps, ana(), grantEmployeeRead());
    await cloneAccessRules(deps, ana(), { from: employee(), to: manager() });
    const again = await cloneAccessRules(deps, ana(), { from: employee(), to: manager() });
    expect(again).toMatchObject({ added: 0, skipped: 1, failed: 0 });
  });

  it("copies nothing that is still awaiting approval", async () => {
    await setApproval(true);
    await createAccessRule(deps, ana(), grantEmployeeRead()); // lands `pending`
    const res = await cloneAccessRules(deps, ana(), { from: employee(), to: manager() });
    expect(res).toMatchObject({ added: 0, source_total: 0 });
  });

  it("refuses the role the caller is using, and a copy onto itself", async () => {
    await expect(cloneAccessRules(deps, ana(), { from: employee(), to: { subject_kind: "role", subject: "hr_admin" } })).rejects.toThrow(/role you are using/);
    await expect(cloneAccessRules(deps, ana(), { from: employee(), to: employee() })).rejects.toThrow(/different subjects/);
    await expect(cloneAccessRules(deps, ana(), { from: employee(), to: { subject_kind: "role", subject: "nope" } })).rejects.toThrow(/target role not found/);
  });
});
