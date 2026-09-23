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
import { createTicket, commentTicket, transitionTicket } from "../src/services/tickets";

// `tickets.first_response_at` and `tickets.resolved_at` are what turn the queue into a service report, and
// both are STAMPS rather than derivations - so what they promise has to be pinned where it is written, not
// inferred later from a comment thread nobody reads per row.
//
// The two rules that are easy to get wrong, and are the reason this file exists:
//   - the requester chasing their own ticket is NOT a first response. Counting it would report near-zero
//     response times on exactly the tickets nobody has looked at, which is the opposite of the truth.
//   - `resolved_at` follows the state instead of latching. A reopened ticket carrying the date it was wrongly
//     closed is a ticket that reads as done while somebody is still waiting on it.
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

const TABLES = [schema.ticketComments, schema.ticketTodos, schema.tickets, schema.accessRules, schema.settings, schema.eventLog, schema.auditLog, schema.notifications, schema.users, schema.employees, schema.departments, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

// A requester and an agent, each with a login, and the one category a ticket has to name. The category
// deliberately configures no assignee and no department: routing is another file's subject, and neither has
// any bearing on the two clocks.
type World = { requester: AppUser; agent: AppUser };
async function seedWorld(): Promise<World> {
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  await deps.db.insert(schema.settings).values({
    key: "ticket-categories",
    value: JSON.stringify({ categories: [{ key: "it", name: "IT support", assignee: null, members: [], department: null }] }),
  });
  const mk = async (code: string, first: string): Promise<AppUser> => {
    const employeeId = genId();
    await deps.db.insert(schema.employees).values({ uuid: employeeId, code, firstName: first, lastName: "T", workEmail: `${employeeId}@t.example`, status: "active" });
    const uuid = genId();
    await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${employeeId}@t.example`, role: "employee", employeeId });
    return { uuid, email: `${employeeId}@t.example`, role: "employee", status: "active", employeeId, employeeCode: code } as unknown as AppUser;
  };
  return { requester: await mk("04-001-001", "Req"), agent: await mk("04-002-001", "Agent") };
}

const read = (id: string) => deps.db.select().from(schema.tickets).where(eq(schema.tickets.uuid, id)).limit(1).then((r) => r[0]!);
/** A ticket raised by the requester. The category is required by the service and is otherwise incidental here. */
const raise = (w: World, subject: string) => createTicket(deps, w.requester, { category: "it", subject });

describe("ticket first-response clock", () => {
  it("is empty on a new ticket", async () => {
    const w = await seedWorld();
    const t = await raise(w, "Laptop dead");
    expect((await read(t.uuid)).firstResponseAt).toBeNull();
  });

  it("does not start when the requester comments on their own ticket", async () => {
    const w = await seedWorld();
    const t = await raise(w, "Laptop dead");
    await commentTicket(deps, w.requester, t.uuid, "any update on this?");
    // Chasing is not an answer. If this stamped, the queue would report its best response time on the tickets
    // it has ignored longest.
    expect((await read(t.uuid)).firstResponseAt).toBeNull();
  });

  it("starts on the first comment by anybody else", async () => {
    const w = await seedWorld();
    const t = await raise(w, "Laptop dead");
    await commentTicket(deps, w.agent, t.uuid, "looking now");
    expect((await read(t.uuid)).firstResponseAt).not.toBeNull();
  });

  it("is claimed once and never moved by a later reply", async () => {
    const w = await seedWorld();
    const t = await raise(w, "Laptop dead");
    await commentTicket(deps, w.agent, t.uuid, "looking now");
    const first = +new Date((await read(t.uuid)).firstResponseAt!);
    await commentTicket(deps, w.requester, t.uuid, "thanks");
    await commentTicket(deps, w.agent, t.uuid, "replacement ordered");
    // A second answer is not a first one - otherwise a long thread reports the response time of its last message.
    expect(+new Date((await read(t.uuid)).firstResponseAt!)).toBe(first);
  });

  it("still starts when the requester chased first", async () => {
    const w = await seedWorld();
    const t = await raise(w, "Laptop dead");
    await commentTicket(deps, w.requester, t.uuid, "bumping this");
    expect((await read(t.uuid)).firstResponseAt).toBeNull();
    await commentTicket(deps, w.agent, t.uuid, "sorry - on it");
    expect((await read(t.uuid)).firstResponseAt).not.toBeNull();
  });
});

describe("ticket resolution clock", () => {
  it("is stamped by :resolve", async () => {
    const w = await seedWorld();
    const t = await raise(w, "Laptop dead");
    await transitionTicket(deps, w.agent, t.uuid, "resolve");
    expect((await read(t.uuid)).resolvedAt).not.toBeNull();
  });

  it("survives :close - closing is filing, not a second resolution", async () => {
    const w = await seedWorld();
    const t = await raise(w, "Laptop dead");
    await transitionTicket(deps, w.agent, t.uuid, "resolve");
    const at = +new Date((await read(t.uuid)).resolvedAt!);
    await transitionTicket(deps, w.agent, t.uuid, "close");
    expect(+new Date((await read(t.uuid)).resolvedAt!)).toBe(at);
  });

  it("stays empty on a ticket closed straight from the queue", async () => {
    const w = await seedWorld();
    const t = await raise(w, "Duplicate of #12");
    await transitionTicket(deps, w.agent, t.uuid, "close");
    // Nothing was resolved, so there is no time-to-resolve. A stamp here would price work never done.
    expect((await read(t.uuid)).resolvedAt).toBeNull();
  });

  it("is cleared by :reopen, so a reopened ticket is honestly unresolved", async () => {
    const w = await seedWorld();
    const t = await raise(w, "Laptop dead");
    await transitionTicket(deps, w.agent, t.uuid, "resolve");
    await transitionTicket(deps, w.agent, t.uuid, "reopen");
    expect((await read(t.uuid)).resolvedAt).toBeNull();
  });

  it("reports the SECOND resolution after a reopen, not the first", async () => {
    const w = await seedWorld();
    const t = await raise(w, "Laptop dead");
    await transitionTicket(deps, w.agent, t.uuid, "resolve");
    const first = +new Date((await read(t.uuid)).resolvedAt!);
    await transitionTicket(deps, w.agent, t.uuid, "reopen");
    await new Promise((r) => setTimeout(r, 5)); // so the two stamps are distinguishable
    await transitionTicket(deps, w.agent, t.uuid, "resolve");
    const second = +new Date((await read(t.uuid)).resolvedAt!);
    // "Is this done, and since when" is answered by the resolution in force, not the one that did not hold.
    expect(second).toBeGreaterThan(first);
  });

  it("is cleared by :cancel - a cancelled ticket was never resolved", async () => {
    const w = await seedWorld();
    const t = await raise(w, "Never mind");
    await transitionTicket(deps, w.agent, t.uuid, "cancel");
    expect((await read(t.uuid)).resolvedAt).toBeNull();
  });
});
