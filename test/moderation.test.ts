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
import type { TextModel } from "../src/ports";
import { BUDGET } from "../src/domain/aiPolicy";
import { excerptOf, parseVerdict } from "../src/domain/moderation";
import { drainModeration, listModerationQueue, decideModeration } from "../src/services/moderation";

// Moderation: what the model is allowed to say, and what a person does with it.
//
// The property worth the most here is that NOTHING THIS FILE EXERCISES CAN HIDE A POST. The drain writes
// flags; only `decideModeration` touches content, and it takes the action as an argument. So the tests below
// check both halves separately: what the scan records, and what a decision does to the wall.
//
// The second property is cost. A generation-class model runs unattended on a five-minute tick, so a post that
// has not changed must never be paid for twice - which is what the scan bookkeeping is for, and what the
// "does not re-ask" test pins.

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
const b = env as unknown as Bindings;

/** A model that answers with whatever the test scripts, and counts how often it was asked. */
function scriptedModel(answer: () => string): TextModel & { calls: number } {
  const model = {
    calls: 0,
    async embed(texts: string[]) { return texts.map(() => new Float32Array([0.1, 0.2, 0.3])); },
    async generate() { model.calls += 1; return answer(); },
  };
  return model as unknown as TextModel & { calls: number };
}

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
});

// `auditLog` is cleared with the rest: a decision writes a row against the post, and an assertion about that
// row is only meaningful if the previous test's rows are not still sitting there.
const TABLES = [schema.aiSuggestions, schema.moderationScans, schema.aiUsage, schema.aiCache, schema.announcements, schema.suggestions, schema.notifications, schema.auditLog, schema.users, schema.employees, schema.roles, schema.settings];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  // Every test below is about what happens AFTER an org decided its wall may be read by a model. The "off"
  // behaviour has its own tests, which clear this.
  await deps.db.insert(schema.settings).values({ key: "ai", value: JSON.stringify({ features: { moderation: true } }) });
  deps.ai = undefined;
});

