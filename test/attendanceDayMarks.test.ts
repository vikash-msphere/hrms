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
import { bustRef } from "../src/lib/refData";
import type { ListScope } from "../src/domain/access";
import { DEFAULT_ATTENDANCE } from "../src/domain/attendance";
import { assertSomebodyElse, createDayMark, listDayMarks, marksForPeriod, notifyDayMarkChanged, removeDayMark } from "../src/services/attendanceDayMarks";
import { attendanceDayMarks, dayMarkUpdateSchema } from "../src/routes/attendanceDayMarks";
import { NOTIFICATION_CATEGORIES, categoryOf } from "../src/domain/notificationConfig";
import { EVENT_TYPES } from "../src/domain/events";

// The rules around WRITING a day mark, and the shape payroll reads them back in.
//
// The arithmetic is attendanceLop.test.ts and the payroll wiring is moneyFlow.test.ts. What is left is the
// service's own judgement: which days can carry a mark at all, that one day carries at most one, and that a
// withdrawn mark stops counting. Each of those is a way the feature could look like it worked while quietly
// doing nothing (or doing it twice).

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

const TABLES = [
  schema.attendanceDayMarks, schema.auditLog, schema.eventLog, schema.notifications,
  schema.holidays, schema.settings, schema.users, schema.employees, schema.roles, schema.codeSequences,
];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  deps.refCache?.clear();
  bustRef(deps, "settings");
  bustRef(deps, "holidays");
});

// 2026-01-05 is a Monday, 01-10 a Saturday.
const MON = "2026-01-05";
const SAT = "2026-01-10";
const AYA = { id: genId(), code: "04-001-001" };
const BEN = { id: genId(), code: "07-001-001" };
// The HR admin holding the pen is a THIRD person, and has to be: a mark may not be made or changed on one's
// own day, whatever the grant says (services/attendanceDayMarks.ts - the same maker-checker a tax
// verification has), so an actor who was also one of the subjects could not mark that subject at all.
const HR = { id: genId(), code: "09-001-001" };
let actor: AppUser;

async function seed() {
  await deps.db.insert(schema.employees).values([
    { uuid: AYA.id, code: AYA.code, firstName: "Aya", lastName: "One", workEmail: "aya@x.test", status: "active" },
    { uuid: BEN.id, code: BEN.code, firstName: "Ben", lastName: "Two", workEmail: "ben@x.test", status: "active" },
    { uuid: HR.id, code: HR.code, firstName: "Hana", lastName: "Three", workEmail: "hr@x.test", status: "active" },
  ]);
  await deps.db.insert(schema.roles).values({ name: "hr_admin", label: "HR" }).onConflictDoNothing();
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: "u-1", email: "hr@x.test", role: "hr_admin", employeeId: HR.id });
  actor = { uuid, email: "hr@x.test", role: "hr_admin", status: "active", employeeId: HR.id, employeeCode: HR.code } as unknown as AppUser;
  await deps.db.insert(schema.settings).values({ key: "attendance", value: JSON.stringify(DEFAULT_ATTENDANCE), updatedAt: new Date() });
  deps.refCache?.clear();
  bustRef(deps, "settings");
}

const mark = (over: Record<string, unknown> = {}) =>
  createDayMark(deps, actor, { employee: `employees/${AYA.id}`, date: MON, credit: "half", ...over });

const all = (): ListScope => ({ breadth: "all", deptCode: null, ownerId: null, seeRestricted: true });
const dept = (code: string): ListScope => ({ breadth: "dept", deptCode: code, ownerId: null, seeRestricted: true });

