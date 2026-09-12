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
import { createReviewCycle, updateReviewCycle, launchReviewCycle, deleteReviewCycle } from "../src/services/reviewCycles";
import { listReviews, submitSelf, submitManager, acknowledgeReview, assignReviewer, nudgeReview } from "../src/services/reviews";
import { competenciesForCycle } from "../src/domain/performance";
import { nominateFeedback, suggestFeedback, submitFeedback, declineFeedback } from "../src/services/reviewFeedback";
import type { ListScope } from "../src/domain/access";

// Real-D1 (miniflare) flow test for the performance review cycle: the stage machine, and the two ownership
// rules the UI leans on - a 360 nomination is answerable ONLY by the person it was addressed to, and a
// soft-deleted cycle takes its reviews off every list with it.
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
const b = env as unknown as Bindings;
const ALL: ListScope = { breadth: "all", deptCode: null, ownerId: null, seeRestricted: true };

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
});

const TABLES = [schema.reviewFeedback, schema.reviews, schema.reviewCycles, schema.notifications, schema.auditLog, schema.eventLog, schema.settings, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
});

// One employee + the user record that acts as them.
// Employee codes come from a COUNTER, not from random characters. `04-${genId().slice(0, 3)}` draws three
// base32 characters - 32,768 possibilities - and this file seeds a whole roster, so the birthday bound makes a
// duplicate `employees.code` (UNIQUE) a matter of when, not if: the suite failed roughly one run in a hundred
// on an insert that has nothing to do with what is being tested. A counter is unique by construction.
let seedSeq = 0;
const nextCode = () => `04-${(++seedSeq).toString(36).padStart(3, "0")}`;

