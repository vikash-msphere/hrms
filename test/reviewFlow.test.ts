/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { createReviewCycle, launchReviewCycle, deleteReviewCycle } from "../src/services/reviewCycles";
import { listReviews, submitSelf, submitManager, acknowledgeReview } from "../src/services/reviews";
import { nominateFeedback, submitFeedback, declineFeedback } from "../src/services/reviewFeedback";
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
async function seedActor(managerId?: string): Promise<AppUser & { employeeId: string }> {
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({
    uuid: employeeId, code: `04-${genId().slice(0, 3)}`, firstName: "Test", lastName: "User",
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