describe("a mark can only go on a day that owed work", () => {
  it("marks an ordinary working day", async () => {
    await seed();
    const row = await mark();
    expect(row.credit).toBe("half");
    expect(row.employeeId).toBe(AYA.id);
    // Owner-embedded, like every other employee-owned collection - it is what the scope predicate binds to.
    expect(row.code?.startsWith(AYA.code)).toBe(true);
  });

  it("refuses a weekend", async () => {
    await seed();
    // `lopDayUnits` skips a non-working day before it ever reads a mark, so a mark here would be a row that
    // reads on the record as a decision and changes nothing. Refused rather than stored and ignored.
    await expect(mark({ date: SAT })).rejects.toThrow(/not a working day/i);
  });

  it("refuses a holiday", async () => {
    await seed();
    await deps.db.insert(schema.holidays).values({ uuid: genId(), code: "h-1", name: "Test Holiday", date: new Date(`${MON}T00:00:00.000Z`) });
    deps.refCache?.clear();
    bustRef(deps, "holidays");
    await expect(mark()).rejects.toThrow(/holiday/i);
  });

  it("refuses a credit it cannot settle, and a mark with nobody to settle it against", async () => {
    await seed();
    await expect(mark({ credit: "quarter" })).rejects.toThrow(/credit must be one of/i);
    await expect(mark({ credit: undefined })).rejects.toThrow(/credit must be one of/i);
    // NOT defaulted to the caller: a mark is about somebody else's day by construction, and defaulting it is
    // how an HR admin re-values their own day by leaving a field out.
    await expect(mark({ employee: null })).rejects.toThrow(/employee is required/i);
    await expect(mark({ date: undefined })).rejects.toThrow(/date is required/i);
  });
});

// A day mark decides what a day is PAID as, so it is somebody else's decision to make - structurally, not by
// grant. The org-wide write HR holds (`attendance-day-marks.**`) covers their own rows by construction, so
// without this the one rule the feature is careful about ("a self rule would be a grant to re-value your own
// attendance", grants.ts) was handed out by the broad rule instead. Same shape as the maker-checker on a tax
// verification (services/taxDetails.ts), and it has to hold on BOTH ways in - making a mark and changing one.
describe("a mark is somebody else's decision", () => {
  it("refuses a mark the caller would be making on their own day", async () => {
    await seed();
    await expect(createDayMark(deps, actor, { employee: `employees/${HR.id}`, date: MON, credit: "absent" }))
      .rejects.toThrow(/somebody else/i);
  });

  it("refuses re-valuing a mark on the caller's own day, which is the other way to the same place", () => {
    // The PATCH lane asks the same question of the ROW's owner (the route's `beforeUpdate`), because the
    // create guard alone leaves editing as the way round: somebody else marks the holder's day absent and
    // they patch it to a full day. One rule, one function, asked on both paths.
    const own = { employeeId: HR.id } as unknown as AppUser;
    expect(() => assertSomebodyElse(own, HR.id)).toThrow(/somebody else/i);
    expect(() => assertSomebodyElse(own, BEN.id)).not.toThrow();
    // An account with no employee record of its own (an integration key) is nobody's subject, so it decides.
    expect(() => assertSomebodyElse({ employeeId: null } as unknown as AppUser, HR.id)).not.toThrow();
  });
});

describe("one day carries at most one mark", () => {
  it("refuses a second mark on the same day", async () => {
    await seed();
    await mark();
    // Two marks on one day is a question payroll cannot answer - it would take whichever the query returned
    // first - so the service says so and `attmark_live_day_idx` holds it under a race.
    await expect(mark({ credit: "full" })).rejects.toThrow(/already marked/i);
  });

  it("lets the same day be re-marked once the first is withdrawn", async () => {
    await seed();
    const first = await mark();
    await deps.db.update(schema.attendanceDayMarks).set({ deleteTime: new Date() }).where(eq(schema.attendanceDayMarks.uuid, first.uuid));
    const second = await mark({ credit: "absent" });
    expect(second.credit).toBe("absent");
  });

  it("does not stop another PERSON being marked on the same day", async () => {
    await seed();
    await mark();
    const other = await createDayMark(deps, actor, { employee: `employees/${BEN.id}`, date: MON, credit: "full" });
    expect(other.employeeId).toBe(BEN.id);
  });
});

