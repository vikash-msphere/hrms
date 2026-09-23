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
import { createTicket, attachRecordingToTicket } from "../src/services/tickets";
import { toTicketResource } from "../src/http/serialize";
import { parseRecordings } from "../src/domain/tickets";

// The opt-in Sentry session replay a requester can attach when raising a ticket. The id is rendered as a link
// into a third-party console, so the interesting behaviour is what the server REFUSES to store, not the happy
// path: anything that is not a bare 32-hex replay id would either 404 for support or point them somewhere the
// requester chose.
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const REPLAY = "0123456789abcdef0123456789abcdef";
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

const TABLES = [schema.tickets, schema.accessRules, schema.settings, schema.eventLog, schema.auditLog, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

async function seedRequester(): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({ uuid: employeeId, code: "04-001-001", firstName: "Req", lastName: "T", workEmail: `${employeeId}@t.example`, status: "active" });
  const userUuid = genId();
  await deps.db.insert(schema.users).values({ uuid: userUuid, code: `u-${genId().slice(0, 4)}`, email: `${userUuid}@t.example`, role: "employee", employeeId });
  await deps.db.insert(schema.settings).values({
    key: "ticket-categories",
    value: JSON.stringify({ categories: [{ key: "it", name: "IT support", assignee: null, members: [], department: null }] }),
  });
  return { uuid: userUuid, email: `${userUuid}@t.example`, role: "employee", status: "active", employeeId, employeeCode: null } as unknown as AppUser;
}

describe("ticket session replay", () => {
  it("stores an opted-in replay id and serializes it for support", async () => {
    const actor = await seedRequester();
    const t = await createTicket(deps, actor, { category: "it", subject: "Page went blank", session_replay_id: REPLAY });
    expect(parseRecordings(t.sessionReplaysJson).map((r) => r.id)).toEqual([REPLAY]);
    expect(toTicketResource(t).session_replays?.map((r) => r.id)).toEqual([REPLAY]);
  });

  it("leaves it null when the requester did not opt in", async () => {
    const actor = await seedRequester();
    const t = await createTicket(deps, actor, { category: "it", subject: "No recording" });
    expect(parseRecordings(t.sessionReplaysJson)).toEqual([]);
    // An empty list, not a missing field: "no recordings yet" is a state the UI renders, not an absence.
    expect(toTicketResource(t).session_replays).toEqual([]);
  });

  it("treats an empty string as no recording rather than an invalid one", async () => {
    const actor = await seedRequester();
    const t = await createTicket(deps, actor, { category: "it", subject: "Blank", session_replay_id: "   " });
    expect(parseRecordings(t.sessionReplaysJson)).toEqual([]);
  });

  it("rejects anything that is not a bare 32-hex id", async () => {
    const actor = await seedRequester();
    for (const bad of [
      "https://evil.example/phish", // a URL: the whole point of storing an id, not a link
      `https://msphere-io.sentry.io/replays/${REPLAY}/`, // even the RIGHT console URL is not an id
      REPLAY.slice(0, 31), // truncated
      `${REPLAY}0`, // too long
      REPLAY.toUpperCase(), // Sentry ids are lowercase hex
      "0123456789abcdef0123456789abcdeZ", // right length, not hex
    ]) {
      await expect(createTicket(deps, actor, { category: "it", subject: "Bad id", session_replay_id: bad })).rejects.toThrow(/session_replay_id/);
    }
  });

  // Support's next question is nearly always "can you show me that again?", so a ticket accumulates
  // recordings rather than holding the one that happened to exist when it was raised.
  it("appends later recordings, oldest first", async () => {
    const actor = await seedRequester();
    const t = await createTicket(deps, actor, { category: "it", subject: "Shows twice", session_replay_id: REPLAY });
    const second = "ffffffffffffffffffffffffffffffff";
    const after = await attachRecordingToTicket(deps, actor, t.uuid, second);
    expect(parseRecordings(after.sessionReplaysJson).map((r) => r.id)).toEqual([REPLAY, second]);
    // Stamped with who added it and when, like an attachment - a ticket with three recordings is unreadable
    // without knowing which came from whom.
    expect(parseRecordings(after.sessionReplaysJson)[1]!.by).toBe(actor.employeeId);
  });

  it("is idempotent, so a double-tapped button does not list the same recording twice", async () => {
    const actor = await seedRequester();
    const t = await createTicket(deps, actor, { category: "it", subject: "Once", session_replay_id: REPLAY });
    await attachRecordingToTicket(deps, actor, t.uuid, REPLAY);
    const again = await attachRecordingToTicket(deps, actor, t.uuid, REPLAY);
    expect(parseRecordings(again.sessionReplaysJson).map((r) => r.id)).toEqual([REPLAY]);
  });

  it("refuses a junk id on the later path too", async () => {
    const actor = await seedRequester();
    const t = await createTicket(deps, actor, { category: "it", subject: "Junk later" });
    await expect(attachRecordingToTicket(deps, actor, t.uuid, "https://evil.example/phish")).rejects.toThrow(/session_replay_id/);
  });
});
