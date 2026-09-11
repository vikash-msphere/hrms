import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../src/db/schema";
import { insertBatches, PARAM_CAP, chunk } from "../src/lib/dbBatch";

// D1 rejects a statement binding more than 100 parameters, and it fails the WHOLE batch: "D1_ERROR: too many
// SQL variables". The number of parameters a row binds is NOT the number of fields the caller set - drizzle
// also materializes every JS default (uuid, created_at, updated_at) - so every call site that counted columns
// by hand was one schema column away from breaking. These pin the measuring version.
//
// No D1 needed: the statements are only compiled here (toSQL), never run.
const db = drizzle({} as never, { schema });
const params = (stmt: unknown) => (stmt as { toSQL: () => { params: unknown[] } }).toSQL().params.length;

const assetRow = (i: number) => ({
  uuid: `u${i}`,
  code: `c${i}`,
  assetTag: `MS-AST-${i}`,
  name: "USB-C cable",
  categoryId: null,
  serialNumber: null,
  status: "pending_verification" as const,
  assignedTo: null,
  assignedOn: null,
  purchaseDate: null,
  tagSecret: "s",
  custodySince: new Date(0),
  notes: null,
});

describe("insertBatches", () => {
  it("keeps every statement inside the parameter cap, for a table whose rows bind 15", () => {
    const rows = Array.from({ length: 100 }, (_, i) => assetRow(i));
    // The shape that broke it: thirteen set fields, fifteen bound parameters.
    expect(params(db.insert(schema.assets).values([rows[0]!]))).toBe(15);
    const stmts = insertBatches(rows, (group) => db.insert(schema.assets).values(group));
    expect(stmts.length).toBeGreaterThan(1);
    for (const s of stmts) expect(params(s)).toBeLessThanOrEqual(PARAM_CAP);
  });

  it("covers every row exactly once, in order", () => {
    const rows = Array.from({ length: 23 }, (_, i) => assetRow(i));
    const seen: string[] = [];
    insertBatches(rows, (group) => {
      seen.push(...group.map((r) => r.uuid));
      return db.insert(schema.assets).values(group);
    });
    // `build` is also called once to measure, so the widest row appears an extra time - what matters is that
    // the statements between them carry each row once.
    expect(seen.filter((u) => u === "u0").length).toBeLessThanOrEqual(2);
    expect(new Set(seen).size).toBe(23);
  });

  it("measures the DEFINED keys, so an `undefined` one cannot make a row look cheaper than it is", () => {
    // A key set to `undefined` is a key that binds nothing: drizzle writes `default` for it. So key COUNT is
    // not parameter count, and two rows can carry the same number of keys and bind a different number of
    // parameters. Sizing by key count - keeping the first on a tie - could land on the cheaper row and then
    // fill the group with the dearer one, which is `D1_ERROR: too many SQL variables` on a list whose rows all
    // looked the same width.
    const thin = (i: number) => ({ uuid: `u${i}`, code: `c${i}`, assetTag: `t${i}`, name: "n", tagSecret: "s", custodySince: new Date(0), notes: undefined, serialNumber: undefined });
    const fat = (i: number) => ({ uuid: `u${i}`, code: `c${i}`, assetTag: `t${i}`, name: "n", tagSecret: "s", custodySince: new Date(0), notes: "n", categoryId: null });
    // Same key count, different parameter count - the premise the old measure got wrong.
    expect(Object.keys(thin(0)).length).toBe(Object.keys(fat(0)).length);
    expect(params(db.insert(schema.assets).values([fat(0)]))).toBeGreaterThan(params(db.insert(schema.assets).values([thin(0)])));

    // The thin row comes FIRST, which is what used to win the tie and set the group size.
    const rows = [thin(0), ...Array.from({ length: 99 }, (_, i) => fat(i + 1))];
    const stmts = insertBatches(rows as never[], (group) => db.insert(schema.assets).values(group as never));
    expect(stmts.length).toBeGreaterThan(1);
    for (const s of stmts) expect(params(s)).toBeLessThanOrEqual(PARAM_CAP);
  });

  it("is a no-op on an empty list (and never compiles a values([]) statement)", () => {
    expect(insertBatches([], () => db.insert(schema.assets).values([assetRow(0)]))).toEqual([]);
  });

  it("chunk stays the plain splitter it was", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 8)).toEqual([]);
  });
});
