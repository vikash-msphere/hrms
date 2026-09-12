/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { app } from "../src/index";
import { makeDeps, type Deps } from "../src/deps";
import * as schema from "../src/db/schema";
import { genId } from "../src/lib/idCodec";
import { isUserEmailCollision, isUserEmployeeCollision } from "../src/lib/errors";
import type { Bindings } from "../src/env";

// FIRST-LOGIN PROVISIONING WHEN THE DATA DOES NOT LINE UP.
//
// The auth middleware mints a `users` row for a caller it has never seen and links it to the employee holding
// the same work email. Two things can be true of the database at that moment that the happy path does not
// describe, and both used to end in a 500 or in an arbitrary answer:
//
//   1. that employee is ALREADY linked to a different account (`users_employee_idx`), and
//   2. two rows match the caller case-insensitively (`users.email` is UNIQUE on the RAW column).
//
// Neither is a race, so neither self-heals: whatever the request answers, it answers again on the next one and
// on every one after that. These pin both answers.

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const b = env as unknown as Bindings;
let deps: Deps;

const migrations = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** The local dev lane: no JWT, no cookie - the middleware takes this address as the caller and goes straight to
 *  the lookup/provision path under test. Per-request rather than mutated onto the shared bindings, so each case
 *  names its own caller. */
const asEmail = (email: string) =>
  app.request(
    "/v1/users/me",
    { headers: { "X-Requested-By": "hrms-spa" } },
    {
      ...(b as unknown as Record<string, unknown>),
      DEV_FAKE_EMAIL: email,
      ALLOW_DEV_AUTH: "true",
      // The provisioning perimeter, set so these cases reach the collision under test rather than being turned
      // away at the domain gate above it.
      ALLOWED_EMAIL_DOMAINS: "test.example",
    } as unknown as Bindings,
  );

const problemOf = async (res: Response) => (await res.json()) as { detail?: string; title?: string };

beforeAll(async () => {
  (b as unknown as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as unknown as Record<string, unknown>).WIRE_ID_KEY = KEY;
  const sql = Object.keys(migrations).sort().map((k) => migrations[k]).join("\n");
  for (const stmt of sql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run().catch(() => {}); // tables may already exist from another suite
  }
  deps = makeDeps(b);
});

beforeEach(async () => {
  await deps.db.delete(schema.users);
  await deps.db.delete(schema.employees);
  await deps.db.delete(schema.codeSequences);
  await deps.db.insert(schema.roles).values([{ name: "employee", label: "Employee" }]).onConflictDoNothing();
});