async function seedActor(managerId?: string): Promise<AppUser & { employeeId: string }> {
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({
    uuid: employeeId, code: nextCode(), firstName: "Test", lastName: "User",
    workEmail: `${employeeId}@test.example`, status: "active", ...(managerId ? { managerId } : {}),
  });
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${uuid}@test.example`, role: "employee", employeeId });
  return { uuid, email: `${uuid}@test.example`, role: "employee", status: "active", employeeId, employeeCode: null } as unknown as AppUser & { employeeId: string };
}

// A launched cycle with one enrolled reviewee; returns that reviewee's review row.
async function launchFor(actor: AppUser, revieweeId: string, name = "H1 2026") {
  const cycle = await createReviewCycle(deps, actor, { name, period_start: "2026-01-01", period_end: "2026-06-30" });
  await launchReviewCycle(deps, actor, cycle.uuid, [`employees/${revieweeId}`]);
  const { items } = await listReviews(deps, ALL, 100);
  const review = items.find((r) => r.employeeId === revieweeId)!;
  return { cycle, review };
}

describe("review stage machine", () => {
  it("runs SELF -> MANAGER -> SHARED -> ACKNOWLEDGED, carrying each stage's content", async () => {
    const manager = await seedActor();
    const employee = await seedActor(manager.employeeId);
    const { review } = await launchFor(manager, employee.employeeId);
    expect(review.state).toBe("SELF");

    const afterSelf = await submitSelf(deps, employee, review.uuid, " shipped the migration ", { delivery: 4 });
    expect(afterSelf.state).toBe("MANAGER");
    expect(afterSelf.selfComment).toBe("shipped the migration");
    expect(JSON.parse(afterSelf.selfRatingsJson!)).toEqual({ delivery: 4 });

    const afterMgr = await submitManager(deps, manager, review.uuid, { ratings: { delivery: 5 }, overall_rating: 4, manager_comment: "strong half" });
    expect(afterMgr.state).toBe("SHARED");
    expect(afterMgr.overallRating).toBe(4);

    const acked = await acknowledgeReview(deps, employee, review.uuid, "thanks - would like more scope");
    expect(acked.state).toBe("ACKNOWLEDGED");
    expect(acked.ackComment).toBe("thanks - would like more scope");
  });

  it("a stage can only be submitted once (double-submit loses the race, it does not overwrite)", async () => {
    const manager = await seedActor();
    const employee = await seedActor(manager.employeeId);
    const { review } = await launchFor(manager, employee.employeeId);

    await submitSelf(deps, employee, review.uuid, "first");
    await expect(submitSelf(deps, employee, review.uuid, "second")).rejects.toThrow();
    const row = (await listReviews(deps, ALL, 100)).items.find((r) => r.uuid === review.uuid)!;
    expect(row.selfComment).toBe("first");
  });

  it("a stage cannot be submitted out of order", async () => {
    const manager = await seedActor();
    const employee = await seedActor(manager.employeeId);
    const { review } = await launchFor(manager, employee.employeeId);
    // Still in SELF: there is nothing for the manager to share, and nothing to acknowledge.
    await expect(submitManager(deps, manager, review.uuid, { overall_rating: 5 })).rejects.toThrow();
    await expect(acknowledgeReview(deps, employee, review.uuid)).rejects.toThrow();
  });
});

describe("360 feedback is answerable only by the nominee", () => {
  it("the nominated author can submit; anyone else is refused even with reach over the row", async () => {
    const manager = await seedActor();
    const employee = await seedActor(manager.employeeId);
    const peer = await seedActor(manager.employeeId);
    const bystander = await seedActor(manager.employeeId);
    const { review } = await launchFor(manager, employee.employeeId);

    await nominateFeedback(deps, manager, review.uuid, [`employees/${peer.employeeId}`]);
    const [request] = await deps.db.select().from(schema.reviewFeedback);
    expect(request!.authorId).toBe(peer.employeeId);

    // A super admin / anyone else holding the verb broadly must not answer in the nominee's name.
    await expect(submitFeedback(deps, bystander, request!.uuid, { comment: "not mine to give" })).rejects.toThrow(/only the nominated author/);
    await expect(declineFeedback(deps, bystander, request!.uuid)).rejects.toThrow(/only the nominated author/);

    const done = await submitFeedback(deps, peer, request!.uuid, { comment: "great collaborator", overall_rating: 5 });
    expect(done.state).toBe("SUBMITTED");
    expect(done.comment).toBe("great collaborator");
  });

  it("never nominates the reviewee, and never duplicates an existing nominee", async () => {
    const manager = await seedActor();
    const employee = await seedActor(manager.employeeId);
    const peer = await seedActor(manager.employeeId);
    const { review } = await launchFor(manager, employee.employeeId);

    await expect(nominateFeedback(deps, manager, review.uuid, [`employees/${employee.employeeId}`])).rejects.toThrow();
    await nominateFeedback(deps, manager, review.uuid, [`employees/${peer.employeeId}`]);
    await nominateFeedback(deps, manager, review.uuid, [`employees/${peer.employeeId}`]);
    expect(await deps.db.select().from(schema.reviewFeedback)).toHaveLength(1);
  });

  // Nomination is a fan-out, not a loop: each nominee used to cost an owned-code allocation, an insert and a
  // whole `notify` (five more D1 round trips), all against the Worker's per-invocation subrequest ceiling. The
  // thing that batching most easily breaks is the notification's SUBJECT - a shared one would point every
  // nominee at the first person's request instead of their own.
  it("nominates a whole panel at once, each told about their own request", async () => {
    const manager = await seedActor();
    const employee = await seedActor(manager.employeeId);
    const peers = [];
    for (let i = 0; i < 8; i++) peers.push(await seedActor(manager.employeeId));
    const { review } = await launchFor(manager, employee.employeeId);

    await nominateFeedback(deps, manager, review.uuid, peers.map((p) => `employees/${p.employeeId}`));

    const requests = await deps.db.select().from(schema.reviewFeedback);
    expect(requests).toHaveLength(8);
    expect(requests.every((r) => r.state === "REQUESTED")).toBe(true);
    // Every code is distinct - they come from the same per-owner counters a single nomination takes from.
    expect(new Set(requests.map((r) => r.code)).size).toBe(8);

    const notes = (await deps.db.select().from(schema.notifications)).filter((n) => n.type === "review.feedback_requested");
    expect(notes).toHaveLength(8);
    const rowFor = new Map(requests.map((r) => [r.authorId, r.uuid]));
    for (const n of notes) expect(n.subject).toBe(`review-feedback/${rowFor.get(n.recipientId!)}`);
  });

  it("promotes the reviewee's suggestions in the same press that adds new nominees", async () => {
    const manager = await seedActor();
    const employee = await seedActor(manager.employeeId);
    const suggested = await seedActor(manager.employeeId);
    const fresh = await seedActor(manager.employeeId);
    const { review } = await launchFor(manager, employee.employeeId);

    await suggestFeedback(deps, employee, review.uuid, [`employees/${suggested.employeeId}`]);
    expect((await deps.db.select().from(schema.reviewFeedback))[0]!.state).toBe("SUGGESTED");

    await nominateFeedback(deps, manager, review.uuid, [`employees/${suggested.employeeId}`, `employees/${fresh.employeeId}`]);

    const rows = await deps.db.select().from(schema.reviewFeedback);
    expect(rows).toHaveLength(2); // the suggestion was upgraded in place, not duplicated
    expect(rows.every((r) => r.state === "REQUESTED")).toBe(true);
    // Both kinds of nominee are told, each about their own row.
    const notes = (await deps.db.select().from(schema.notifications)).filter((n) => n.type === "review.feedback_requested");
    const rowFor = new Map(rows.map((r) => [r.authorId, r.uuid]));
    expect(notes).toHaveLength(2);
    for (const n of notes) expect(n.subject).toBe(`review-feedback/${rowFor.get(n.recipientId!)}`);
  });

  it("cannot be requested once the review is shared (it could no longer inform anything)", async () => {
    const manager = await seedActor();
    const employee = await seedActor(manager.employeeId);
    const peer = await seedActor(manager.employeeId);
    const { review } = await launchFor(manager, employee.employeeId);

    await submitSelf(deps, employee, review.uuid, "done");
    await submitManager(deps, manager, review.uuid, { overall_rating: 4 });
    await expect(nominateFeedback(deps, manager, review.uuid, [`employees/${peer.employeeId}`])).rejects.toThrow(/already been shared/);
  });
});

describe("a soft-deleted cycle takes its reviews with it", () => {
  it("drops them from the list (reviews have no delete_time of their own)", async () => {
    const manager = await seedActor();
    const employee = await seedActor(manager.employeeId);
    const { cycle } = await launchFor(manager, employee.employeeId);
    const other = await launchFor(manager, (await seedActor(manager.employeeId)).employeeId, "H2 2026");

    expect((await listReviews(deps, ALL, 100)).items).toHaveLength(2);
    await deleteReviewCycle(deps, manager, cycle.uuid);
    const left = (await listReviews(deps, ALL, 100)).items;
    expect(left).toHaveLength(1);
    expect(left[0]!.cycleId).toBe(other.cycle.uuid);
  });
});

// Who writes a review, and who gets asked for 360 feedback. Both used to have exactly one answer - the
// manager chain, and the manager's own nomination list - and both broke on ordinary org shapes.
describe("the reviewer override", () => {
  it("hands the write-up, the nudge and the acknowledgement note to the assigned reviewer, not the manager", async () => {
    const manager = await seedActor();
    const lead = await seedActor(); // the person they actually worked for this cycle
    const employee = await seedActor(manager.employeeId);
    const { review } = await launchFor(manager, employee.employeeId);

    const assigned = await assignReviewer(deps, manager, review.uuid, `employees/${lead.employeeId}`);
    expect(assigned.reviewerId).toBe(lead.employeeId);
    // Named, so they find out now rather than at the deadline.
    const told = await deps.db.select().from(schema.notifications).where(eq(schema.notifications.recipientId, lead.employeeId));
    expect(told.some((n) => n.type === "review.reviewer_assigned")).toBe(true);

    // Submitting the self stage hands it to the REVIEWER.
    await submitSelf(deps, employee, review.uuid, "my half");
    const handoff = await deps.db.select().from(schema.notifications).where(eq(schema.notifications.recipientId, lead.employeeId));
    expect(handoff.some((n) => n.type === "review.self_submitted")).toBe(true);
    const mgrInbox = await deps.db.select().from(schema.notifications).where(eq(schema.notifications.recipientId, manager.employeeId));
    expect(mgrInbox.some((n) => n.type === "review.self_submitted")).toBe(false);

    // And so does the nudge for the manager stage.
    await nudgeReview(deps, manager, review.uuid);
    const nudged = await deps.db.select().from(schema.notifications).where(eq(schema.notifications.recipientId, lead.employeeId));
    expect(nudged.some((n) => n.type === "review.nudge")).toBe(true);
  });

  it("clears back to the manager chain, refuses self-review, and refuses to rewrite a shared review", async () => {
    const manager = await seedActor();
    const lead = await seedActor();
    const employee = await seedActor(manager.employeeId);
    const { review } = await launchFor(manager, employee.employeeId);

    await assignReviewer(deps, manager, review.uuid, `employees/${lead.employeeId}`);
    expect((await assignReviewer(deps, manager, review.uuid, null)).reviewerId).toBeNull();
    await expect(assignReviewer(deps, manager, review.uuid, `employees/${employee.employeeId}`)).rejects.toThrow(/own reviewer/i);

    await submitSelf(deps, employee, review.uuid, "done");
    await submitManager(deps, manager, review.uuid, { overall_rating: 3 });
    // Once shared, who wrote it is part of the record.
    await expect(assignReviewer(deps, manager, review.uuid, `employees/${lead.employeeId}`)).rejects.toThrow(/already shared/i);
  });
});

describe("peer feedback the reviewee seeds", () => {
  it("suggests inertly, then a manager's nomination upgrades that same row rather than asking twice", async () => {
    const manager = await seedActor();
    const employee = await seedActor(manager.employeeId);
    const peer = await seedActor();
    const { review } = await launchFor(manager, employee.employeeId);

    await suggestFeedback(deps, employee, review.uuid, [`employees/${peer.employeeId}`]);
    const suggested = await deps.db.select().from(schema.reviewFeedback).where(eq(schema.reviewFeedback.reviewId, review.uuid));
    expect(suggested.map((f) => f.state)).toEqual(["SUGGESTED"]);
    // Inert: a suggestion asks nobody for anything.
    const quiet = await deps.db.select().from(schema.notifications).where(eq(schema.notifications.recipientId, peer.employeeId));
    expect(quiet.length).toBe(0);

    await nominateFeedback(deps, manager, review.uuid, [`employees/${peer.employeeId}`]);
    const after = await deps.db.select().from(schema.reviewFeedback).where(eq(schema.reviewFeedback.reviewId, review.uuid));
    expect(after.length).toBe(1); // upgraded in place, not a second request
    expect(after[0]!.state).toBe("REQUESTED");
    const asked = await deps.db.select().from(schema.notifications).where(eq(schema.notifications.recipientId, peer.employeeId));
    expect(asked.some((n) => n.type === "review.feedback_requested")).toBe(true);
  });

  it("replaces the whole suggested set, never touching a request already made or answered", async () => {
    const manager = await seedActor();
    const employee = await seedActor(manager.employeeId);
    const [a, bPeer, c] = [await seedActor(), await seedActor(), await seedActor()];
    const { review } = await launchFor(manager, employee.employeeId);

    await suggestFeedback(deps, employee, review.uuid, [`employees/${a.employeeId}`, `employees/${bPeer.employeeId}`]);
    await nominateFeedback(deps, manager, review.uuid, [`employees/${a.employeeId}`]); // a is now a real request
    // The reviewee revises their list: drops b, adds c. The REQUESTED row for a is not theirs to withdraw.
    await suggestFeedback(deps, employee, review.uuid, [`employees/${c.employeeId}`]);

    const rows = await deps.db.select().from(schema.reviewFeedback).where(eq(schema.reviewFeedback.reviewId, review.uuid));
    const byPerson = new Map(rows.map((r) => [r.authorId, r.state]));
    expect(byPerson.get(a.employeeId)).toBe("REQUESTED");
    expect(byPerson.has(bPeer.employeeId)).toBe(false);
    expect(byPerson.get(c.employeeId)).toBe("SUGGESTED");
  });

  it("is the reviewee's own list: nobody else may write it", async () => {
    const manager = await seedActor();
    const employee = await seedActor(manager.employeeId);
    const peer = await seedActor();
    const { review } = await launchFor(manager, employee.employeeId);
    await expect(suggestFeedback(deps, manager, review.uuid, [`employees/${peer.employeeId}`])).rejects.toThrow(/only the reviewee/i);
  });

  it("keeps the nominee's reason for declining, in their own words", async () => {
    const manager = await seedActor();
    const employee = await seedActor(manager.employeeId);
    const peer = await seedActor();
    const { review } = await launchFor(manager, employee.employeeId);
    await nominateFeedback(deps, manager, review.uuid, [`employees/${peer.employeeId}`]);
    const request = (await deps.db.select().from(schema.reviewFeedback).where(eq(schema.reviewFeedback.reviewId, review.uuid)))[0]!;

    const declined = await declineFeedback(deps, peer, request.uuid, "  we haven't worked together this cycle  ");
    expect(declined.state).toBe("DECLINED");
    expect(declined.declineReason).toBe("we haven't worked together this cycle");
  });
});

describe("a cycle's own competencies", () => {
  it("stores the selection, clears it when emptied, and narrows the framework to it", async () => {
    const actor = await seedActor();
    const cycle = await createReviewCycle(deps, actor, { name: "Probation", competency_keys: ["impact", "impact", "growth"] });
    expect(JSON.parse(cycle.competencyKeysJson!)).toEqual(["impact", "growth"]); // deduped

    const framework = [{ key: "impact", label: "Impact" }, { key: "craft", label: "Craft" }, { key: "growth", label: "Growth" }];
    // Framework order, not the stored order, so two cycles present shared competencies the same way round.
    expect(competenciesForCycle(framework, cycle.competencyKeysJson).map((c) => c.key)).toEqual(["impact", "growth"]);
    // No selection means all of them, and so does a selection nothing live matches - a review form with no
    // questions on it is a broken review.
    expect(competenciesForCycle(framework, null).map((c) => c.key)).toEqual(["impact", "craft", "growth"]);
    expect(competenciesForCycle(framework, JSON.stringify(["retired"])).map((c) => c.key)).toEqual(["impact", "craft", "growth"]);

    const cleared = await updateReviewCycle(deps, actor, cycle.uuid, { competency_keys: [] });
    expect(cleared.competencyKeysJson).toBeNull();
  });
});
