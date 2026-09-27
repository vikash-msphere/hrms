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
import { eq } from "drizzle-orm";
import {
  advanceApplication, hireApplication, rejectApplication, updateApplication,
  createOffer, approveOffer, extendOffer, declineOffer,
} from "../src/services/ats";
import { AUTOMATIONS } from "../bootstrap/collections/automations";
import { fieldsForEventType, COMMON_EVENT_FIELDS } from "../src/domain/events";

// The pipeline is only automatable if a transition SAYS ENOUGH for a rule to act on it. A rule can't read the
// database - it templates from the event payload - so "the board emits an event" is worth nothing unless that
// event carries the candidate, the role, the manager and the money. These tests pin exactly that: the payload a
// rule sees, on every transition, and the guard that no seeded rule references a field its trigger doesn't
// carry.
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
  schema.interviewFeedback, schema.interviews, schema.offers, schema.applications, schema.candidates,
  schema.jobRequisitions, schema.payGrades, schema.compensation, schema.notifications, schema.auditLog,
  schema.eventLog, schema.users, schema.employees, schema.settings,
];
const actor = { uuid: genId(), email: "hr@test.example", role: "hr_admin", status: "active", employeeId: null, employeeCode: null } as unknown as AppUser;

beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  deps.clock = { now: () => new Date("2026-03-01T00:00:00Z") };
  // event_log carries audit lineage through an actor FK, so an actor with no users row would have its events
  // dropped (logged, non-fatal) - and these tests read the log.
  // `users.role` is a FK to the roles catalog, so the role has to exist before the actor does. `employee` is
  // there because creating an employee provisions their sign-in account at that role (services/employees.ts).
  await deps.db.insert(schema.roles).values([{ name: "hr_admin", label: "HR admin" }, { name: "employee", label: "Employee", provisioned: true }]).onConflictDoNothing();
  await deps.db.insert(schema.users).values({ uuid: actor.uuid, code: `u-${genId().slice(0, 4)}`, email: actor.email, role: "hr_admin" });
});

/** A role budgeted at a band, a hiring manager on it, and a candidate applied to it. */
async function seedPipeline(opts: { email?: string | null; band?: boolean } = {}) {
  const managerId = genId();
  await deps.db.insert(schema.employees).values({
    uuid: managerId, code: `04-${genId().slice(0, 3)}`, firstName: "Hiring", lastName: "Manager",
    workEmail: `${managerId}@test.example`, status: "active",
  });
  let gradeId: string | null = null;
  if (opts.band !== false) {
    gradeId = genId();
    await deps.db.insert(schema.payGrades).values({
      uuid: gradeId, code: `70-${genId().slice(0, 4)}`, name: "L4", level: 4,
      bandMin: 1_800_000, bandMid: 2_400_000, bandMax: 3_000_000, currency: "INR",
    });
  }
  const reqId = genId();
  await deps.db.insert(schema.jobRequisitions).values({
    uuid: reqId, code: `40-${genId().slice(0, 4)}`, title: "Senior Backend Engineer", status: "open",
    openings: 1, hiringManagerId: managerId, payGradeId: gradeId,
  });
  const candId = genId();
  await deps.db.insert(schema.candidates).values({
    uuid: candId, code: `41-${genId().slice(0, 4)}`, name: "Asha Rao",
    email: opts.email === undefined ? "asha@example.com" : opts.email, source: "referral",
  });
  const appId = genId();
  await deps.db.insert(schema.applications).values({
    uuid: appId, code: `42-${genId().slice(0, 4)}`, candidateId: candId, requisitionId: reqId,
    stage: "interview", status: "active", appliedDate: new Date("2026-02-01T00:00:00Z"),
  });
  return { appId, candId, reqId, managerId, gradeId };
}

/** The payload of the most recent event of a type, as a rule would see it. */
async function payloadOf(type: string): Promise<Record<string, unknown> | null> {
  const rows = await deps.db.select().from(schema.eventLog).where(eq(schema.eventLog.type, type));
  const last = rows.sort((a, b) => +new Date(a.occurredAt) - +new Date(b.occurredAt)).pop();
  return last ? (JSON.parse(last.payloadJson ?? "{}") as Record<string, unknown>) : null;
}

