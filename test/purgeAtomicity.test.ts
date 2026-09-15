/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { AppUser, Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { purgeRow, type PurgeCascade } from "../src/services/softDelete";

// A HARD PURGE IS ALL-OR-NOTHING.
//
// The teardown deletes the children a `purgeCascade` names and then the row itself, and the last statement is
// the one that can fail: a foreign key nobody declared refuses the DELETE. Run as separate statements, the
// children were committed by then and no error path put them back, so the caller got 409 "still referenced by
// other records" - which reads as "nothing was deleted" - over a record whose children had just been
// destroyed for good. Real, and deterministic rather than a race: `goals` declared five of its seven
// references, so force-purging a goal that blocked another goal or that a project delivered wiped its
// comments, watchers and contributors every single time and then refused.
//
// One D1 batch is one transaction, so the failing DELETE now rolls the whole teardown back. This suite runs
// the broken case ON PURPOSE - an incomplete cascade handed straight to `purgeRow` - because the app's own
// declarations are complete again (test/purgeCascadeDrift keeps them that way) and the property being pinned
// is what happens when one is not.
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

const CLEAR = [schema.attachments, schema.projects, schema.goalComments, schema.goals, schema.auditLog, schema.accessRules, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of CLEAR) await deps.db.delete(t);
});

