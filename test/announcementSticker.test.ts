/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import type { ListScope } from "../src/domain/access";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { createAnnouncement, updateAnnouncement, listAnnouncements } from "../src/services/announcements";
import { toAnnouncementResource } from "../src/http/serialize";

// A sticker belongs to the post it was put on. This pins that: editing one post's art (or its placement) must
// leave every other post exactly as it was, both in the row and in what the board serializes.
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

const TABLES = [schema.announcements, schema.notifications, schema.auditLog, schema.eventLog, schema.settings, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

async function seedActor(): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({ uuid: employeeId, code: `04-${genId().slice(0, 3)}`, firstName: "Poster", lastName: "User", workEmail: `${employeeId}@test.example`, status: "active" });
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${uuid}@test.example`, role: "employee", employeeId });
  return { uuid, email: `${uuid}@test.example`, role: "employee", status: "active", employeeId, employeeCode: null } as unknown as AppUser;
}

// The list scope the authz middleware hands a board request: org-wide, and an editor for the drafts here.
const scope: ListScope = { breadth: "all", deptCode: null, ownerId: null, seeRestricted: true };

describe("a post's sticker is its own", () => {
  it("editing one post's art leaves the others untouched", async () => {
    const actor = await seedActor();
    const a = await createAnnouncement(deps, actor, { kind: "post", title: "One", body: "First", illustration: "work-office/hiring" });
    const c = await createAnnouncement(deps, actor, { kind: "post", title: "Three", body: "Third" });
    const bRow = await createAnnouncement(deps, actor, { kind: "post", title: "Two", body: "Second", illustration: "food-drink/pizza-sharing" });

    await updateAnnouncement(deps, actor, bRow.uuid, { illustration: "celebration-recognition/high-five" });

    const { items } = await listAnnouncements(deps, scope, 50);
    const byTitle = Object.fromEntries(items.map((r) => [r.title, r]));
    expect(byTitle.Two!.illustration).toBe("celebration-recognition/high-five");
    expect(byTitle.One!.illustration).toBe("work-office/hiring");
    expect(byTitle.Three!.illustration).toBeNull();
    expect(a.uuid === bRow.uuid || bRow.uuid === c.uuid).toBe(false);
  });

  it("editing one post's placement leaves the others on their own", async () => {
    const actor = await seedActor();
    await createAnnouncement(deps, actor, { kind: "post", title: "Placed", body: "x", illustration: "work-office/hiring", illustration_layout: { x: 0, y: 0, size: 0.3, opacity: 1 } });
    const moved = await createAnnouncement(deps, actor, { kind: "post", title: "Moved", body: "y", illustration: "work-office/hiring" });

    await updateAnnouncement(deps, actor, moved.uuid, { illustration_layout: { x: 1, y: 1, size: 0.6, opacity: 0.4 } });

    const { items } = await listAnnouncements(deps, scope, 50);
    const byTitle = Object.fromEntries(items.map((r) => [r.title, toAnnouncementResource(r)]));
    expect(byTitle.Moved!.illustration_layout).toEqual({ x: 1, y: 1, size: 0.6, opacity: 0.4 });
    expect(byTitle.Placed!.illustration_layout).toEqual({ x: 0, y: 0, size: 0.3, opacity: 1 });
  });

  it("keeps a kudos recipient placement on its own card, and only on a kudos", async () => {
    const giver = await seedActor();
    const other = await seedActor();
    const kudos = await createAnnouncement(deps, giver, { kind: "kudos", recipient: `employees/${other.employeeId}`, message: "Great work", recipient_layout: { x: 0.25, y: 0, size: 0.14 } });
    const post = await createAnnouncement(deps, giver, { kind: "post", title: "Post", body: "x", recipient_layout: { x: 0.9, y: 0.9, size: 0.2 } });

    const { items } = await listAnnouncements(deps, scope, 50);
    const wire = Object.fromEntries(items.map((r) => [r.uuid, toAnnouncementResource(r)]));
    expect(wire[kudos.uuid]!.recipient_layout).toEqual({ x: 0.25, y: 0, size: 0.14 });
    // A post has no recipient block, so the field is neither stored nor serialized for it.
    expect(wire[post.uuid]!.recipient_layout).toBeUndefined();

    await updateAnnouncement(deps, giver, kudos.uuid, { recipient_layout: { x: 1, y: 1, size: 0.3 } });
    const after = (await listAnnouncements(deps, scope, 50)).items.find((r) => r.uuid === kudos.uuid)!;
    expect(toAnnouncementResource(after).recipient_layout).toEqual({ x: 1, y: 1, size: 0.3 });

    // Clearing puts the block back in the card's own column.
    await updateAnnouncement(deps, giver, kudos.uuid, { recipient_layout: null });
    const cleared = (await listAnnouncements(deps, scope, 50)).items.find((r) => r.uuid === kudos.uuid)!;
    expect(toAnnouncementResource(cleared).recipient_layout).toBeUndefined();
  });

  it("serializes each row's own art, not the last one seen", async () => {
    const actor = await seedActor();
    await createAnnouncement(deps, actor, { kind: "post", title: "Art", body: "x", illustration: "work-office/hiring" });
    await createAnnouncement(deps, actor, { kind: "post", title: "Bare", body: "y" });

    const { items } = await listAnnouncements(deps, scope, 50);
    const wire = items.map((r) => toAnnouncementResource(r));
    expect(wire.find((w) => w.title === "Art")!.illustration).toBe("work-office/hiring");
    expect(wire.find((w) => w.title === "Bare")!.illustration).toBeUndefined();
  });
});
