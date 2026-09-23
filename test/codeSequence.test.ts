/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { allocFlatCode, allocFlatCodes, allocUnderDept, CODE_WIDTH } from "../src/services/codeAlloc";

// Allocation reads a COUNTER, not the scope.
//
// It used to read every sibling code to find the max. That is fine on a bounded table and ruinous on an
// append-only one - `event_log` is written by essentially every action and is never pruned, so composing one
// code came to mean reading every event ever recorded, per action, on a platform that bills rows read. The
// counter (schema `code_sequences`) makes it one indexed statement instead.
//
// What these pin is the pair of properties that has to hold for that to be a safe swap: the counter picks up
// from whatever a scope already holds the first time it is touched (so it can be introduced over a database
// that already has rows), and after that it no longer consults the scope at all.
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
  await deps.db.delete(schema.assetCategories);
  await deps.db.delete(schema.employees); // before departments: employees.department_id references them
  await deps.db.delete(schema.departments);
  await deps.db.delete(schema.codeSequences);
});

const addCategory = (code: string, name: string) => deps.db.insert(schema.assetCategories).values({ code, name, tagCode: name.slice(0, 3).toUpperCase() });

describe("code allocation runs off a counter, not a scan of the scope", () => {
  it("starts a fresh namespace at the first code", async () => {
    expect(await allocFlatCode(deps, schema.assetCategories)).toBe("00");
  });

  it("picks up from the codes a scope already holds, so it can be introduced over a live database", async () => {
    // What a seeded database looks like: rows whose codes this counter has never seen.
    await addCategory("00", "Laptops");
    await addCategory("01", "Monitors");
    await addCategory("02", "Phones");
    expect(await allocFlatCode(deps, schema.assetCategories)).toBe("03");
  });

  it("does not read the scope again once the counter exists", async () => {
    await addCategory("00", "Laptops");
    await addCategory("01", "Monitors");
    expect(await allocFlatCode(deps, schema.assetCategories)).toBe("02"); // seeds the counter from the rows
    // Emptying the table would send a scan-based allocator back to "00". The counter does not look, so the
    // sequence carries on - which is the whole point, and the only way to prove it from out here.
    await deps.db.delete(schema.assetCategories);
    expect(await allocFlatCode(deps, schema.assetCategories)).toBe("03");
  });

  it("never hands the same code to two creates that ask at the same moment", async () => {
    await addCategory("00", "Laptops");
    const codes = await Promise.all(Array.from({ length: 8 }, () => allocFlatCode(deps, schema.assetCategories)));
    expect(new Set(codes).size, `duplicate code among ${codes.join(", ")}`).toBe(8);
    expect(codes).not.toContain("00"); // and none of them re-uses what was already stored
  });

  it("reserves a run of consecutive codes in one go, for a create that makes many rows", async () => {
    await addCategory("00", "Laptops");
    expect(await allocFlatCodes(deps, schema.assetCategories, 3)).toEqual(["01", "02", "03"]);
    // The next single allocation continues past the whole reserved run rather than re-using any of it.
    expect(await allocFlatCode(deps, schema.assetCategories)).toBe("04");
  });

  it("is not taken down by one unreadable code already in the scope", async () => {
    // `i` is not in the Crockford alphabet. A stored code containing one used to throw out of the allocator
    // and fail EVERY create in the collection - which is what a base36 seed did to holidays once. It is
    // skipped now: it cannot be the max of a well-formed run, and the unique index still guards the result.
    await addCategory("00", "Laptops");
    await addCategory("0i", "Imported");
    expect(await allocFlatCode(deps, schema.assetCategories)).toBe("01");
  });
});

// The HIERARCHY's allocator, which was the last one still scanning its scope.
//
// A department's children - its sub-departments AND its employees - share one child-segment sequence, and the
// `code` those compose IS the authz scope key. Under `max(surviving siblings) + 1` the sequence went BACKWARDS
// the moment a holder stopped surviving, which for a hard-purgeable collection means a code can be minted
// twice for two different objects. Nothing sweeps `access_rules` by `scope_code`, so the second object
// inherited whatever the first had been granted.
describe("the department child namespace: one counter for sub-departments and employees", () => {
  const addDept = async (code: string, name: string, parentId?: string) =>
    (await deps.db.insert(schema.departments).values({ code, name, parentId: parentId ?? null }).returning())[0]!;
  const addEmp = (code: string, departmentId: string | null) =>
    deps.db.insert(schema.employees).values({ code, firstName: "Test", lastName: "User", workEmail: `${code}@test.example`, departmentId });

  it("starts a fresh parent's children at the first code", async () => {
    expect(await allocUnderDept(deps, null, CODE_WIDTH.dept)).toBe("00");
    const root = await addDept("00", "Engineering");
    expect(await allocUnderDept(deps, root.uuid, CODE_WIDTH.dept)).toBe("00-00");
  });

  it("picks up from the tree a parent already holds, so it can be introduced over a live database", async () => {
    const root = await addDept("00", "Engineering");
    await addDept("00-00", "Platform", root.uuid);
    await addEmp("00-01", root.uuid);
    // ONE sequence across both tables, so the next child is past the highest of BOTH - not past the highest
    // sub-department and separately past the highest employee.
    expect(await allocUnderDept(deps, root.uuid, CODE_WIDTH.employee)).toBe("00-002");
  });

  it("hands sub-departments and employees numbers from that one sequence", async () => {
    const root = await addDept("00", "Engineering");
    // The two widths differ (a dept segment is 2 chars, an employee's 3), so separate counters would show
    // up here as both starting at leaf 0: "00-00" and "00-000". They share one, so the employee gets leaf 1.
    expect(await allocUnderDept(deps, root.uuid, CODE_WIDTH.dept)).toBe("00-00");
    expect(await allocUnderDept(deps, root.uuid, CODE_WIDTH.employee)).toBe("00-001");
  });

  it("never hands a purged department's code back to the next one created under the same parent", async () => {
    const root = await addDept("00", "Engineering");
    const first = await allocUnderDept(deps, root.uuid, CODE_WIDTH.dept);
    const child = await addDept(first, "Platform", root.uuid);
    expect(first).toBe("00-00");

    // What `DELETE /v1/departments/<id>?force=true` does: the row is gone for good. A scan-based allocator
    // now sees an empty scope and composes "00-00" again - and every surviving access rule scoped to that
    // code starts deciding for a department nobody granted anything on.
    await deps.db.delete(schema.departments).where(eq(schema.departments.uuid, child.uuid));

    expect(await allocUnderDept(deps, root.uuid, CODE_WIDTH.dept)).toBe("00-01");
    expect(await allocUnderDept(deps, root.uuid, CODE_WIDTH.dept)).toBe("00-02");
  });

  it("keeps each parent's sequence to itself", async () => {
    const a = await addDept("00", "Engineering");
    const b2 = await addDept("01", "Finance");
    expect(await allocUnderDept(deps, a.uuid, CODE_WIDTH.employee)).toBe("00-000");
    expect(await allocUnderDept(deps, b2.uuid, CODE_WIDTH.employee)).toBe("01-000");
    expect(await allocUnderDept(deps, a.uuid, CODE_WIDTH.employee)).toBe("00-001");
  });

  it("never hands the same code to two creates that ask at the same moment", async () => {
    const root = await addDept("00", "Engineering");
    const codes = await Promise.all(Array.from({ length: 8 }, () => allocUnderDept(deps, root.uuid, CODE_WIDTH.employee)));
    expect(new Set(codes).size, `duplicate code among ${codes.join(", ")}`).toBe(8);
  });
});
