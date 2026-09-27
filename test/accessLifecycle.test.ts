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
import { loadRoleGrant, loadRoleGrantUncached, loadRoleGuards } from "../src/lib/policyLoad";
import { DEFAULT_POLICY } from "../bootstrap/authz/policy";
import { clearCachePrefix } from "../src/lib/cache";
import { invalidateCodeCache } from "../src/lib/authzResolve";
import { guardAllows } from "../src/domain/ruleCondition";

// Rule LIFECYCLE, against real D1: a rule only decides while it is active and unexpired. Two features ride
// that one predicate (lib/policyLoad `isLive`), and both are the kind of thing that silently fails open or
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
  // The grant is `Grant`'s real shape (`levels`/`allow`), not a hand-rolled one: `{denies, customs}` named
  // fields `Grant` has never had, and the `as never` cast is what let that compile. `isSuperGrant` reads
  // `g.allow`, so every call through this fixture threw "Cannot read properties of undefined (reading
  // 'includes')" instead of reaching the self-widening guard it was written to prove.
  //
  // And it CARRIES AUTHORITY. An access admin may only hand out what they hold themselves (domain/access.ts
  // ruleWithinAuthority), so an empty grant can grant nothing at all. These two hold admin over exactly the
  // collections this suite writes rules for - delegated, NOT super (no `**`), which is what the self-widening
  // cases below depend on.
  ({ uuid, email, role: "hr_admin", roles: ["hr_admin"], status: "active", employeeId, employeeCode: null, name: email, grant: DELEGATED, policy: DEFAULT_POLICY }) as AppUser;
const DELEGATED_OVER = ["attendance", "compensation", "employees", "expenses", "holidays", "leave-requests"];
const DELEGATED = {
  levels: Object.fromEntries(DELEGATED_OVER.flatMap((c) => [[c, "admin"], [`${c}.**`, "admin"]])),
  allow: DELEGATED_OVER.map((c) => `${c}.**`),
} as AppUser["grant"];
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
// The CACHED loader - the one middleware/auth.ts actually calls on every request.
const cachedRoleCanRead = async (d: Deps = deps) => Boolean((await loadRoleGrant(d, "employee")).levels?.["leave-requests.**"]);

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

  it("lapses on the CACHED path too, rather than at the end of the cache entry's own TTL", async () => {
    const expiresAt = +deps.clock.now() + 60_000;
    await createAccessRule(deps, ana(), grantEmployeeRead({ expire_time: new Date(expiresAt).toISOString() }));
    // Warm the entry while the rule is still live (the create busts it, so this is the fill).
    expect(await cachedRoleCanRead()).toBe(true);

    // Read it again PAST the expiry with the entry still warm and holding the very same rows. The verdict is
    // not a property of the rows - it is the rows read against the CALLER'S clock. Tested inside the cached
    // query (as it used to be), "still live" was frozen into the entry, so the grant went on deciding for up
    // to the TTL after its own expiry: the one thing an expiring grant exists not to do.
    const later: Deps = { ...deps, clock: { now: () => new Date(expiresAt + 1000) } };
    expect(await cachedRoleCanRead(later)).toBe(false);

    // And the entry really was reused rather than quietly refilled - back on this clock it decides again.
    expect(await cachedRoleCanRead()).toBe(true);
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
    // The refusal now NAMES the role, because it covers every role the caller holds rather than only the one
    // on their profile - "the role you are using" was ambiguous the moment there could be more than one.
    await expect(cloneAccessRules(deps, ana(), { from: employee(), to: { subject_kind: "role", subject: "hr_admin" } })).rejects.toThrow(/"hr_admin".*you hold that role/);
    await expect(cloneAccessRules(deps, ana(), { from: employee(), to: employee() })).rejects.toThrow(/different subjects/);
    await expect(cloneAccessRules(deps, ana(), { from: employee(), to: { subject_kind: "role", subject: "nope" } })).rejects.toThrow(/target role not found/);
  });
});

