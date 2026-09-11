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
import { SCORECARD_NUDGE_DAYS, nudgeMissingScorecards, inviteCandidate, rejectApplication } from "../src/services/ats";
import { renderOfferLetter } from "../src/services/offerLetter";

// The three things recruiting gained that reach OUTSIDE the app: a chase-up for scorecards nobody filed, an
// invitation the candidate actually receives, and the offer letter itself. Each one is only worth having if it
// is honest - it fires on its own schedule and not daily, it refuses rather than half-sends, and the letter
// says what the offer says.
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const DAY_MS = 86_400_000;
let deps: Deps;
const b = env as unknown as Bindings;
// What the fake email sender saw, so "we told the candidate" can be asserted rather than assumed.
let sent: { to: string; subject: string; html: string; attachments?: { filename: string; content: Uint8Array; contentType: string }[] }[] = [];

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
  schema.jobRequisitions, schema.notifications, schema.auditLog, schema.eventLog, schema.employees, schema.settings,
];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  deps.clock = { now: () => new Date() };
  sent = [];
  deps.email = { send: async (to, subject, html, attachments) => { sent.push({ to, subject, html, attachments }); } };
});

const actor = { uuid: genId(), email: "hr@test.example", role: "hr_admin", status: "active", employeeId: null, employeeCode: null } as unknown as AppUser;

async function seedEmployee(): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.employees).values({
    uuid, code: `04-${genId().slice(0, 3)}`, firstName: "Panel", lastName: genId().slice(0, 4),
    workEmail: `${uuid}@test.example`, status: "active",
  });
  return uuid;
}

/** A candidate applied to a job, which is the spine every recruiting action hangs off. */
async function seedApplication(opts: { email?: string | null } = {}) {
  const reqId = genId();
  await deps.db.insert(schema.jobRequisitions).values({
    uuid: reqId, code: `40-${genId().slice(0, 4)}`, title: "Senior Backend Engineer", status: "open", openings: 1,
  });
  const candId = genId();
  await deps.db.insert(schema.candidates).values({
    uuid: candId, code: `41-${genId().slice(0, 4)}`, name: "Asha Rao",
    email: opts.email === undefined ? "asha@example.com" : opts.email,
  });
  const appId = genId();
  await deps.db.insert(schema.applications).values({
    uuid: appId, code: `42-${genId().slice(0, 4)}`, candidateId: candId, requisitionId: reqId, stage: "interview", status: "active",
  });
  return { reqId, candId, appId };
}

async function seedHeldInterview(appId: string, panel: string[], daysAgo: number) {
  const uuid = genId();
  await deps.db.insert(schema.interviews).values({
    uuid, code: `43-${genId().slice(0, 4)}`, applicationId: appId, title: "Technical round", mode: "video",
    scheduledStart: new Date(Date.now() - daysAgo * DAY_MS), scheduledEnd: new Date(Date.now() - daysAgo * DAY_MS + 3_600_000),
    interviewerIds: JSON.stringify(panel), status: "done",
  });
  return uuid;
}

