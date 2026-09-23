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
import { createTicket, attachToTicket, detachFromTicket, readTicketAttachment } from "../src/services/tickets";
import { toTicketResource } from "../src/http/serialize";
import { MAX_TICKET_ATTACHMENTS } from "../src/domain/ticketAttachments";

// A support ticket takes files, because a screenshot is usually the bug report. The bytes go to R2 (encrypted
// by the document store) and only the metadata is on the row - so what is tested here is that the key is
// server-made, the bytes come back through the ticket's own verb, a key from nowhere opens nothing, and a
// detach takes the object with it.
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

const TABLES = [schema.tickets, schema.accessRules, schema.settings, schema.eventLog, schema.auditLog, schema.notifications, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

async function seedRequester(): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({ uuid: employeeId, code: "05-001-001", firstName: "Req", lastName: "T", workEmail: `${employeeId}@t.example`, status: "active" });
  const userUuid = genId();
  await deps.db.insert(schema.users).values({ uuid: userUuid, code: `u-${genId().slice(0, 4)}`, email: `${userUuid}@t.example`, role: "employee", employeeId });
  await deps.db.insert(schema.settings).values({
    key: "ticket-categories",
    value: JSON.stringify({ categories: [{ key: "it", name: "IT support", assignee: null, members: [], department: null }] }),
  });
  return { uuid: userUuid, email: `${userUuid}@t.example`, role: "employee", status: "active", employeeId, employeeCode: null } as unknown as AppUser;
}

const png = (n = 8) => new Uint8Array(Array.from({ length: n }, (_, i) => i)).buffer;

describe("ticket attachments", () => {
  it("attaches a file, keeps only metadata on the row, and hands the bytes back through the ticket", async () => {
    const actor = await seedRequester();
    const t = await createTicket(deps, actor, { category: "it", subject: "Login screen is blank" });
    const after = await attachToTicket(deps, actor, t.uuid, png(16), { fileName: "screenshot.png", contentType: "image/png" });

    const wire = toTicketResource(after);
    expect(wire.attachments).toHaveLength(1);
    const a = wire.attachments![0]!;
    expect(a.name).toBe("screenshot.png");
    expect(a.content_type).toBe("image/png");
    expect(a.size_bytes).toBe(16);
    // The key is the server's, under this ticket, and is never the client's file name.
    expect(a.key!.startsWith(`tickets/${t.uuid}/`)).toBe(true);

    const fetched = await readTicketAttachment(deps, actor, t.uuid, a.key);
    expect(new Uint8Array(fetched.bytes)).toEqual(new Uint8Array(png(16)));
    expect(fetched.fileName).toBe("screenshot.png");
  });

  it("refuses a key that isn't on this ticket, so a key alone opens nothing", async () => {
    const actor = await seedRequester();
    const mine = await createTicket(deps, actor, { category: "it", subject: "Mine" });
    const other = await createTicket(deps, actor, { category: "it", subject: "Other" });
    const attached = await attachToTicket(deps, actor, other.uuid, png(), { fileName: "other.png", contentType: "image/png" });
    const key = toTicketResource(attached).attachments![0]!.key!;

    await expect(readTicketAttachment(deps, actor, mine.uuid, key)).rejects.toThrow(/attachment not found/i);
    await expect(detachFromTicket(deps, actor, mine.uuid, key)).rejects.toThrow(/attachment not found/i);
  });

  it("detach removes the row entry and the stored object", async () => {
    const actor = await seedRequester();
    const t = await createTicket(deps, actor, { category: "it", subject: "Printer" });
    const attached = await attachToTicket(deps, actor, t.uuid, png(), { fileName: "log.txt", contentType: "text/plain" });
    const key = toTicketResource(attached).attachments![0]!.key!;

    const after = await detachFromTicket(deps, actor, t.uuid, key);
    expect(toTicketResource(after).attachments).toHaveLength(0);
    expect(await deps.docs.get(key)).toBeNull();
  });

  // Two people attaching at the same moment - a screenshot each, on the same ticket. The list lives in one JSON
  // column, so an unguarded read-modify-write wrote the loser's entry away: an attachment the ticket never
  // showed, with its bytes left in R2 for nobody.
  it("keeps both files when two uploads land at once", async () => {
    const actor = await seedRequester();
    const t = await createTicket(deps, actor, { category: "it", subject: "Two screenshots" });
    await Promise.all([
      attachToTicket(deps, actor, t.uuid, png(8), { fileName: "one.png", contentType: "image/png" }),
      attachToTicket(deps, actor, t.uuid, png(16), { fileName: "two.png", contentType: "image/png" }),
    ]);
    const row = (await deps.db.select().from(schema.tickets).where(eq(schema.tickets.uuid, t.uuid)).limit(1))[0]!;
    const names = toTicketResource(row).attachments!.map((a) => a.name).sort();
    expect(names).toEqual(["one.png", "two.png"]);
  });

  it("rejects a type the app never serves and caps how many one ticket carries", async () => {
    const actor = await seedRequester();
    const t = await createTicket(deps, actor, { category: "it", subject: "Odd file" });
    // SVG is refused outright everywhere in the app (inline script / stored-XSS vector).
    await expect(attachToTicket(deps, actor, t.uuid, png(), { fileName: "logo.svg", contentType: "image/svg+xml" })).rejects.toThrow(/unsupported file type/i);

    for (let i = 0; i < MAX_TICKET_ATTACHMENTS; i++) {
      await attachToTicket(deps, actor, t.uuid, png(), { fileName: `shot-${i}.png`, contentType: "image/png" });
    }
    await expect(attachToTicket(deps, actor, t.uuid, png(), { fileName: "one-too-many.png", contentType: "image/png" }))
      .rejects.toThrow(new RegExp(`${MAX_TICKET_ATTACHMENTS} attachments`));
  });
});