// NOBODY AUTHORS THEIR OWN AUTHORITY.
//
// middleware/auth.ts builds a caller's grant from THREE subjects (lib/policyLoad: own user rows over
// `mergeGrants(everyone rows, own-role rows)`), and only the role one was guarded. Both of the other two are
// a one-request self-grant for a delegated ACL admin: `compensation` at admin from the next request onward.
// Asserted at the service, since that is the single door - the collection route, the clone and the four-eyes
// queue all go through it.
describe("a rule author cannot widen themselves", () => {
  const superAna = () => ({ ...ana(), grant: { levels: { "**": "admin" }, allow: ["**"] } }) as unknown as AppUser;
  const selfRule = (extra: Record<string, unknown> = {}) => ({ subject_kind: "user", subject: `users/${ids.ana}`, collection: "compensation", scope: "all", level: "admin", ...extra });

  it("refuses a user rule the author wrote for their own user", async () => {
    await expect(createAccessRule(deps, ana(), selfRule())).rejects.toThrow(/rules for your own user/);
    expect(await deps.db.select().from(schema.accessRules)).toHaveLength(0);
  });

  it("still allows a user rule for somebody else", async () => {
    const rule = await createAccessRule(deps, ana(), { ...selfRule(), subject: `users/${ids.bo}` });
    expect(rule.subject).toBe(ids.bo);
  });

  it("refuses an `everyone` rule from a non-super author, because `everyone` includes them", async () => {
    await expect(createAccessRule(deps, ana(), { ...selfRule(), subject_kind: "role", subject: "everyone" })).rejects.toThrow(/'everyone' role includes you/);
  });

  it("lets super author `everyone` - it cannot widen a caller who already holds `**`", async () => {
    const rule = await createAccessRule(deps, superAna(), { ...selfRule(), subject_kind: "role", subject: "everyone", level: "read" });
    expect(rule.subject).toBe("everyone");
  });

  it("holds on the clone too, which is the same widening forty rules at a time", async () => {
    const from = { subject_kind: "role", subject: "employee" };
    await expect(cloneAccessRules(deps, ana(), { from, to: { subject_kind: "user", subject: `users/${ids.ana}` } })).rejects.toThrow(/rules for your own user/);
    await expect(cloneAccessRules(deps, ana(), { from, to: { subject_kind: "role", subject: "everyone" } })).rejects.toThrow(/'everyone' role includes you/);
  });

  // THE FOURTH SUBJECT, and the one the block above did not know about. `loadAuthority` merges a grant for
  // EVERY role the caller holds - the primary plus each secondary from `user_roles` - so a rule written for a
  // role somebody holds as their SECOND one feeds their grant exactly as their primary's does. The guard
  // compared against `actor.role`, which is only the first, so this was a one-request self-grant for any ACL
  // admin who also held a second role: `payroll_admin` gets `compensation` at admin, and they are using it on
  // the next request.
  describe("including a role they hold as a SECOND role", () => {
    // Ana administers access as `hr_admin` and also holds `payroll_admin`. Both are in her grant.
    const anaTwoRoles = () => ({ ...ana(), roles: ["hr_admin", "payroll_admin"] }) as AppUser;
    const payrollRule = (extra: Record<string, unknown> = {}) =>
      ({ subject_kind: "role", subject: "payroll_admin", collection: "compensation", scope: "all", level: "admin", ...extra });

    beforeEach(async () => {
      await deps.db.insert(schema.roles).values({ name: "payroll_admin", label: "Payroll" }).onConflictDoNothing();
    });

    it("refuses a rule written for it", async () => {
      await expect(createAccessRule(deps, anaTwoRoles(), payrollRule())).rejects.toThrow(/you hold that role/);
      expect(await deps.db.select().from(schema.accessRules)).toHaveLength(0);
    });

    it("still allows a rule for a role they do NOT hold", async () => {
      const rule = await createAccessRule(deps, anaTwoRoles(), { ...payrollRule(), subject: "employee" });
      expect(rule.subject).toBe("employee");
    });

    it("refuses the clone that writes the same widening in bulk", async () => {
      await expect(cloneAccessRules(deps, anaTwoRoles(), {
        from: { subject_kind: "role", subject: "employee" },
        to: { subject_kind: "role", subject: "payroll_admin" },
      })).rejects.toThrow(/you hold that role/);
    });

    it("refuses DELETING one of its rules - removing a deny widens just as adding an allow does", async () => {
      const deny = await createAccessRule(deps, bo(), { ...payrollRule(), effect: "deny", level: undefined });
      await expect(deleteAccessRule(deps, anaTwoRoles(), deny.uuid)).rejects.toThrow(/you hold that role/);
      expect(await deps.db.select().from(schema.accessRules)).toHaveLength(1);
    });

    it("refuses APPROVING one of its rules, however it got into the queue", async () => {
      await setApproval(true);
      // Written by somebody else, so the four-eyes rule about the requester is satisfied and this is the only
      // thing standing between Ana and a grant to a role she is using.
      const pending = await createAccessRule(deps, bo(), payrollRule());
      expect(pending.status).toBe("pending");
      await expect(decideAccessRule(deps, anaTwoRoles(), pending.uuid, "approve")).rejects.toThrow(/you hold that role/);
    });
  });
});