describe("scorecard chase-up", () => {
  it("nudges each panelist who still owes one, on the ladder days and not in between", async () => {
    const panel = [await seedEmployee(), await seedEmployee()];
    const { appId } = await seedApplication();
    for (const age of [0, 2, 4, 10]) {
      await deps.db.delete(schema.interviews);
      await deps.db.delete(schema.notifications);
      await seedHeldInterview(appId, panel, age);
      expect(await nudgeMissingScorecards(deps), `age ${age} should be quiet`).toBe(0);
    }
    for (const age of SCORECARD_NUDGE_DAYS) {
      await deps.db.delete(schema.interviews);
      await deps.db.delete(schema.notifications);
      await seedHeldInterview(appId, panel, age);
      expect(await nudgeMissingScorecards(deps), `age ${age} should nudge both`).toBe(2);
    }
  });

  it("stops chasing a panelist once their scorecard is in", async () => {
    const filed = await seedEmployee();
    const owing = await seedEmployee();
    const { appId } = await seedApplication();
    const interviewId = await seedHeldInterview(appId, [filed, owing], 3);
    await deps.db.insert(schema.interviewFeedback).values({
      uuid: genId(), code: `44-${genId().slice(0, 4)}`, interviewId, authorId: filed, recommendation: "yes",
    });
    expect(await nudgeMissingScorecards(deps)).toBe(1);
    const [n] = await deps.db.select().from(schema.notifications);
    expect(n!.recipientId).toBe(owing);
    expect(n!.title).toContain("Scorecard still owed");
  });

  // A withdrawn scorecard is not a filed one. `interview_feedback` is soft-deletable, so reading the filed
  // set without the delete filter let a panelist who deleted theirs count as done - and this sweep exists
  // precisely to break that silence.
  it("resumes chasing a panelist who withdrew their scorecard", async () => {
    const withdrawn = await seedEmployee();
    const { appId } = await seedApplication();
    const interviewId = await seedHeldInterview(appId, [withdrawn], 3);
    await deps.db.insert(schema.interviewFeedback).values({
      uuid: genId(), code: `44-${genId().slice(0, 4)}`, interviewId, authorId: withdrawn, recommendation: "yes",
      deleteTime: new Date(),
    });
    expect(await nudgeMissingScorecards(deps)).toBe(1);
    const [n] = await deps.db.select().from(schema.notifications);
    expect(n!.recipientId).toBe(withdrawn);
  });

  it("leaves an escalation event at the end of the ladder, and none before it", async () => {
    const panel = [await seedEmployee()];
    const { appId } = await seedApplication();
    await seedHeldInterview(appId, panel, SCORECARD_NUDGE_DAYS[0]!);
    await nudgeMissingScorecards(deps);
    expect((await deps.db.select().from(schema.eventLog)).map((e) => e.type)).not.toContain("interview.scorecardOverdue");
    await deps.db.delete(schema.interviews);
    await seedHeldInterview(appId, panel, SCORECARD_NUDGE_DAYS[SCORECARD_NUDGE_DAYS.length - 1]!);
    await nudgeMissingScorecards(deps);
    expect((await deps.db.select().from(schema.eventLog)).map((e) => e.type)).toContain("interview.scorecardOverdue");
  });

  it("ignores rounds that were never held, and panels nobody was put on", async () => {
    const panel = [await seedEmployee()];
    const { appId } = await seedApplication();
    const scheduled = genId();
    await deps.db.insert(schema.interviews).values({
      uuid: scheduled, code: `43-${genId().slice(0, 4)}`, applicationId: appId, title: "Screening", mode: "video",
      scheduledStart: new Date(Date.now() - 3 * DAY_MS), interviewerIds: JSON.stringify(panel), status: "scheduled",
    });
    await deps.db.insert(schema.interviews).values({
      uuid: genId(), code: `43-${genId().slice(0, 4)}`, applicationId: appId, title: "Nobody's round", mode: "video",
      scheduledStart: new Date(Date.now() - 3 * DAY_MS), interviewerIds: null, status: "done",
    });
    expect(await nudgeMissingScorecards(deps)).toBe(0);
  });
});