describe("a mark is edited in place, but never moved", () => {
  const routes = () => (attendanceDayMarks as unknown as { routes: { method: string; path: string }[] }).routes.map((r) => `${r.method} ${r.path}`);

  it("mounts a PATCH lane at all", () => {
    // The factory mounts one only when the spec supplies a `patch` mapper (`canUpdate` in
    // http/collectionRoute.ts). An `updateSchema` alone does NOT mount it - which is how this shipped once
    // with an editor whose Save button had no endpoint behind it and an openapi that promised one.
    expect(routes()).toContain("PATCH /:day_mark_id");
    // And the rest of the lane is what the collection is meant to offer: no approve/reject (this is an HR
    // decision, not a request), but a withdraw and its undo.
    expect(routes()).toContain("DELETE /:day_mark_id");
    expect(routes()).toContain("GET /");
  });

  it("takes the decision and the reason, and refuses to move the mark", async () => {
    await seed();
    await mark();
    // `date` is what `assertOwedDay` was checked against and what the one-live-mark-per-day index is keyed
    // on; `employee` is embedded in `code`, which is what the list scope binds to. Neither is a field of the
    // decision, so the patch body REJECTS both rather than quietly ignoring them - a silent no-op would leave
    // the caller believing a mark had moved.
    expect(dayMarkUpdateSchema.safeParse({ credit: "absent" }).success).toBe(true);
    expect(dayMarkUpdateSchema.safeParse({ reason: "revised" }).success).toBe(true);
    expect(dayMarkUpdateSchema.safeParse({ date: SAT }).success).toBe(false);
    expect(dayMarkUpdateSchema.safeParse({ employee: `employees/${BEN.id}` }).success).toBe(false);
  });
});

describe("the employee is told, through channels the org can actually steer", () => {
  it("notifies the person whose pay it changes, under a configurable category", async () => {
    await seed();
    await mark({ credit: "absent", reason: "No show" });
    const rows = await deps.db.select().from(schema.notifications);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recipientId).toBe(AYA.id);
    expect(rows[0]!.body).toBe("No show");
    // `categoryOf` is the segment before the first dot, and only a REGISTERED category appears in the
    // settings UI and in a person's mute list. An unregistered one still delivers, which is the failure that
    // looks like success: a notification about somebody's pay that nobody can turn off or mute.
    expect(NOTIFICATION_CATEGORIES.map((c) => c.key)).toContain(categoryOf(rows[0]!.type));
  });

  it("tells them again when the decision CHANGES, but not when only its wording does", async () => {
    await seed();
    const row = await mark({ credit: "half" });
    await deps.db.delete(schema.notifications); // the create's own message, already asserted above

    // half -> absent is a bigger change than the original decision was, and told once and never again the
    // employee would be holding a notification that no longer says what they will be paid.
    await notifyDayMarkChanged(deps, actor, { ...row, credit: "absent" }, row);
    const told = await deps.db.select().from(schema.notifications);
    expect(told).toHaveLength(1);
    expect(told[0]!.title).toContain("absent");

    // Rewording the reason is not a new decision, and a message saying nothing changed is what teaches people
    // to mute the category.
    await deps.db.delete(schema.notifications);
    await notifyDayMarkChanged(deps, actor, { ...row, reason: "reworded" }, row);
    expect(await deps.db.select().from(schema.notifications)).toHaveLength(0);
  });

  it("tells them when the mark is WITHDRAWN and the day goes back to its punches", async () => {
    await seed();
    const row = await mark({ credit: "full" });
    await deps.db.delete(schema.notifications);

    await removeDayMark(deps, actor, row.uuid);
    const told = await deps.db.select().from(schema.notifications);
    expect(told).toHaveLength(1);
    expect(told[0]!.recipientId).toBe(AYA.id);
    // Told their day counted in full and then silently un-told, the employee would be holding a notification
    // that had stopped being true - and this is the path that puts a deduction BACK.
    expect(told[0]!.title).toContain("back to its clocked hours");

    // And it really is withdrawn: the shared soft-delete ran underneath, so payroll stops reading it.
    const after = (await deps.db.select().from(schema.attendanceDayMarks).where(eq(schema.attendanceDayMarks.uuid, row.uuid)).limit(1))[0]!;
    expect(after.deleteTime).not.toBeNull();
    expect((await marksForPeriod(deps, Date.parse(`${MON}T00:00:00Z`), Date.parse("2026-01-09T00:00:00Z"))).size).toBe(0);
  });

  it("emits an event the rule builder can actually see", async () => {
    await seed();
    await mark();
    const events = await deps.db.select().from(schema.eventLog);
    expect(events).toHaveLength(1);
    // Emitting a type absent from the catalogue means the bus carries it and no rule can ever subscribe -
    // the automation half of the feature silently does not exist.
    expect(EVENT_TYPES.map((e) => e.type)).toContain(events[0]!.type);
  });
});

