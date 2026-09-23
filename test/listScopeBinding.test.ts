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
import { listBoards } from "../src/services/boards";
import { listSprints } from "../src/services/sprints";
import { listReviewCycles } from "../src/services/reviewCycles";
import { listApiKeys } from "../src/services/apiKeys";

// Four collections whose route-level `list` hook took the actor and IGNORED it (`_actor`), reading the whole
// table and paging it in JS. The breadth was the lesser half of what that skipped: the authz middleware
// resolves the caller's per-object shares and DENIES onto `scope` for EVERY collection-level list, and
// `applyScope` is the only thing in the app that binds them - so a per-object deny on a board, a sprint, a
// review cycle or an API key simply evaporated on the list, which is the one direction that leaks.
//
// Asserted against a real D1 through the services themselves rather than over `applyScope` (test/listScope.ts
// already pins that): what regressed here was a CALL SITE, and only a call-site test notices a call site that
// stops passing its scope.
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

const TABLES = [schema.sprints, schema.boards, schema.reviewCycles, schema.apiKeys, schema.users];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

const actor = { uuid: "u1", email: "a@test.example", role: "employee", status: "active" } as unknown as AppUser;
const scope = (s: Partial<ListScope>): ListScope => ({ breadth: "all", deptCode: null, ownerId: null, seeRestricted: false, ...s });
const codes = (r: { items: { code: string | null }[] }) => r.items.map((i) => i.code).sort();

/** The four lists, each seeded with two rows whose codes are `a` and `b`, behind one uniform call. */
const LISTS = [
  {
    name: "boards",
    seed: async () => {
      for (const code of ["a", "b"]) await deps.db.insert(schema.boards).values({ uuid: genId(), code, name: `board ${code}` });
    },
    run: (s: ListScope | undefined) => listBoards(deps, actor, s, 50),
  },
  {
    name: "sprints",
    seed: async () => {
      const boardId = genId();
      await deps.db.insert(schema.boards).values({ uuid: boardId, code: "brd", name: "board" });
      for (const code of ["a", "b"]) await deps.db.insert(schema.sprints).values({ uuid: genId(), code, boardId, name: `sprint ${code}` });
    },
    run: (s: ListScope | undefined) => listSprints(deps, actor, s, 50),
  },
  {
    name: "review-cycles",
    seed: async () => {
      for (const code of ["a", "b"]) await deps.db.insert(schema.reviewCycles).values({ uuid: genId(), code, name: `cycle ${code}` });
    },
    run: (s: ListScope | undefined) => listReviewCycles(deps, actor, s, 50),
  },
  {
    name: "api-keys",
    seed: async () => {
      const ownerUserId = genId();
      await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
      await deps.db.insert(schema.users).values({ uuid: ownerUserId, code: "u-1", email: "owner@test.example", role: "employee" });
      for (const code of ["a", "b"]) {
        await deps.db.insert(schema.apiKeys).values({ uuid: genId(), code, name: `key ${code}`, ownerUserId, prefix: `hrms_${code}`, hash: "x", scopeJson: "{}" });
      }
    },
    run: (s: ListScope | undefined) => listApiKeys(deps, actor, s, 50),
  },
];

describe.each(LISTS)("$name list binds the caller's scope", ({ seed, run }) => {
  it("an UNSET scope yields no rows, never the whole table (fail closed)", async () => {
    await seed();
    expect((await run(undefined)).items).toEqual([]);
  });

  it("breadth 'all' lists everything", async () => {
    await seed();
    expect(codes(await run(scope({})))).toEqual(["a", "b"]);
  });

  // The one that regressed. A deny applies even against 'all' breadth (deny-wins), and it is carried on the
  // scope - so a list that drops the scope drops the deny with it and shows the row anyway.
  it("a per-object DENY removes the row even at 'all' breadth", async () => {
    await seed();
    expect(codes(await run(scope({ denies: ["b"] })))).toEqual(["a"]);
  });

  it("breadth 'own' on a collection with no owner column yields nothing", async () => {
    await seed();
    expect((await run(scope({ breadth: "own", ownerId: "u1" }))).items).toEqual([]);
  });
});