describe("a pipeline transition carries enough for a rule to act on it", () => {
  it("a stage move names the candidate, the role, the manager, the band and the dates", async () => {
    const { appId, candId, reqId, managerId } = await seedPipeline();
    await advanceApplication(deps, actor, appId, "offer");

    const p = await payloadOf("application.stageChanged");
    expect(p).toBeTruthy();
    // Where it came from and where it landed - a rule can tell a genuine advance from a card dragged back.
    expect(p!.previousStage).toBe("interview");
    expect(p!.stage).toBe("offer");
    expect(p!.stageKind).toBe("active");
    // Who and what, so a notification can be addressed and a record titled.
    expect(p!.candidateId).toBe(candId);
    expect(p!.candidateName).toBe("Asha Rao");
    expect(p!.candidateEmail).toBe("asha@example.com");
    expect(p!.requisitionId).toBe(reqId);
    expect(p!.requisitionTitle).toBe("Senior Backend Engineer");
    expect(p!.hiringManagerId).toBe(managerId);
    expect(p!.openings).toBe(1);
    expect(p!.source).toBe("referral");
    // The money, so the offer a rule drafts is priced rather than blank.
    expect(p!.bandMid).toBe(2_400_000);
    expect(p!.offerAmount).toBe(2_400_000); // default policy proposes the midpoint
    expect(p!.currency).toBe("INR");
    // The dates, computed from settings once so no rule body does arithmetic.
    expect(p!.offerDate).toBe("2026-03-01");
    expect(p!.suggestedJoinDate).toBe("2026-03-31"); // +30 days notice
    expect(p!.suggestedExpiryDate).toBe("2026-03-08"); // +7 days validity
  });

  it("leaves the offer figure blank when the requisition has no band, rather than inventing one", async () => {
    const { appId } = await seedPipeline({ band: false });
    await advanceApplication(deps, actor, appId, "offer");
    const p = await payloadOf("application.stageChanged");
    expect(p!.offerAmount).toBeNull();
    expect(p!.bandMid).toBeNull();
    expect(p!.currency).toBe("INR"); // still says which currency, from the org default
  });

  it("honours the org's choice of band point", async () => {
    await deps.db.insert(schema.settings).values({ key: "ats", value: JSON.stringify({ offer_band_point: "min" }) });
    const { appId } = await seedPipeline();
    await advanceApplication(deps, actor, appId, "offer");
    expect((await payloadOf("application.stageChanged"))!.offerAmount).toBe(1_800_000);
  });

  it("announces a rejection, with the reason and whether the candidate was already told", async () => {
    const { appId } = await seedPipeline();
    await rejectApplication(deps, actor, appId, "Position filled", false);
    const p = await payloadOf("application.rejected");
    expect(p!.reason).toBe("Position filled");
    expect(p!.notified).toBe(false);
    expect(p!.candidateName).toBe("Asha Rao");
  });

  it("announces every step of the offer workflow, with its terms", async () => {
    const { appId } = await seedPipeline();
    const offer = await createOffer(deps, actor, { application: `applications/${appId}`, base_comp: 2_400_000, currency_code: "INR", join_date: "2026-04-01" });
    expect((await payloadOf("offer.created"))!.baseComp).toBe(2_400_000);

    await approveOffer(deps, actor, offer.uuid);
    expect((await payloadOf("offer.approved"))!.offerStatus).toBe("approved");

    await extendOffer(deps, actor, offer.uuid);
    const extended = await payloadOf("offer.extended");
    expect(extended!.joinDate).toBe("2026-04-01");
    expect(extended!.candidateName).toBe("Asha Rao"); // the pipeline context rides along

    await declineOffer(deps, actor, offer.uuid);
    expect((await payloadOf("offer.declined"))!.offerStatus).toBe("declined");
  });
});

