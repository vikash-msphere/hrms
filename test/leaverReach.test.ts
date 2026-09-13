/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { activeEmployeeIds, audienceEmployeeIds } from "../src/services/notifications";

// WHO IS STILL HERE - the question every broadcast asks, and the one the org-wide audience got wrong.
//
// `status` and `delete_time` are independent columns. Offboarding stamps `status: "terminated"` and disables
// the login and never stamps `delete_time` (services/transitions.ts); the generic soft delete stamps
// `delete_time` and never touches `status`. The broadcast audience filtered only the second, so every leaver
// the org had ever offboarded stayed in it - and this audience is not just a bell: services/lifecycle.ts mails
// the same list when the author asks for it, and notifications push to registered devices, so a departed
// employee's phone kept buzzing with company announcements.
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

beforeEach(async () => {
  await deps.db.delete(schema.employees);
  await deps.db.delete(schema.departments);
  await deps.db.insert(schema.departments).values({ uuid: DEPT, code: "04", name: "Engineering" });
});

const DEPT = "0000000000dep";
let n = 0;
async function employee(over: Partial<typeof schema.employees.$inferInsert> = {}) {
  const uuid = genId();
  n += 1;
  await deps.db.insert(schema.employees).values({
    uuid,
    code: `04-002-${String(n).padStart(3, "0")}`,
    firstName: "Test",
    lastName: `Person${n}`,
    workEmail: `p${n}@example.com`,
    departmentId: DEPT,
    ...over,
  });
  return uuid;
}

describe("the broadcast audience is people who are still here", () => {
  it("includes a live employee", async () => {
    const live = await employee();
    expect(await activeEmployeeIds(deps)).toEqual([live]);
  });

  it("excludes someone who was OFFBOARDED - the exit that does not touch delete_time", async () => {
    const live = await employee();
    await employee({ status: "terminated", disabled: true, endDate: new Date() });
    expect(await activeEmployeeIds(deps)).toEqual([live]);
  });

  it("excludes someone soft-deleted, and someone whose account was switched off", async () => {
    const live = await employee();
    await employee({ deleteTime: new Date() });
    await employee({ disabled: true });
    expect(await activeEmployeeIds(deps)).toEqual([live]);
  });

  it("applies the same rule to a DEPARTMENT audience, which had the same gap", async () => {
    const live = await employee();
    await employee({ status: "terminated" });
    await employee({ deleteTime: new Date() });
    expect(await audienceEmployeeIds(deps, { kind: "department", department: `departments/${DEPT}` })).toEqual([live]);
    expect(await audienceEmployeeIds(deps, { kind: "everyone" })).toEqual([live]);
  });
});