describe("first login when the employee already has a different account", () => {
  // How the database gets into this shape, with no bug anywhere along the way: `syncAccountEmail`
  // (services/employees.ts) deliberately declines to move a linked account onto an address another account
  // already holds. Point employee E at a taken address, then free that address by editing the OTHER employee,
  // and E now names a work email no account carries while E itself is still linked to its old account.
  const setUp = async () => {
    const employeeId = genId();
    await deps.db.insert(schema.employees).values({
      uuid: employeeId,
      code: "01-001",
      firstName: "Nikhil",
      lastName: "Rao",
      workEmail: "nikhil@test.example", // the address the person actually signs in with
    });
    // The account that holds the link - under a DIFFERENT address, so the sign-in below finds no user row.
    await deps.db.insert(schema.users).values({
      uuid: genId(),
      code: "u-1",
      email: "n.rao@test.example",
      role: "employee",
      employeeId,
    });
    return employeeId;
  };

  // WHY THE OLD CODE ANSWERED 500, asserted on the real database error rather than on the story about it: the
  // insert provisioning is about to make fails on `users.employee_id`, which `isUserEmailCollision` does not
  // match - so the only branch that existed rethrew, and errorHandler's catch-all turned it into an Internal
  // Server Error. If these two classifications ever swap, the middleware's branch order is wrong and this says
  // so before the lockout does.
  it("raises an employee-link collision, which is NOT the email collision the race path handles", async () => {
    const employeeId = await setUp();
    const err = await deps.db
      .insert(schema.users)
      .values({ uuid: genId(), code: "u-2", email: "nikhil@test.example", role: "employee", employeeId })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeTruthy();
    expect(isUserEmployeeCollision(err)).toBe(true);
    expect(isUserEmailCollision(err)).toBe(false);
  });

  it("refuses in words instead of answering 500", async () => {
    await setUp();
    const res = await asEmail("nikhil@test.example");
    // The insert trips `users_employee_idx`, not `users.email`. Unrecognised, that reached the catch-all and
    // told the person the server had crashed - on a request that is in fact a data conflict only HR can fix.
    expect(res.status).toBe(403);
    expect((await problemOf(res)).detail).toMatch(/different sign-in account/i);
  });

  it("mints no account at all, so the refusal is stable rather than half-applied", async () => {
    await setUp();
    await asEmail("nikhil@test.example");
    await asEmail("nikhil@test.example");
    // Still only the pre-existing account: a partially-provisioned second row would put this person outside
    // every self-scoped grant (they match by employee CODE) - an empty app with no error, which is harder to
    // diagnose than the refusal above.
    const users = await deps.db.select().from(schema.users);
    expect(users.length).toBe(1);
    expect(users[0]!.email).toBe("n.rao@test.example");
  });

  it("lets the same person in once the link is corrected", async () => {
    const employeeId = await setUp();
    expect((await asEmail("nikhil@test.example")).status).toBe(403);
    // HR unlinks the wrong account (PATCH /v1/users/{id} employee:null).
    await deps.db.update(schema.users).set({ employeeId: null }).where(eq(schema.users.employeeId, employeeId));
    const res = await asEmail("nikhil@test.example");
    // Not a 401/403 from AUTH any more. The caller holds no grants, so authz still refuses `users.me.read` -
    // what is under test is that provisioning succeeded, which the new row proves.
    expect((await problemOf(res)).detail ?? "").not.toMatch(/different sign-in account/i);
    const provisioned = (await deps.db.select().from(schema.users).where(eq(schema.users.email, "nikhil@test.example")))[0];
    expect(provisioned?.employeeId).toBe(employeeId);
  });
});

describe("two accounts that differ only in case", () => {
  // `users.email` is UNIQUE on the RAW column, so `Zed@…` and `ZED@…` can both exist - the middleware's own
  // comment says so, which is why the case-insensitive second lookup is there at all. What it did not do was
  // ORDER, so which of the two a person signed in to was whatever the engine returned first, and the two rows
  // carry different roles and different access rules.
  //
  // The tie is broken by age. To observe WHICH row was adopted without depending on any grant, the older one
  // is disabled: the middleware refuses a disabled account by name, so the refusal itself names the winner.
  it("adopts the oldest row, deterministically", async () => {
    const old = new Date(1_700_000_000_000);
    const recent = new Date(1_800_000_000_000);
    await deps.db.insert(schema.users).values([
      { uuid: genId(), code: "u-1", email: "Zed@test.example", role: "employee", status: "disabled", createdAt: old },
      { uuid: genId(), code: "u-2", email: "ZED@test.example", role: "employee", status: "active", createdAt: recent },
    ]);
    // Every lane lowercases before looking up, so neither row is an exact match and the fallback decides.
    const res = await asEmail("zed@test.example");
    expect(res.status).toBe(403);
    expect((await problemOf(res)).detail).toBe("user disabled");
    // And nothing was provisioned on top of them - the whole point of the fallback.
    expect((await deps.db.select().from(schema.users)).length).toBe(2);
  });

  it("gives the same answer on every request, not a different one per read", async () => {
    const old = new Date(1_700_000_000_000);
    const recent = new Date(1_800_000_000_000);
    await deps.db.insert(schema.users).values([
      { uuid: genId(), code: "u-1", email: "Ira@test.example", role: "employee", status: "disabled", createdAt: old },
      { uuid: genId(), code: "u-2", email: "IRA@test.example", role: "employee", status: "active", createdAt: recent },
    ]);
    for (let i = 0; i < 5; i++) {
      expect((await problemOf(await asEmail("ira@test.example"))).detail).toBe("user disabled");
    }
  });
});