async function seedPerson(first: string): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({
    uuid: employeeId, code: `e-${first.toLowerCase()}`, firstName: first, lastName: "Test",
    workEmail: `${first.toLowerCase()}@test.example`, status: "active",
  });
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${first.toLowerCase()}@test.example`, role: "employee", employeeId });
  return { uuid, email: `${first.toLowerCase()}@test.example`, role: "employee", status: "active", employeeId, employeeCode: `e-${first.toLowerCase()}`, name: first } as AppUser;
}

async function seedAnnouncement(author: AppUser, over: Partial<typeof schema.announcements.$inferInsert> = {}): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.announcements).values({
    uuid, code: `a-${genId().slice(0, 6)}`, title: "Well done team", body: "Great quarter everyone.",
    authorEmployeeId: author.employeeId!, published: true, disabled: false, ...over,
  });
  return uuid;
}

async function seedSuggestion(submitter: AppUser, over: Partial<typeof schema.suggestions.$inferInsert> = {}): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.suggestions).values({
    uuid, code: `s-${genId().slice(0, 6)}`, title: "Better coffee", body: "The machine is broken again.",
    submitterId: submitter.employeeId!, ...over,
  });
  return uuid;
}

const flagFor = (collection: string, recordId: string) =>
  deps.db.select().from(schema.aiSuggestions).where(and(
    eq(schema.aiSuggestions.hostCollection, collection),
    eq(schema.aiSuggestions.hostRecordId, recordId),
    eq(schema.aiSuggestions.feature, "moderation"),
  )).get();

// ---------------------------------------------------------------------------------------------------------

describe("reading the guard model's answer", () => {
  it("accepts the two documented shapes and nothing else", () => {
    expect(parseVerdict("safe")).toEqual({ safe: true });
    expect(parseVerdict("SAFE\n")).toEqual({ safe: true });
    expect(parseVerdict("unsafe\nS5,S10")).toEqual({ safe: false, hazards: ["S10", "S5"] });
    // Deduplicated and ordered, so two scans of the same text write the same row rather than churning it.
    expect(parseVerdict("unsafe\nS10, S10 ,S5")).toEqual({ safe: false, hazards: ["S10", "S5"] });
  });

  it("refuses an objection it cannot give a reason for", () => {
    // A flag whose reason column is empty is a queue item nobody can act on, so "unsafe" with no parseable
    // code is discarded rather than shown. "The model said so" is not a reason a person can weigh.
    expect(parseVerdict("unsafe")).toBeNull();
    expect(parseVerdict("unsafe\nnot a code")).toBeNull();
  });

  it("refuses an answer that is not a verdict", () => {
    // A model that starts explaining itself, apologising, or answering the post instead of judging it.
    expect(parseVerdict("I'm sorry, I can't help with that.")).toBeNull();
    expect(parseVerdict("This post seems fine to me!")).toBeNull();
    expect(parseVerdict("")).toBeNull();
  });

  it("marks a truncated excerpt as truncated", () => {
    expect(excerptOf("short")).toBe("short");
    expect(excerptOf("x".repeat(500))).toMatch(/\.\.\.$/);
    expect(excerptOf("x".repeat(500)).length).toBeLessThanOrEqual(404);
  });
});

describe("the scan", () => {
  it("flags an objectionable post and leaves it on the wall", async () => {
    const author = await seedPerson("Ana");
    const id = await seedAnnouncement(author);
    deps.ai = scriptedModel(() => "unsafe\nS10");

    const out = await drainModeration(deps);
    expect(out.flagged).toBe(1);

    const flag = await flagFor("announcements", id);
    expect(flag?.state).toBe("pending");
    expect(JSON.parse(flag!.payloadJson).hazards).toEqual(["S10"]);

    // THE POST IS UNTOUCHED. This is the whole design: the model's only power is to add a queue item.
    const post = await deps.db.select().from(schema.announcements).where(eq(schema.announcements.uuid, id)).get();
    expect(post?.disabled).toBe(false);
    expect(post?.deleteTime).toBeNull();
  });

  it("writes nothing when the org has not switched it on", async () => {
    const author = await seedPerson("Ana");
    await seedAnnouncement(author);
    await deps.db.update(schema.settings).set({ value: JSON.stringify({ features: { moderation: false } }) }).where(eq(schema.settings.key, "ai"));
    const model = scriptedModel(() => "unsafe\nS10");
    deps.ai = model;

    expect(await drainModeration(deps)).toMatchObject({ scanned: 0, flagged: 0 });
    // Not merely "no flag": the text never reached a model at all, which is what the opt-in promises.
    expect(model.calls).toBe(0);
  });

  it("writes nothing on a deployment with no model bound", async () => {
    const author = await seedPerson("Ana");
    await seedAnnouncement(author);
    expect(await drainModeration(deps)).toMatchObject({ scanned: 0, flagged: 0 });
  });

  it("does not ask twice about text that has not changed", async () => {
    const author = await seedPerson("Ana");
    await seedAnnouncement(author);
    const model = scriptedModel(() => "safe");
    deps.ai = model;

    await drainModeration(deps);
    expect(model.calls).toBe(1);
    // The second tick finds the same hash and spends nothing. Without the scan bookkeeping this would be a
    // generation call per post per five minutes, forever.
    await drainModeration(deps);
    expect(model.calls).toBe(1);
  });

  it("asks again when the post is edited, and retires a flag the edit resolved", async () => {
    const author = await seedPerson("Ana");
    const id = await seedAnnouncement(author);
    let answer = "unsafe\nS10";
    deps.ai = scriptedModel(() => answer);

    await drainModeration(deps);
    expect((await flagFor("announcements", id))?.state).toBe("pending");

    answer = "safe";
    await deps.db.update(schema.announcements).set({ body: "Rewritten, politely." }).where(eq(schema.announcements.uuid, id));
    await drainModeration(deps);

    // Superseded, not decided: nobody looked at it, and recording it as dismissed would credit a person with
    // a judgement they never made.
    expect((await flagFor("announcements", id))?.state).toBe("superseded");
  });

  it("ignores posts that are not on a wall", async () => {
    const author = await seedPerson("Ana");
    await seedAnnouncement(author, { published: false });
    await seedAnnouncement(author, { disabled: true });
    await seedSuggestion(author, { deleteTime: new Date() });
    const model = scriptedModel(() => "unsafe\nS10");
    deps.ai = model;

    expect(await drainModeration(deps)).toMatchObject({ scanned: 0 });
    // Scanning an invisible post would spend a generation call on text nobody can read, and would put a flag
    // on the queue about a post that is already gone.
    expect(model.calls).toBe(0);
  });

  it("stops at the per-tick budget", async () => {
    const author = await seedPerson("Ana");
    for (let i = 0; i < BUDGET.moderationsPerDrain + 3; i += 1) {
      await seedAnnouncement(author, { title: `Post ${i}` });
    }
    const model = scriptedModel(() => "safe");
    deps.ai = model;

    await drainModeration(deps);
    expect(model.calls).toBe(BUDGET.moderationsPerDrain);
  });

  it("records an unreadable answer as scanned rather than retrying it forever", async () => {
    const author = await seedPerson("Ana");
    const id = await seedAnnouncement(author);
    const model = scriptedModel(() => "I think this post is lovely.");
    deps.ai = model;

    await drainModeration(deps);
    expect(await flagFor("announcements", id)).toBeUndefined();
    // Stamped anyway: a model that reliably answers in the wrong shape would otherwise pin the same posts at
    // the front of every window and starve the rest of the wall.
    const scan = await deps.db.select().from(schema.moderationScans).where(eq(schema.moderationScans.recordId, id)).get();
    expect(scan?.flagged).toBe(false);
  });
});

describe("the queue", () => {
  it("never names the author of an anonymous suggestion", async () => {
    const submitter = await seedPerson("Ana");
    await seedSuggestion(submitter, { anonymous: true });
    deps.ai = scriptedModel(() => "unsafe\nS5");
    await drainModeration(deps);

    const [row] = await listModerationQueue(deps);
    expect(row?.collection).toBe("suggestions");
    // The wall's promise is to the reader as much as the submitter. A moderation queue that resolved the name
    // would make "anonymous" mean "anonymous unless somebody complains about you".
    expect(row?.author).toBeNull();
  });

  it("names the author of a post that was never anonymous", async () => {
    const author = await seedPerson("Ana");
    await seedAnnouncement(author);
    deps.ai = scriptedModel(() => "unsafe\nS10");
    await drainModeration(deps);

    const [row] = await listModerationQueue(deps);
    expect(row?.author).toBe(`employees/${author.employeeId}`);
  });

  it("says when the post no longer reads the way the model read it", async () => {
    const author = await seedPerson("Ana");
    const id = await seedAnnouncement(author);
    deps.ai = scriptedModel(() => "unsafe\nS10");
    await drainModeration(deps);
    expect((await listModerationQueue(deps))[0]?.edited_since_flag).toBe(false);

    await deps.db.update(schema.announcements).set({ body: "Something else entirely." }).where(eq(schema.announcements.uuid, id));
    const [row] = await listModerationQueue(deps);
    // The quote stays as the model read it, and the moderator is told it is out of date, rather than being
    // shown a quote that silently no longer matches the wall.
    expect(row?.edited_since_flag).toBe(true);
    expect(row?.excerpt).toContain("Great quarter");
  });

  it("drops a flag whose post has gone", async () => {
    const author = await seedPerson("Ana");
    const id = await seedSuggestion(author);
    deps.ai = scriptedModel(() => "unsafe\nS5");
    await drainModeration(deps);
    expect(await listModerationQueue(deps)).toHaveLength(1);

    await deps.db.update(schema.suggestions).set({ deleteTime: new Date() }).where(eq(schema.suggestions.uuid, id));
    expect(await listModerationQueue(deps)).toHaveLength(0);
  });
});

describe("deciding", () => {
  it("hiding withdraws an announcement, tells its author, and is not a delete", async () => {
    const author = await seedPerson("Ana");
    const mod = await seedPerson("Mo");
    const id = await seedAnnouncement(author);
    deps.ai = scriptedModel(() => "unsafe\nS10");
    await drainModeration(deps);

    await decideModeration(deps, mod, `announcements/${id}`, "hide");

    const post = await deps.db.select().from(schema.announcements).where(eq(schema.announcements.uuid, id)).get();
    expect(post?.disabled).toBe(true);
    // Recoverable: hiding is somebody's judgement, and an unrecoverable one is a different authority.
    expect(post?.deleteTime).toBeNull();
    expect((await flagFor("announcements", id))?.state).toBe("accepted");
    expect((await flagFor("announcements", id))?.decidedBy).toBe(mod.uuid);

    const notes = await deps.db.select().from(schema.notifications);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.subject).toBe(`announcements/${id}`);
  });

  it("hiding soft-deletes a suggestion", async () => {
    const author = await seedPerson("Ana");
    const mod = await seedPerson("Mo");
    const id = await seedSuggestion(author);
    deps.ai = scriptedModel(() => "unsafe\nS5");
    await drainModeration(deps);

    await decideModeration(deps, mod, `suggestions/${id}`, "hide");
    const row = await deps.db.select().from(schema.suggestions).where(eq(schema.suggestions.uuid, id)).get();
    expect(row?.deleteTime).not.toBeNull();
  });

  it("dismissing closes the flag and leaves the post exactly where it was", async () => {
    const author = await seedPerson("Ana");
    const mod = await seedPerson("Mo");
    const id = await seedAnnouncement(author);
    deps.ai = scriptedModel(() => "unsafe\nS10");
    await drainModeration(deps);

    await decideModeration(deps, mod, `announcements/${id}`, "dismiss");

    const post = await deps.db.select().from(schema.announcements).where(eq(schema.announcements.uuid, id)).get();
    expect(post?.disabled).toBe(false);
    expect((await flagFor("announcements", id))?.state).toBe("rejected");
    // Nobody is told their post was fine: the post never moved, so there is nothing to tell them about.
    expect(await deps.db.select().from(schema.notifications)).toHaveLength(0);
  });

  it("records the decision AGAINST THE POST, so the record's own trail explains why it went", async () => {
    // The regression this pins. The route is `POST /v1/moderation:decide` with the record in the BODY, and
    // the authz write-backstop derives its entity from the PATH - so before this was audited inline, the
    // trail held a row with no entity id: somebody used the moderation queue, and no answer to which post
    // they hid. The post's own activity said nothing about the one event in its life worth explaining.
    const author = await seedPerson("Ana");
    const mod = await seedPerson("Mo");
    const id = await seedAnnouncement(author);
    deps.ai = scriptedModel(() => "unsafe\nS10");
    await drainModeration(deps);

    await decideModeration(deps, mod, `announcements/${id}`, "hide");

    const rows = await deps.db.select().from(schema.auditLog);
    const entry = rows.find((r) => r.entity === "announcements" && r.entityId === id);
    expect(entry, "the decision must be anchored on the post").toBeTruthy();
    expect(entry!.action).toBe("announcement.moderate.hide");
    // `audit_log.actor_id` is the EMPLOYEE uuid, not the user uuid - the trail names the person, and a
    // principal with no employee record leaves it null.
    expect(entry!.actorId).toBe(mod.employeeId);

    // The hazard the model named is on the row; the post's TEXT is not. The excerpt the moderator judged is
    // already on the flag, and copying content into the audit trail makes the trail a second store of it.
    const meta = JSON.parse(entry!.meta ?? "{}") as { hazards?: string[] };
    expect(meta.hazards).toEqual(["S10"]);
    expect(JSON.stringify(entry)).not.toContain("Great quarter everyone.");
  });

  it("records a dismissal too, because deciding to leave a post up is also a decision", async () => {
    const author = await seedPerson("Ana");
    const mod = await seedPerson("Mo");
    const id = await seedAnnouncement(author);
    deps.ai = scriptedModel(() => "unsafe\nS10");
    await drainModeration(deps);

    await decideModeration(deps, mod, `announcements/${id}`, "dismiss");

    const rows = await deps.db.select().from(schema.auditLog);
    const entry = rows.find((r) => r.entity === "announcements" && r.entityId === id);
    expect(entry?.action).toBe("announcement.moderate.dismiss");
  });

  it("refuses a second decision on the same flag", async () => {
    const author = await seedPerson("Ana");
    const mod = await seedPerson("Mo");
    const id = await seedAnnouncement(author);
    deps.ai = scriptedModel(() => "unsafe\nS10");
    await drainModeration(deps);

    await decideModeration(deps, mod, `announcements/${id}`, "dismiss");
    await expect(decideModeration(deps, mod, `announcements/${id}`, "hide")).rejects.toThrow(/already been decided/);
  });

  it("refuses a collection that is not moderated", async () => {
    const mod = await seedPerson("Mo");
    await expect(decideModeration(deps, mod, `tickets/${genId()}`, "hide")).rejects.toThrow(/not a moderated collection/);
  });
});
