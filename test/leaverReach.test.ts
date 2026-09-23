/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { activeEmployeeIds, audienceEmployeeIds, managerIdOf, notify, notifyMany, notifyManager } from "../src/services/notifications";
import { activeDelegatesFor } from "../src/services/approvalDelegations";

// WHO IS STILL HERE - the question every broadcast asks, and the one the org-wide audience got wrong.
//
// `status` and `delete_time` are independent columns. Offboarding stamps `status: "terminated"` and disables
// the login and never stamps `delete_time` (services/transitions.ts); the generic soft delete stamps
// `delete_time` and never touches `status`. The broadcast audience filtered only the second, so every leaver
// the org had ever offboarded stayed in it - and this audience is not just a bell: services/lifecycle.ts mails
// the same list when the author asks for it, and notifications push to registered devices, so a departed
// employee's phone kept buzzing with company announcements.
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

beforeEach(async () => {
  await deps.db.delete(schema.notifications);
  await deps.db.delete(schema.approvalDelegations);
  await deps.db.delete(schema.codeSequences);
  await deps.db.delete(schema.employees);
  await deps.db.delete(schema.departments);
  await deps.db.insert(schema.departments).values({ uuid: DEPT, code: "04", name: "Engineering" });
});

const DEPT = "0000000000dep";
let n = 0;
async function employee(over: Partial<typeof schema.employees.$inferInsert> = {}) {
  const uuid = genId();
  n += 1;
  await deps.db.insert(schema.employees).values({
    uuid,
    code: `04-002-${String(n).padStart(3, "0")}`,
    firstName: "Test",
    lastName: `Person${n}`,
    workEmail: `p${n}@example.com`,
    departmentId: DEPT,
    ...over,
  });
  return uuid;
}

describe("the broadcast audience is people who are still here", () => {
  it("includes a live employee", async () => {
    const live = await employee();
    expect(await activeEmployeeIds(deps)).toEqual([live]);
  });

  it("excludes someone who was OFFBOARDED - the exit that does not touch delete_time", async () => {
    const live = await employee();
    await employee({ status: "terminated", disabled: true, endDate: new Date() });
    expect(await activeEmployeeIds(deps)).toEqual([live]);
  });

  it("excludes someone soft-deleted, and someone whose account was switched off", async () => {
    const live = await employee();
    await employee({ deleteTime: new Date() });
    await employee({ disabled: true });
    expect(await activeEmployeeIds(deps)).toEqual([live]);
  });

  it("applies the same rule to a DEPARTMENT audience, which had the same gap", async () => {
    const live = await employee();
    await employee({ status: "terminated" });
    await employee({ deleteTime: new Date() });
    expect(await audienceEmployeeIds(deps, { kind: "department", department: `departments/${DEPT}` })).toEqual([live]);
    expect(await audienceEmployeeIds(deps, { kind: "everyone" })).toEqual([live]);
  });

  // THE THIRD ARM, which applied no filter at all. `audienceEmployeeIds` declares itself "the (active) employee
  // uuids", two of its three arms bound the liveness predicate, and the one an automation author writes BY
  // HAND - naming specific people - returned the list verbatim. The email half happened to be covered by a
  // second filter in services/emailFanOut.ts; the in-app half had nothing behind it, so a rule naming a leaver
  // minted notification rows nobody can ever read (they cannot sign in) and spent a code allocation on each.
  it("applies it to a NAMED-EMPLOYEES audience too, which applied no filter at all", async () => {
    const live = await employee();
    const gone = await employee({ status: "terminated" });
    const deleted = await employee({ deleteTime: new Date() });
    const off = await employee({ disabled: true });
    const named = { kind: "employees" as const, employees: [live, gone, deleted, off].map((id) => `employees/${id}`) };
    expect(await audienceEmployeeIds(deps, named)).toEqual([live]);
  });

  it("drops an id that no longer resolves, rather than handing it on to fail an FK", async () => {
    const live = await employee();
    const named = { kind: "employees" as const, employees: [`employees/${live}`, "employees/0000000000gone"] };
    expect(await audienceEmployeeIds(deps, named)).toEqual([live]);
  });

  it("keeps the order the rule named them in", async () => {
    const a = await employee();
    const bb = await employee();
    const c = await employee();
    const named = { kind: "employees" as const, employees: [c, a, bb].map((id) => `employees/${id}`) };
    expect(await audienceEmployeeIds(deps, named)).toEqual([c, a, bb]);
  });

  it("answers nothing for an empty named audience, without a query", async () => {
    await employee();
    expect(await audienceEmployeeIds(deps, { kind: "employees", employees: [] })).toEqual([]);
  });
});