async function seedActor(): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: "super_admin", label: "Super" }).onConflictDoNothing();
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({ uuid: employeeId, code: `04-${genId().slice(0, 3)}`, firstName: "Test", lastName: "User", workEmail: `${employeeId}@test.example`, status: "active" });
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${uuid}@test.example`, role: "super_admin", employeeId });
  return { uuid, email: `${uuid}@test.example`, role: "super_admin", status: "active", employeeId, employeeCode: null } as unknown as AppUser;
}

async function seedGoalWithComment(employeeId: string, code = `04-${genId().slice(0, 6)}`): Promise<{ goalId: string; code: string }> {
  const goalId = genId();
  await deps.db.insert(schema.goals).values({ uuid: goalId, code, employeeId, title: "Ship the thing" });
  await deps.db.insert(schema.goalComments).values({ uuid: genId(), goalId, authorId: employeeId, body: "how is this going?" });
  return { goalId, code };
}

// What a HALF-declared cascade looks like: it owns the comments and says nothing about the project pointing
// at the goal. This is the shape the goals declaration actually had.
const INCOMPLETE: PurgeCascade = { remove: [{ table: schema.goalComments, column: schema.goalComments.goalId }] };
const COMPLETE: PurgeCascade = {
  remove: [{ table: schema.goalComments, column: schema.goalComments.goalId }],
  detach: [{ table: schema.projects, column: schema.projects.goalId }],
};

const purge = (actor: AppUser, goalId: string, cascade: PurgeCascade, onPurge?: () => Promise<void>) =>
  purgeRow(deps, actor, schema.goals, "goal", "goals", goalId, undefined, onPurge, cascade);

describe("hard purge: an undeclared reference rolls the whole teardown back", () => {
  it("keeps the children when the row itself cannot go", async () => {
    const actor = await seedActor();
    const { goalId } = await seedGoalWithComment(actor.employeeId!);
    await deps.db.insert(schema.projects).values({ uuid: genId(), code: `p-${genId().slice(0, 5)}`, name: "Migration", goalId });

    await expect(purge(actor, goalId, INCOMPLETE)).rejects.toMatchObject({ httpStatus: 409, type: "/errors/failed-precondition" });

    // The refusal has to mean nothing happened. Before the teardown was batched, the comment was already gone
    // at this point and there was no way to get it back.
    expect(await deps.db.select().from(schema.goalComments).where(eq(schema.goalComments.goalId, goalId))).toHaveLength(1);
    expect(await deps.db.select().from(schema.goals).where(eq(schema.goals.uuid, goalId))).toHaveLength(1);
    // And nothing is audited as purged, because nothing was.
    expect(await deps.db.select().from(schema.auditLog)).toHaveLength(0);
  });

  it("tears the row down completely once every reference is declared", async () => {
    const actor = await seedActor();
    const { goalId } = await seedGoalWithComment(actor.employeeId!);
    const projectId = genId();
    await deps.db.insert(schema.projects).values({ uuid: projectId, code: `p-${genId().slice(0, 5)}`, name: "Migration", goalId });

    await purge(actor, goalId, COMPLETE);

    expect(await deps.db.select().from(schema.goals).where(eq(schema.goals.uuid, goalId))).toHaveLength(0);
    expect(await deps.db.select().from(schema.goalComments).where(eq(schema.goalComments.goalId, goalId))).toHaveLength(0);
    // The project survives with its pointer cleared - it has a life of its own, which is what `detach` means.
    const project = (await deps.db.select().from(schema.projects).where(eq(schema.projects.uuid, projectId)))[0]!;
    expect(project.goalId).toBeNull();
    expect((await deps.db.select().from(schema.auditLog)).map((r) => r.action)).toContain("goal.purge");
  });
});

// The irreversible side effect a purge can carry is deleting the row's stored file (documentService hands
// `purgeRow` an R2 delete). It runs only once the row is actually gone.
describe("hard purge: the stored object is deleted only after the row is", () => {
  it("leaves the file alone when the purge is refused", async () => {
    const actor = await seedActor();
    const { goalId } = await seedGoalWithComment(actor.employeeId!);
    await deps.db.insert(schema.projects).values({ uuid: genId(), code: `p-${genId().slice(0, 5)}`, name: "Migration", goalId });
    let deleted = false;

    await expect(purge(actor, goalId, INCOMPLETE, async () => { deleted = true; })).rejects.toMatchObject({ httpStatus: 409 });

    // Run first (as it used to be), this would be true: the caller keeps a live, listed, downloadable
    // document row whose file no longer exists, with no way back.
    expect(deleted).toBe(false);
  });

  it("deletes the file once the row has gone", async () => {
    const actor = await seedActor();
    const { goalId } = await seedGoalWithComment(actor.employeeId!);
    let deleted = false;
    await purge(actor, goalId, COMPLETE, async () => { deleted = true; });
    expect(deleted).toBe(true);
  });

  it("still completes the purge when deleting the file fails", async () => {
    const actor = await seedActor();
    const { goalId } = await seedGoalWithComment(actor.employeeId!);
    // The row is already gone by then; a storage hiccup must not turn a completed purge into an error and
    // leave the caller thinking the record survived. The object is orphaned, which is reclaimable.
    await purge(actor, goalId, COMPLETE, async () => { throw new Error("R2 is having a day"); });
    expect(await deps.db.select().from(schema.goals).where(eq(schema.goals.uuid, goalId))).toHaveLength(0);
  });
});

// `access_rules` points at an object by its CODE, not by a foreign key, so SQLite never refuses a purge over
// one and no `purgeCascade` entry can name it - the shape of that type is `column = <the purged uuid>`. Nothing
// was removing them, so a rule outlived the object it was written for: dead weight in the ACL surface, and one
// half of the department code-reuse hole (the other half was the allocator, see test/codeSequence).
describe("hard purge: the per-object access rules that named the row go with it", () => {
  const seedRule = async (subject: string, namespace: string, code: string, kind: "exact" | "subtree") => {
    const uuid = genId();
    await deps.db.insert(schema.accessRules).values({
      uuid,
      subject,
      subjectKind: "user",
      namespace,
      pattern: `${namespace}.${code}${kind === "subtree" ? "-*" : ""}.**`,
      scopeKind: kind,
      scopeCode: code,
      matchCode: kind === "exact" ? code : null,
      level: "read",
      effect: "allow",
    });
    return uuid;
  };
  const survives = async (uuid: string) => (await deps.db.select().from(schema.accessRules).where(eq(schema.accessRules.uuid, uuid))).length === 1;

  it("deletes the exact rule pinned to the purged row's own code", async () => {
    const actor = await seedActor();
    const { goalId, code } = await seedGoalWithComment(actor.employeeId!);
    const pinned = await seedRule(actor.uuid, "goals", code, "exact");

    await purge(actor, goalId, COMPLETE);

    expect(await survives(pinned)).toBe(false);
  });

  it("leaves a SUBTREE rule alone - that is a scope an admin declared, not a dangling pin", async () => {
    const actor = await seedActor();
    const { goalId } = await seedGoalWithComment(actor.employeeId!, "04-000001");
    const branch = await seedRule(actor.uuid, "goals", "04", "subtree");

    await purge(actor, goalId, COMPLETE);

    expect(await survives(branch)).toBe(true);
  });

  it("leaves the SAME code alone in another collection's namespace", async () => {
    // A code is only unique WITHIN a table: a flat catalogue's "01" and a top-level department's "01" are the
    // same string and different objects. An unscoped sweep would take somebody else's grant with it.
    const actor = await seedActor();
    const { goalId, code } = await seedGoalWithComment(actor.employeeId!);
    const elsewhere = await seedRule(actor.uuid, "employees", code, "exact");

    await purge(actor, goalId, COMPLETE);

    expect(await survives(elsewhere)).toBe(true);
  });

  it("keeps the rule when the purge itself is refused", async () => {
    const actor = await seedActor();
    const { goalId, code } = await seedGoalWithComment(actor.employeeId!);
    await deps.db.insert(schema.projects).values({ uuid: genId(), code: `p-${genId().slice(0, 5)}`, name: "Migration", goalId });
    const pinned = await seedRule(actor.uuid, "goals", code, "exact");

    await expect(purge(actor, goalId, INCOMPLETE)).rejects.toMatchObject({ httpStatus: 409 });

    // The sweep rides the same batch as the teardown, so a refusal takes it back with everything else - the
    // row is still there and so is the rule that governs it.
    expect(await survives(pinned)).toBe(true);
  });
});

// THE OTHER FK-LESS POINTER, and it had no sweeper at all.
//
// `purgeRow` takes an `onPurge` hook documented for exactly this ("runs side effects like deleting an R2
// object"), and services/crud.ts passes `undefined` at the only place a factory collection's purge is built -
// so nothing ever called it, and there is no nightly sweeper either. `attachments.object_id` carries no
// foreign key, so SQLite never refused the purge over an attachment and test/purgeCascadeDrift (which holds
// every declaration against the schema's own foreign keys) could not see the pointer either.
//
// What survived a `DELETE /v1/candidates/<id>?force` was the encrypted object in R2, forever, AND the
// `attachments` row naming it - and that row carries `file_name`, which for a resume is routinely the
// person's name. Seven soft-deletable collections write into this one table, and `?force` is the operation
// reached for to honour an erasure request, which made it the one operation that kept the document.
//
// The sweep is generic on `(collection, object_id)` - purgeRow holds both halves - so the parent used here is
// simply whatever this suite already seeds.
describe("a hard purge takes the record's attachments with it", () => {
  const attachmentsOf = (objectId: string) =>
    deps.db.select().from(schema.attachments).where(eq(schema.attachments.objectId, objectId));

  async function attach(objectId: string, slot: string, fileName: string) {
    const uuid = genId();
    const r2Key = `attachments/goals/${objectId}/${uuid}`;
    await deps.docs.put(r2Key, new TextEncoder().encode("the bytes"), "application/pdf");
    await deps.db.insert(schema.attachments).values({ uuid, collection: "goals", objectId, slot, r2Key, fileName, contentType: "application/pdf", sizeBytes: 9 });
    return r2Key;
  }

  it("deletes the metadata row and the stored object, for every slot", async () => {
    const actor = await seedActor();
    const { goalId } = await seedGoalWithComment(actor.employeeId!);
    const receipt = await attach(goalId, "receipt", "Priya Sharma - resume.pdf");
    const proof = await attach(goalId, "proof", "rent-receipt.pdf");
    expect(await attachmentsOf(goalId)).toHaveLength(2);

    await purge(actor, goalId, COMPLETE);

    expect(await attachmentsOf(goalId)).toHaveLength(0);
    expect(await deps.docs.get(receipt)).toBeNull();
    expect(await deps.docs.get(proof)).toBeNull();
  });

  it("leaves another record's attachments alone", async () => {
    const actor = await seedActor();
    const { goalId } = await seedGoalWithComment(actor.employeeId!);
    const other = await seedGoalWithComment(actor.employeeId!);
    await attach(goalId, "receipt", "mine.pdf");
    const keep = await attach(other.goalId, "receipt", "theirs.pdf");

    await purge(actor, goalId, COMPLETE);

    expect(await attachmentsOf(other.goalId)).toHaveLength(1);
    expect(await deps.docs.get(keep)).not.toBeNull();
  });

  it("keeps both when the purge itself is refused", async () => {
    // The metadata rows ride the same batch as the teardown, and the R2 deletes run only after it commits -
    // the order purgeRow argues for, so a refusal leaves a live row whose file still exists rather than a
    // record pointing at bytes that are gone.
    const actor = await seedActor();
    const { goalId } = await seedGoalWithComment(actor.employeeId!);
    await deps.db.insert(schema.projects).values({ uuid: genId(), code: `p-${genId().slice(0, 5)}`, name: "Migration", goalId });
    const key = await attach(goalId, "receipt", "still-here.pdf");

    await expect(purge(actor, goalId, INCOMPLETE)).rejects.toMatchObject({ httpStatus: 409 });

    expect(await attachmentsOf(goalId)).toHaveLength(1);
    expect(await deps.docs.get(key)).not.toBeNull();
  });
});