describe("what payroll reads back", () => {
  it("returns the live marks for the window, keyed by employee and day", async () => {
    await seed();
    await mark({ credit: "full" });
    const byEmp = await marksForPeriod(deps, Date.parse(`${MON}T00:00:00Z`), Date.parse("2026-01-09T00:00:00Z"));
    expect(byEmp.get(AYA.id)?.get(MON)).toBe("full");
  });

  it("leaves out a withdrawn mark and anything outside the window", async () => {
    await seed();
    const row = await mark();
    // Withdrawn is not a mark, the same way a superseded punch is not a punch.
    await deps.db.update(schema.attendanceDayMarks).set({ deleteTime: new Date() }).where(eq(schema.attendanceDayMarks.uuid, row.uuid));
    expect((await marksForPeriod(deps, Date.parse(`${MON}T00:00:00Z`), Date.parse("2026-01-09T00:00:00Z"))).size).toBe(0);
    // And a live one a month later is not this period's business.
    await createDayMark(deps, actor, { employee: `employees/${AYA.id}`, date: "2026-02-02", credit: "half" });
    expect((await marksForPeriod(deps, Date.parse(`${MON}T00:00:00Z`), Date.parse("2026-01-09T00:00:00Z"))).size).toBe(0);
  });
});

describe("the list never widens what the caller may read", () => {
  it("narrows to one employee, and answers empty for one outside the caller's scope", async () => {
    await seed();
    await mark();
    await createDayMark(deps, actor, { employee: `employees/${BEN.id}`, date: MON, credit: "full" });

    expect((await listDayMarks(deps, all(), 100)).items).toHaveLength(2);
    expect((await listDayMarks(deps, all(), 100, undefined, { employeeId: AYA.id })).items).toHaveLength(1);
    // A dept-04 caller asking for Ben, in dept 07: the scope predicate is still ANDed in.
    expect((await listDayMarks(deps, dept("04"), 100, undefined, { employeeId: BEN.id })).items).toEqual([]);
    expect((await listDayMarks(deps, dept("04"), 100)).items).toHaveLength(1);
  });

  it("leaves a withdrawn mark out unless it is asked for", async () => {
    await seed();
    const row = await mark();
    await deps.db.update(schema.attendanceDayMarks).set({ deleteTime: new Date() }).where(eq(schema.attendanceDayMarks.uuid, row.uuid));
    // This list is what the attendance grid draws its badges from. Kept in, a withdrawn mark leaves the badge
    // on a day payroll no longer counts that way - the grid and the money saying different things.
    expect((await listDayMarks(deps, all(), 100)).items).toEqual([]);
    expect((await listDayMarks(deps, all(), 100, undefined, { showDeleted: true })).items).toHaveLength(1);
    expect((await listDayMarks(deps, all(), 100, undefined, { deletedOnly: true })).items).toHaveLength(1);
  });

  it("bounds the list to a day window", async () => {
    await seed();
    await mark();
    await createDayMark(deps, actor, { employee: `employees/${AYA.id}`, date: "2026-02-02", credit: "half" });
    expect((await listDayMarks(deps, all(), 100, undefined, { from: MON, to: "2026-01-09" })).items).toHaveLength(1);
    expect((await listDayMarks(deps, all(), 100, undefined, { from: MON, to: "2026-02-28" })).items).toHaveLength(2);
  });
});