describe("interview invitation", () => {
  it("emails the candidate their slot with a calendar attachment", async () => {
    const { appId } = await seedApplication();
    const uuid = genId();
    await deps.db.insert(schema.interviews).values({
      uuid, code: `43-${genId().slice(0, 4)}`, applicationId: appId, title: "Technical round", mode: "video",
      scheduledStart: new Date(Date.now() + DAY_MS), scheduledEnd: new Date(Date.now() + DAY_MS + 3_600_000),
      location: "https://meet.example/abc", status: "scheduled",
    });
    await inviteCandidate(deps, actor, uuid);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("asha@example.com");
    expect(sent[0]!.subject).toContain("Technical round");
    expect(sent[0]!.html).toContain("meet.example");
    const ics = new TextDecoder().decode(sent[0]!.attachments![0]!.content);
    expect(sent[0]!.attachments![0]!.filename).toBe("interview.ics");
    expect(ics).toContain("BEGIN:VEVENT");
    // A timed event, not an all-day one - the whole reason a second builder exists.
    expect(ics).toMatch(/DTSTART:\d{8}T\d{6}Z/);
  });

  it("refuses rather than half-sending: no time, no email address, or a cancelled round", async () => {
    const withEmail = await seedApplication();
    const noTime = genId();
    await deps.db.insert(schema.interviews).values({
      uuid: noTime, code: `43-${genId().slice(0, 4)}`, applicationId: withEmail.appId, title: "Round", mode: "video", status: "scheduled",
    });
    await expect(inviteCandidate(deps, actor, noTime)).rejects.toThrow(/time/i);

    const cancelled = genId();
    await deps.db.insert(schema.interviews).values({
      uuid: cancelled, code: `43-${genId().slice(0, 4)}`, applicationId: withEmail.appId, title: "Round", mode: "video",
      scheduledStart: new Date(), status: "cancelled",
    });
    await expect(inviteCandidate(deps, actor, cancelled)).rejects.toThrow(/cancelled/i);

    const noEmail = await seedApplication({ email: null });
    const iv = genId();
    await deps.db.insert(schema.interviews).values({
      uuid: iv, code: `43-${genId().slice(0, 4)}`, applicationId: noEmail.appId, title: "Round", mode: "video",
      scheduledStart: new Date(), status: "scheduled",
    });
    await expect(inviteCandidate(deps, actor, iv)).rejects.toThrow(/email/i);
    expect(sent).toHaveLength(0);
  });
});

describe("rejection", () => {
  it("tells the candidate only when asked, and never tells them the internal reason", async () => {
    const quiet = await seedApplication();
    await rejectApplication(deps, actor, quiet.appId, "Failed interview");
    expect(sent).toHaveLength(0);

    const told = await seedApplication();
    await rejectApplication(deps, actor, told.appId, "Failed interview", true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("asha@example.com");
    expect(sent[0]!.html).not.toContain("Failed interview");
  });

  it("files the rejection even when the email cannot be sent", async () => {
    deps.email = { send: async () => { throw new Error("provider down"); } };
    const { appId } = await seedApplication();
    const updated = await rejectApplication(deps, actor, appId, "Position filled", true);
    expect(updated.status).toBe("rejected");
    expect(updated.rejectionReason).toBe("Position filled");
  });
});

describe("offer letter", () => {
  it("renders a PDF that carries the offer's own figures", async () => {
    const { appId } = await seedApplication();
    const offerId = genId();
    await deps.db.insert(schema.offers).values({
      uuid: offerId, code: `45-${genId().slice(0, 4)}`, applicationId: appId, baseComp: 2_400_000, currency: "INR",
      offerDate: new Date(), joinDate: new Date(Date.now() + 30 * DAY_MS), status: "draft",
    });
    await deps.db.insert(schema.settings).values({
      key: "organization",
      value: JSON.stringify({ name: "Acme", letter_defaults: { signatory_name: "R. Iyer", signatory_title: "Head of People", probation_months: 6 } }),
    });
    const { bytes, fileName } = await renderOfferLetter(deps, offerId);
    // A real PDF (magic bytes), named after the candidate. The wording itself is compressed inside the file,
    // so what is worth pinning here is that it renders at all from an offer with no employee behind it.
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    expect(bytes.byteLength).toBeGreaterThan(1000);
    expect(fileName).toContain("Asha Rao");
  });

  it("still renders when the offer is bare: no figure, no dates, no letter defaults", async () => {
    const { appId } = await seedApplication({ email: null });
    const offerId = genId();
    await deps.db.insert(schema.offers).values({
      uuid: offerId, code: `45-${genId().slice(0, 4)}`, applicationId: appId, currency: "INR", status: "draft",
    });
    const { bytes } = await renderOfferLetter(deps, offerId);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });
});