// THE GUARD ROUND-TRIP: authored -> stored -> loaded -> enforced.
//
// WHY THIS EXISTS. `guardAllows` is unit-tested against hand-built guards, and those tests all passed while the
// network fence was completely INERT in the running app: `from_ip` had been added to the schema, the validator
// and the writer, but never to `RULE_COLUMNS` in lib/policyLoad.ts - so the loader never selected it and every
// fence silently evaporated between the row and the decision. Nothing caught it. It typechecks (`CompiledRule`
// declares the guard columns optional, which is what lets a row that lacks them compile), the unit tests
// construct the guard directly rather than loading one, and a fence that does not fence looks exactly like a
// fence that was never hit.
//
// So this asserts the WIRING rather than the predicate: author a real rule through the real service, load it
// back through the loader middleware/auth.ts calls, and check the guard survived the trip.
describe("per-rule guards survive the trip from the rules table to the decision", () => {
  const capped = (extra: Record<string, unknown>) => ({
    subject_kind: "role",
    subject: "employee",
    collection: "expenses",
    scope: "all",
    verb: "approve",
    ...extra,
  });
  // The CACHED loader - the one middleware/auth.ts actually calls, so this covers the real path.
  const guardsFor = async (pattern: string) => (await loadRoleGuards(deps, "employee")).get(pattern) ?? [];

  it("carries a threshold through to the loaded guard", async () => {
    await createAccessRule(deps, ana(), capped({ condition: { field: "amount", op: "lte", value: 50_000 } }));
    const [g] = await guardsFor("expenses.**.approve");
    expect(g?.condition, "the loader must SELECT `condition`, not just the writer store it").toEqual({ field: "amount", op: "lte", value: 50_000 });
    expect(guardAllows(new Map([["expenses.**.approve", [g!]]]), "expenses.**.approve", { row: { amount: 500 } })).toBe(true);
    expect(guardAllows(new Map([["expenses.**.approve", [g!]]]), "expenses.**.approve", { row: { amount: 500_000 } })).toBe(false);
  });

  it("carries a network fence through - the one that shipped inert", async () => {
    await createAccessRule(deps, ana(), capped({ from_ip: "198.51.100.0/24" }));
    const [g] = await guardsFor("expenses.**.approve");
    expect(g?.fromIp, "the loader must SELECT `from_ip`").toBeTruthy();
    expect(guardAllows(new Map([["expenses.**.approve", [g!]]]), "expenses.**.approve", { ip: "198.51.100.7" })).toBe(true);
    expect(guardAllows(new Map([["expenses.**.approve", [g!]]]), "expenses.**.approve", { ip: "203.0.113.9" })).toBe(false);
  });

  it("carries a time window through", async () => {
    await createAccessRule(deps, ana(), capped({ window: { field: "incurred_on", within_days: 30 } }));
    const [g] = await guardsFor("expenses.**.approve");
    expect(g?.window, "the loader must SELECT `window`").toEqual({ field: "incurred_on", within_days: 30 });
  });

  // An ordinary rule must come back with nothing attached, or every unguarded grant in the app would start
  // being measured against a guard it never carried.
  it("leaves an ordinary rule unguarded", async () => {
    await createAccessRule(deps, ana(), capped({}));
    const [g] = await guardsFor("expenses.**.approve");
    expect(g).toEqual({ condition: null, fromIp: null, window: null });
  });
});

// A delegated access admin hands out only what they hold (domain/access.ts ruleWithinAuthority) - otherwise
// delegating the ACL is delegating super, one step removed.
describe("a rule author cannot grant past their own authority", () => {
  it("refuses a rule on a collection the author holds nothing on, and allows a deny there", async () => {
    await expect(createAccessRule(deps, ana(), grantEmployeeRead({ collection: "payslips" }))).rejects.toThrow(/only grant access you hold/);
    expect(await deps.db.select().from(schema.accessRules)).toHaveLength(0);
    // A deny only subtracts, so it is inside anyone's authority.
    await expect(createAccessRule(deps, ana(), { subject_kind: "role", subject: "employee", collection: "payslips", scope: "all", effect: "deny" })).resolves.toBeTruthy();
  });

  it("refuses APPROVING a pending grant the approver could not have written", async () => {
    await setApproval(true);
    const pending = await createAccessRule(deps, ana(), grantEmployeeRead());
    const narrowBo = { ...bo(), grant: { levels: {}, allow: ["access-rules.**"] } } as unknown as AppUser;
    await expect(decideAccessRule(deps, narrowBo, pending.uuid, "approve")).rejects.toThrow(/only grant access you hold/);
  });
});
