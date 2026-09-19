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
import { createGoal, commentGoal, proposeGoal, requestGoalChanges } from "../src/services/goals";
import { DEFAULT_PERFORMANCE } from "../src/domain/performance";

// Naming somebody in a goal's thread.
//
// The syntax and the parser are `domain/mentions.ts`; the notifying side is `services/mentions.ts`. What this
// file pins is the two doors a goal's thread has, because they are written by two different verbs and only
// one of them was wired up: `:comment` has notified mentions since goal comments existed, and `:requestChanges`
// - whose note is inserted into the SAME comments table and is now composed with the same picker - did not.
// A mention that renders as a chip, links to the person's profile and tells them nothing is worse than no
// mention at all: the author believes they have asked somebody a question.
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
  schema.goalWatchers, schema.goalComments, schema.goals, schema.notifications, schema.eventLog, schema.auditLog,
  schema.users, schema.employees, schema.roles, schema.settings,
];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

async function seedActor(first: string): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({ uuid: employeeId, code: `04-${genId().slice(0, 3)}`, firstName: first, lastName: "User", workEmail: `${employeeId}@test.example`, status: "active" });
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${uuid}@test.example`, role: "employee", employeeId });
  return { uuid, email: `${uuid}@test.example`, role: "employee", status: "active", employeeId, employeeCode: null, name: `${first} User` } as unknown as AppUser;
}

const notifsFor = (employeeId: string) => deps.db.select().from(schema.notifications).where(eq(schema.notifications.recipientId, employeeId));
/** The mention token as the browser writes it: the picked name, and the WIRE id of the person. */
const mention = async (who: AppUser, name: string) => `[@${name}](employees/${await deps.idCodec.encode("employees", who.employeeId!)})`;

describe("@mentions in a goal's thread", () => {
  it("tells the person named in a comment, and links to the goal itself", async () => {
    const owner = await seedActor("Owner");
    const named = await seedActor("Named");
    const goal = await createGoal(deps, owner, { title: "Ship billing" });

    await commentGoal(deps, owner, goal.uuid, `${await mention(named, "Named User")} can you confirm the number?`);

    const got = await notifsFor(named.employeeId!);
    const mentioned = got.filter((n) => n.type === "goal.mention");
    expect(mentioned).toHaveLength(1);
    // The goal, not the wall of them: `goals/<id>` is the page's record route, and the outbound edge rewrites
    // the id segment to a wire token like any other ref.
    expect(mentioned[0]!.link).toBe(`goals/${goal.uuid}`);
  });

  it("tells the person named in a send-back note - the note is a comment on the goal", async () => {
    const owner = await seedActor("Owner");
    const manager = await seedActor("Manager");
    const named = await seedActor("Named");
    // A goal is agreed on the spot unless the org has turned approval on, and only a PROPOSED goal can be
    // sent back - so the handshake has to be switched on for this door to exist at all.
    await deps.db.insert(schema.settings).values({ key: "performance", value: JSON.stringify({ ...DEFAULT_PERFORMANCE, goal_approval: "required" }) });
    const goal = await createGoal(deps, owner, { title: "Cut churn" });
    await proposeGoal(deps, owner, goal.uuid);

    await requestGoalChanges(deps, manager, goal.uuid, `make this measurable - ${await mention(named, "Named User")} has last quarter's figure`);

    const mentioned = (await notifsFor(named.employeeId!)).filter((n) => n.type === "goal.mention");
    expect(mentioned).toHaveLength(1);
    expect(mentioned[0]!.link).toBe(`goals/${goal.uuid}`);
    // The note itself still lands in the thread, mention token and all, so the chip has something to render.
    const comments = await deps.db.select().from(schema.goalComments).where(eq(schema.goalComments.goalId, goal.uuid));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("[@Named User](employees/");
  });

  it("never notifies the author for naming themselves", async () => {
    const owner = await seedActor("Owner");
    const goal = await createGoal(deps, owner, { title: "Solo" });

    await commentGoal(deps, owner, goal.uuid, `noting for myself: ${await mention(owner, "Owner User")}`);

    expect((await notifsFor(owner.employeeId!)).filter((n) => n.type === "goal.mention")).toHaveLength(0);
  });
});