// THE AUDIENCE ARM WAS THE ONLY ARM THAT BOUND THE RULE.
//
// `audienceEmployeeIds` above filters who a BROADCAST reaches, and it was the only caller of the predicate.
// Every path that picks ONE person went unfiltered: `notify` never looked at the recipient, `notifyManager`
// took `employees.manager_id` verbatim, `activeDelegatesFor` matched on the date window alone, and
// `resolveAssignee` fell back only when the pointer was NULL - never when it resolved to somebody who had
// left. And the pointer is never cleared: neither exit reparents anybody, so `manager_id` can name a departed
// person indefinitely while middleware/auth.ts#assertLive guarantees they can never open a session to read
// what was sent to them. Every such row also spends an allocation off that person's `code_sequences` counter.
const inboxOf = async (recipientId: string) =>
  deps.db.select().from(schema.notifications).where(eq(schema.notifications.recipientId, recipientId));

describe("the paths that pick ONE person bind the same rule", () => {
  it("notify() writes nothing into a mailbox nobody can open", async () => {
    const live = await employee();
    const gone = await employee({ status: "terminated" });
    const deleted = await employee({ deleteTime: new Date() });
    const off = await employee({ disabled: true });

    for (const recipient of [live, gone, deleted, off]) {
      await notify(deps, { recipient, type: "leave.requested", title: "Something happened" });
    }
    expect((await inboxOf(live)).length).toBe(1);
    for (const dead of [gone, deleted, off]) expect((await inboxOf(dead)).length).toBe(0);
  });

  it("notify() still denormalizes the name of an ACTOR who has since left", async () => {
    // The liveness question is about the RECIPIENT. An approval granted by somebody who has since left still
    // shows their name on the notification, which is why the check is on the row rather than in the `where`.
    const live = await employee();
    const gone = await employee({ status: "terminated", firstName: "Departed", lastName: "Approver" });
    await notify(deps, { recipient: live, type: "leave.approved", title: "Approved", actorId: gone });
    const [row] = await inboxOf(live);
    expect(row?.actorName).toBe("Departed Approver");
  });

  it("notifyMany() drops the dead recipients and the ids that resolve to nobody", async () => {
    const live = await employee();
    const gone = await employee({ status: "terminated" });
    await notifyMany(deps, [live, gone, "0000000000gone"], { type: "announcement.published", title: "Notice" });
    expect((await inboxOf(live)).length).toBe(1);
    expect((await inboxOf(gone)).length).toBe(0);
  });

  it("managerIdOf escalates past a manager who has left, to the first live one above", async () => {
    const skip = await employee();
    const manager = await employee({ managerId: skip, status: "terminated" });
    const report = await employee({ managerId: manager });
    expect(await managerIdOf(deps, report)).toBe(skip);
    // Still the direct manager when they are here, and still null when there is nobody at all.
    const liveManager = await employee();
    const other = await employee({ managerId: liveManager });
    expect(await managerIdOf(deps, other)).toBe(liveManager);
    expect(await managerIdOf(deps, skip)).toBeNull();
  });

  it("managerIdOf answers null rather than looping when the chain is nobody but leavers", async () => {
    const top = await employee({ status: "terminated" });
    const mid = await employee({ managerId: top, disabled: true });
    const report = await employee({ managerId: mid });
    expect(await managerIdOf(deps, report)).toBeNull();
  });

  it("notifyManager nudges the skip-level manager instead of the mailbox that is switched off", async () => {
    const skip = await employee();
    const manager = await employee({ managerId: skip, status: "terminated" });
    const report = await employee({ managerId: manager });
    await notifyManager(deps, report, { type: "leave.requested", noun: "leave request" });
    expect((await inboxOf(manager)).length).toBe(0);
    const [row] = await inboxOf(skip);
    expect(row?.title).toBe("New leave request to review");
    expect(row?.actorId).toBe(report);
  });

  it("activeDelegatesFor drops a delegate who has left, even inside the window", async () => {
    // The cover path for exactly this situation, and it matched on the dates alone - so a delegation set up
    // before somebody left went on copying every nudge into a second dead mailbox.
    const manager = await employee();
    const liveDelegate = await employee();
    const goneDelegate = await employee({ status: "terminated" });
    const window = { fromDate: new Date(Date.now() - 86_400_000), toDate: new Date(Date.now() + 86_400_000) };
    await deps.db.insert(schema.approvalDelegations).values([
      { uuid: genId(), code: "04-001", delegatorId: manager, delegateId: liveDelegate, ...window },
      { uuid: genId(), code: "04-002", delegatorId: manager, delegateId: goneDelegate, ...window },
    ]);
    expect(await activeDelegatesFor(deps, manager)).toEqual([liveDelegate]);
  });
});