describe("hiring off the board is real, and happens once", () => {
  it("converts the candidate, stamps the application, and announces the hire", async () => {
    const { appId, candId } = await seedPipeline();
    const hired = await hireApplication(deps, actor, appId);

    expect(hired.status).toBe("hired");
    expect(hired.hiredEmployeeId).toBeTruthy();
    const emp = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, hired.hiredEmployeeId!)))[0]!;
    expect(emp.workEmail).toBe("asha@example.com");
    expect(emp.firstName).toBe("Asha");
    expect(emp.lastName).toBe("Rao");

    const p = await payloadOf("application.hired");
    expect(p!.candidateId).toBe(candId);
    expect(p!.viaOffer).toBe(false);
  });

  it("is idempotent: hiring twice yields one employee and one hire event", async () => {
    const { appId } = await seedPipeline();
    const first = await hireApplication(deps, actor, appId);
    const again = await hireApplication(deps, actor, appId);
    expect(again.hiredEmployeeId).toBe(first.hiredEmployeeId);
    expect((await deps.db.select().from(schema.employees)).length).toBe(2); // the hiring manager + the one hire
    const hires = (await deps.db.select().from(schema.eventLog)).filter((e) => e.type === "application.hired");
    expect(hires.length).toBe(1);
  });

  it("adopts an employee who already exists on that email instead of creating a second person", async () => {
    const { appId } = await seedPipeline();
    const existing = genId();
    await deps.db.insert(schema.employees).values({
      uuid: existing, code: `04-${genId().slice(0, 3)}`, firstName: "Asha", lastName: "Rao",
      workEmail: "asha@example.com", status: "active",
    });
    const hired = await hireApplication(deps, actor, appId);
    expect(hired.hiredEmployeeId).toBe(existing);
  });

  it("refuses a candidate with no email rather than creating a nameless account", async () => {
    const { appId } = await seedPipeline({ email: null });
    await expect(hireApplication(deps, actor, appId)).rejects.toThrow(/email/i);
  });

  it("refuses to hire an application that was rejected", async () => {
    const { appId } = await seedPipeline();
    await rejectApplication(deps, actor, appId);
    await expect(hireApplication(deps, actor, appId)).rejects.toThrow(/rejected/);
  });

  it("a withdrawal is not a hire", async () => {
    const { appId } = await seedPipeline();
    await updateApplication(deps, actor, appId, { status: "withdrawn" });
    await expect(hireApplication(deps, actor, appId)).rejects.toThrow(/withdrawn/);
  });
});

// A seeded rule that templates {{somethingElse}} renders an empty string and fails silently at run time - the
// offer gets drafted with no figure and nobody knows why. This is the guard: every placeholder in every seeded
// rule must name a field its trigger event actually carries.
describe("seeded rules only reference fields their trigger carries", () => {
  const ALWAYS = new Set([
    ...COMMON_EVENT_FIELDS.map((f) => f.name),
    "type", "now", "today", "payload", "results",
  ]);
  const placeholders = (v: unknown, out: string[] = []): string[] => {
    if (typeof v === "string") for (const m of v.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) out.push(m[1]!.trim());
    else if (Array.isArray(v)) v.forEach((x) => placeholders(x, out));
    else if (v && typeof v === "object") Object.values(v).forEach((x) => placeholders(x, out));
    return out;
  };

  for (const rule of AUTOMATIONS) {
    it(`"${rule.name}" templates only declared fields`, () => {
      // A waitFor arm's continuation runs against the ARM's event, so gather each action list with its own
      // trigger rather than checking everything against the rule's.
      const scopes: { trigger: string; actions: unknown }[] = [];
      const walk = (actions: unknown[], trigger: string) => {
        scopes.push({ trigger, actions: actions.filter((a) => (a as { kind?: string }).kind !== "waitFor" && (a as { kind?: string }).kind !== "wait") });
        for (const a of actions as { kind?: string; on?: { event?: string; then: unknown[] }[]; then?: unknown[] }[]) {
          if (a.kind === "waitFor") for (const arm of a.on ?? []) walk(arm.then, arm.event ?? trigger);
          if (a.kind === "wait") walk(a.then ?? [], trigger);
        }
      };
      walk(rule.actions as unknown[], rule.trigger);

      const unknownFields: string[] = [];
      for (const scope of scopes) {
        const declared = new Set(fieldsForEventType(scope.trigger).map((f) => f.name));
        for (const p of placeholders(scope.actions)) {
          const root = p.split(".")[0]!;
          if (ALWAYS.has(root) || declared.has(root)) continue;
          unknownFields.push(`${scope.trigger}: {{${p}}}`);
        }
      }
      expect(unknownFields).toEqual([]);
    });
  }
});
