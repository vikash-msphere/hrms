/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import type { ListScope } from "../src/domain/access";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { rulesToGrant, deriveNarrowing, type CompiledRule } from "../src/domain/compileGrants";
import { runTableView } from "../src/services/tableRun";
import { tableViewSpec, parseSpec } from "../src/services/tableViews";
import { buildCatalogue } from "../src/services/tableCatalog";
import { MAX_FILTERS, TABLE_SOURCE_COLLECTIONS, type ViewFilter } from "../src/domain/tableFields";

// Real-D1 test for the custom-grid runner. What it pins is the access story, because that is the whole design:
// the runner is handed the middleware's per-collection verdicts and may do nothing outside them, a column
// whose collection is missing is dropped, a per-field deny blanks the cell on that row (and says so), PII is
// masked unless the caller holds `unmask`, and an unmasked run leaves an audit row.
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

const TABLES = [schema.auditLog, schema.compensation, schema.employees, schema.departments, schema.users, schema.roles, schema.payComponents, schema.leaveTypes, schema.settings];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

const rule = (pattern: string, level: "read" | "write" | "admin" | null, effect: "allow" | "deny" = "allow"): CompiledRule => {
  const n = deriveNarrowing(pattern);
  return { namespace: n.namespace, pattern, scopeKind: n.scopeKind, scopeCode: n.scopeCode, matchCode: n.scopeKind === "exact" ? n.scopeCode : null, level, effect };
};

const scopeAll = (): ListScope => ({ breadth: "all", deptCode: null, ownerId: null, seeRestricted: true });
/** The map the middleware would leave for a caller who may list everything a grid can touch. */
const allScopes = () => new Map<string, ListScope>(TABLE_SOURCE_COLLECTIONS.map((c) => [c, scopeAll()]));

async function seed() {
  await deps.db.insert(schema.roles).values({ name: "hr_admin", label: "HR" }).onConflictDoNothing();
  const deptId = genId();
  await deps.db.insert(schema.departments).values({ uuid: deptId, code: "04", name: "Engineering" });
  const people: { id: string; code: string }[] = [];
  for (const [i, name] of ["Ada", "Grace"].entries()) {
    const id = genId();
    const code = `04-00${i + 1}`;
    await deps.db.insert(schema.employees).values({
      uuid: id, code, firstName: name, lastName: "Lovelace", workEmail: `${name.toLowerCase()}@test.example`,
      departmentId: deptId, status: "active",
      // The identity blob, written exactly as the identity service writes it.
      identityDetailsEnc: await deps.encryptor.encrypt(JSON.stringify({ pan: `ABCDE${1000 + i}F`, uan: `10000000000${i}` })),
      personalDetailsEnc: await deps.encryptor.encrypt(JSON.stringify({ personal_email: `${name.toLowerCase()}@personal.example` })),
    });
    await deps.db.insert(schema.compensation).values({
      uuid: genId(), code: `${code}-1`, employeeId: id, ctcAnnual: 1200000 + i * 100000, basePay: 50000, specialAllowance: 0,
      currency: "INR", effectiveFrom: new Date("2026-01-01"),
    });
    people.push({ id, code });
  }
  return { deptId, people };
}

const hrUser = (grantPatterns: CompiledRule[], employeeCode: string | null = null): AppUser =>
  ({ uuid: genId(), email: "hr@test.example", role: "hr_admin", status: "active", employeeId: null, employeeCode, name: "HR", grant: rulesToGrant(grantPatterns) }) as unknown as AppUser;

// A grant that allows everything, which is what a super-equivalent caller carries.
const SUPER = () => hrUser([rule("**.**", "admin"), rule("**.**.**", "admin")]);

const salarySheet = (extra: string[] = []) => ({
  base: "employees",
  columns: [{ field: "first_name" }, { field: "@identity.pan" }, { field: "@personal.personal_email" }, { field: "@comp.ctc_annual" }, ...extra.map((field) => ({ field }))],
});

describe("changing what a row is", () => {
  // Picking the wrong base is the mistake people make first, so it has to be an EDIT rather than a reason to
  // delete the table and start again. The patch mapper is what decides what survives that edit.
  const row = {
    base: "employees",
    specJson: JSON.stringify({
      columns: [{ field: "first_name" }, { field: "@identity.pan" }],
      filters: [{ field: "first_name", op: "eq", value: "Ada" }],
      sort: [{ field: "first_name", dir: "asc" }],
      params: { from: "2026-01-01", to: "2026-03-31", department: "departments/x" },
    }),
  };
  const applyPatch = (input: Parameters<NonNullable<typeof tableViewSpec.patch>>[0]) =>
    tableViewSpec.patch!(input, row, {} as Deps, {} as AppUser) as { base?: string; specJson?: string };

  it("clears the columns, filters and sort - they name fields of the base that is being left", () => {
    const set = applyPatch({ base: "tickets" });
    expect(set.base).toBe("tickets");
    const spec = JSON.parse(set.specJson!) as { columns: unknown[]; filters: unknown[]; sort: unknown[]; params: Record<string, string> };
    expect(spec.columns).toEqual([]);
    expect(spec.filters).toEqual([]);
    expect(spec.sort).toEqual([]);
    // The run parameters are about the READER (which window, which department), not about the base, so they
    // survive the change.
    expect(spec.params).toEqual({ from: "2026-01-01", to: "2026-03-31", department: "departments/x" });
  });

  it("keeps the columns when the base is re-sent unchanged (a rename must not wipe the table)", () => {
    const set = applyPatch({ display_name: "Renamed", base: "employees" });
    expect(set.specJson).toBeUndefined();
  });

  it("refuses a base that is not one you can build on", () => {
    expect(() => applyPatch({ base: "announcements" })).toThrow(/base must be/);
    expect(() => applyPatch({ base: "nonsense" })).toThrow(/base must be/);
  });
});

describe("the catalogue only offers what the caller may list", () => {
  it("drops the sources whose collection is not in the caller's map", async () => {
    await seed();
    const wide = await buildCatalogue(deps, "employees", new Set(TABLE_SOURCE_COLLECTIONS));
    expect(wide.fields.map((f) => f.key)).toContain("@comp.ctc_annual");
    const narrow = await buildCatalogue(deps, "employees", new Set(["employees"]));
    // `employees` alone still carries the sub-resources (they are fields OF an employee), but nothing that
    // hangs off another collection.
    expect(narrow.fields.map((f) => f.key)).toContain("@identity.pan");
    expect(narrow.fields.map((f) => f.key)).not.toContain("@comp.ctc_annual");
  });

  it("offers a link as somewhere to GO, and its fields once you go there", async () => {
    await seed();
    const wide = await buildCatalogue(deps, "employees", new Set(TABLE_SOURCE_COLLECTIONS));
    // The base node names the link but does not carry its fields - they are one request away, which is what
    // keeps a deep join from having to be computed before anybody asks for it.
    expect(wide.links.map((l) => l.path)).toContain("department_id");
    // Including a link back to the same collection: a person's manager is a person, and it is the link people
    // reach for first.
    expect(wide.links.map((l) => l.path)).toContain("manager_id");
    expect(wide.fields.map((f) => f.key)).not.toContain("department_id.name");
    const dept = await buildCatalogue(deps, "employees", new Set(TABLE_SOURCE_COLLECTIONS), ["department_id"]);
    expect(dept.fields.map((f) => f.key)).toContain("department_id.name");
    expect(dept.collection).toBe("departments");
  });

  it("offers no link at all to a collection the caller may not list", async () => {
    await seed();
    const narrow = await buildCatalogue(deps, "employees", new Set(["employees"]));
    expect(narrow.links.map((l) => l.collection)).not.toContain("departments");
    // And walking there anyway answers with nothing rather than with the fields.
    const forced = await buildCatalogue(deps, "employees", new Set(["employees"]), ["department_id"]);
    expect(forced.fields).toEqual([]);
    expect(forced.links).toEqual([]);
  });

  it("follows a chain of links, and stops at the depth cap", async () => {
    await seed();
    const listable = new Set(TABLE_SOURCE_COLLECTIONS);
    // Two hops: a person's manager, and that manager's department.
    const deep = await buildCatalogue(deps, "employees", listable, ["manager_id", "department_id"]);
    expect(deep.fields.map((f) => f.key)).toContain("manager_id.department_id.name");
    expect(deep.nodeLabel).toMatch(/Manager -> Department/);
    // Past four hops there is nothing to follow, and nothing is offered.
    const tooDeep = await buildCatalogue(deps, "employees", listable, ["manager_id", "manager_id", "manager_id", "manager_id", "manager_id"]);
    expect(tooDeep.fields).toEqual([]);
  });
});

describe("running a grid", () => {
  it("assembles base columns, a sub-resource, a joined source and a link in one page", async () => {
    const { people } = await seed();
    const result = await runTableView(deps, SUPER(), allScopes(), salarySheet(["department_id.name"]), { maxPageSize: 50, unmask: true });
    expect(result.rows).toHaveLength(2);
    expect(result.dropped).toEqual([]);
    const ada = result.rows.find((r) => r.cells.first_name === "Ada")!;
    expect(ada.path).toBe(`employees/${people[0]!.id}`);
    expect(ada.cells["@identity.pan"]).toBe("ABCDE1000F");
    expect(ada.cells["@personal.personal_email"]).toBe("ada@personal.example");
    expect(ada.cells["@comp.ctc_annual"]).toBe(1200000);
    expect(ada.cells["department_id.name"]).toBe("Engineering");
  });

  it("does not publish a SOFT-DELETED row through a link", async () => {
    const { people, deptId } = await seed();
    // The base page has always excluded deleted rows; the FK dereference did not, so a grid was the one place
    // a deleted department (or employee, or project) kept being read out to whoever could see a row pointing
    // at it. A dangling link renders empty, as an unresolvable reference does everywhere else.
    await deps.db.update(schema.departments).set({ deleteTime: new Date() }).where(eq(schema.departments.uuid, deptId));

    const result = await runTableView(deps, SUPER(), allScopes(), salarySheet(["department_id.name"]), { maxPageSize: 50, unmask: true });
    expect(result.rows).toHaveLength(2); // the employees are not deleted, so they stay
    expect(result.rows.map((r) => r.cells["department_id.name"])).toEqual([null, null]);
    expect(people).toHaveLength(2);
  });

  it("masks a sensitive identity field unless the caller holds `unmask`", async () => {
    await seed();
    const ada = (r: Awaited<ReturnType<typeof runTableView>>) => r.rows.find((row) => row.cells.first_name === "Ada")!;
    const masked = await runTableView(deps, SUPER(), allScopes(), salarySheet(), { maxPageSize: 50, unmask: false });
    expect(ada(masked).cells["@identity.pan"]).toBe("•••• 000F");
    expect(masked.columns.find((c) => c.key === "@identity.pan")!.masked).toBe(true);
    // Masking follows the org's own field config: `pan` is flagged sensitive, so it is masked; the real value
    // arrives only for a caller holding `unmask`.
    const unmasked = await runTableView(deps, SUPER(), allScopes(), salarySheet(), { maxPageSize: 50, unmask: true });
    expect(ada(unmasked).cells["@identity.pan"]).toBe("ABCDE1000F");
    expect(unmasked.columns.find((c) => c.key === "@identity.pan")!.masked).toBeUndefined();
  });

  it("emits ONE audit row for a run that touched masked PII, naming the fields and the row count", async () => {
    await seed();
    await runTableView(deps, SUPER(), allScopes(), salarySheet(), { maxPageSize: 50, unmask: true, viewCode: "04-001-1" });
    const rows = await deps.db.select().from(schema.auditLog);
    const sensitive = rows.filter((r) => r.action === "table-views.run.sensitive");
    expect(sensitive).toHaveLength(1);
    const meta = JSON.parse(sensitive[0]!.meta ?? "{}") as { fields: string[]; rows: number; unmasked: boolean };
    expect(meta.fields).toContain("@identity.pan");
    expect(meta.rows).toBe(2);
    expect(meta.unmasked).toBe(true);
    // Never a value.
    expect(JSON.stringify(meta)).not.toContain("ABCDE");
  });

  it("drops a column whose collection the caller may not list, and says so", async () => {
    await seed();
    const scopes = new Map<string, ListScope>([["employees", scopeAll()]]); // no `compensation`
    const result = await runTableView(deps, SUPER(), scopes, salarySheet(), { maxPageSize: 50, unmask: true });
    expect(result.columns.map((c) => c.key)).not.toContain("@comp.ctc_annual");
    expect(result.dropped).toEqual([{ field: "@comp.ctc_annual", reason: "not available to you" }]);
    // The rest of the grid still answers - a column you cannot have costs you that column, not the report.
    expect(result.rows[0]!.cells["@identity.pan"]).toBeTruthy();
  });

  it("refuses outright when the base itself is not listable", async () => {
    await seed();
    await expect(runTableView(deps, SUPER(), new Map(), salarySheet(), { maxPageSize: 50 })).rejects.toThrow(/cannot list employees/);
  });

  it("returns only the rows the caller's own list scope allows", async () => {
    const { people } = await seed();
    const scopes = allScopes();
    // A self-scoped reader: `own` breadth bound to their own employee row.
    scopes.set("employees", { breadth: "own", deptCode: null, ownerId: people[0]!.id, seeRestricted: false });
    const result = await runTableView(deps, SUPER(), scopes, { base: "employees", columns: [{ field: "first_name" }] }, { maxPageSize: 50 });
    // `employees` has no owner column of its own, so `own` matches nothing - fail closed, exactly as a real
    // employees list does (the directory narrows by CODE, which applyScope binds through the scope's breadth).
    expect(result.rows.length).toBeLessThanOrEqual(1);
  });

  // The hole this closes: a SOURCE was gated on its collection being PRESENT in the scope map, and a
  // collection is present the moment the caller may list it at ANY breadth. So a reader entitled to their own
  // compensation row, on a base they may list widely, was served the whole page's worth of everyone else's.
  // The base rows and the linked rows had always bound `applyScope`; the sources had not.
  it("binds the caller's SCOPE to a source, not just their permission to list it", async () => {
    const { people } = await seed();
    const scopes = allScopes();
    // Entitled to compensation, but only their own row - the shape a `me`-scoped rule compiles to.
    scopes.set("compensation", { breadth: "own", deptCode: null, ownerId: people[0]!.id, seeRestricted: false });
    const result = await runTableView(deps, SUPER(), scopes, salarySheet(), { maxPageSize: 50, unmask: true });
    // The column is still offered - they may list compensation - and the roster is still the base's own scope.
    expect(result.columns.map((c) => c.key)).toContain("@comp.ctc_annual");
    expect(result.rows).toHaveLength(2);
    const ctcOf = (name: string) => result.rows.find((r) => r.cells.first_name === name)!.cells["@comp.ctc_annual"];
    expect(ctcOf("Ada")).toBe(1200000); // their own row: the real figure
    expect(ctcOf("Grace")).toBeNull(); // a colleague's: outside their scope, so no value at all
  });

  it("fails a source closed when its collection carries no scope", async () => {
    await seed();
    // `applyScope` answers `1 = 0` for an absent scope, so a source must read nothing rather than everything.
    // Reached only if a future collection is added to a SOURCE and forgotten in TABLE_SOURCE_COLLECTIONS.
    const scopes = allScopes();
    scopes.delete("compensation");
    const result = await runTableView(deps, SUPER(), scopes, salarySheet(), { maxPageSize: 50, unmask: true });
    expect(result.columns.map((c) => c.key)).not.toContain("@comp.ctc_annual");
  });

  it("blanks a cell a per-field DENY hides on that row, and marks it denied rather than empty", async () => {
    await seed();
    // Everything, except reading anyone's PAN. A deny matches the full key INCLUDING the action token, which
    // is why the pattern ends `.**` - the shape services/accessRules.buildPattern emits for a field rule.
    const user = hrUser([rule("**.**", "admin"), rule("**.**.**", "admin"), rule("employees.*.identity.pan.**", null, "deny")]);
    const result = await runTableView(deps, user, allScopes(), salarySheet(), { maxPageSize: 50, unmask: true });
    for (const row of result.rows) {
      expect(row.cells["@identity.pan"]).toBeNull();
      expect(row.denied).toContain("@identity.pan");
      // The rest of the row is untouched: a denied FIELD costs a cell, not the record.
      expect(row.cells["@personal.personal_email"]).toBeTruthy();
    }
  });

  it("hides the whole sub-resource when the caller may not read it at all", async () => {
    await seed();
    const user = hrUser([rule("employees", "read"), rule("employees.**", "read"), rule("employees.*.identity.**", null, "deny")]);
    const result = await runTableView(deps, user, allScopes(), salarySheet(), { maxPageSize: 50, unmask: true });
    for (const row of result.rows) expect(row.denied).toContain("@identity.pan");
  });

  // A field a view FILTERS on and never displays is still a field the request acts on: the rows that come
  // back are chosen by its value. Gating only the DISPLAYED columns published that value a bit at a time -
  // a hidden `@personal.personal_email contains "ada"` narrowed the page to Ada for a caller denied the
  // sub-resource, and repeating the probe reads the address out of a grid that shows no PII at all.
  it("refuses to judge a filter on a PII field the caller may not read", async () => {
    await seed();
    // May list people and read their names; denied the personal-info sub-resource outright.
    const user = hrUser([rule("employees", "read"), rule("employees.**", "read"), rule("employees.*.personal-info.**", null, "deny")]);
    const view = {
      base: "employees",
      columns: [{ field: "first_name" }], // the PII field is NOT a column
      filters: [{ field: "@personal.personal_email", op: "contains", value: "ada" } as ViewFilter],
    };
    const result = await runTableView(deps, user, allScopes(), view, { maxPageSize: 50, unmask: true });
    // The denied cell is null, so the predicate matches nothing - the filter cannot tell the two people
    // apart, which is the whole point. It must NOT come back holding only Ada.
    expect(result.rows.map((r) => r.cells.first_name)).toEqual([]);
    // And the same filter still works for a caller who may read the field, or the test above proves nothing.
    const allowed = await runTableView(deps, SUPER(), allScopes(), view, { maxPageSize: 50, unmask: true });
    expect(allowed.rows.map((r) => r.cells.first_name)).toEqual(["Ada"]);
  });

  // The per-FIELD half of the same hole: the sub-resource is readable, one field in it is not, and that
  // field is only ever filtered on.
  it("refuses to judge a filter on a denied FIELD that is not a column", async () => {
    await seed();
    const user = hrUser([rule("**.**", "admin"), rule("**.**.**", "admin"), rule("employees.*.identity.pan.**", null, "deny")]);
    const view = {
      base: "employees",
      columns: [{ field: "first_name" }],
      filters: [{ field: "@identity.pan", op: "contains", value: "ABCDE1000" } as ViewFilter],
    };
    const result = await runTableView(deps, user, allScopes(), view, { maxPageSize: 50, unmask: true });
    expect(result.rows.map((r) => r.cells.first_name)).toEqual([]);
    const allowed = await runTableView(deps, SUPER(), allScopes(), view, { maxPageSize: 50, unmask: true });
    expect(allowed.rows.map((r) => r.cells.first_name)).toEqual(["Ada"]);
  });

  it("filters on a base column in SQL and on a joined value in memory, with the same meaning", async () => {
    await seed();
    const byName = await runTableView(deps, SUPER(), allScopes(), { ...salarySheet(), filters: [{ field: "first_name", op: "eq", value: "Ada" }] }, { maxPageSize: 50, unmask: true });
    expect(byName.rows.map((r) => r.cells.first_name)).toEqual(["Ada"]);
    const byCtc = await runTableView(deps, SUPER(), allScopes(), { ...salarySheet(), filters: [{ field: "@comp.ctc_annual", op: "gt", value: 1250000 }] }, { maxPageSize: 50, unmask: true });
    expect(byCtc.rows.map((r) => r.cells.first_name)).toEqual(["Grace"]);
  });

  // The two halves of `eq` disagreed about CASE. `eq(col, v)` is BINARY and case-sensitive; `matches()` folds
  // both sides to lower. So one saved filter meant two things depending on whether its column happened to sit
  // on the base table - the same split the `contains` escaping note in tableRun.ts exists to close, one
  // operator over. Case-insensitive is the direction that matches: it is what `contains` already does on both
  // sides, and what someone typing a value into a report filter means.
  it("matches `eq` / `ne` / `in` case-insensitively, on a base column and behind a link alike", async () => {
    await seed();
    const rows = (filters: ViewFilter[], columns: { field: string }[] = [{ field: "first_name" }]) =>
      runTableView(deps, SUPER(), allScopes(), { base: "employees", columns, filters }, { maxPageSize: 50 }).then((r) => r.rows.map((x) => x.cells.first_name));

    // Base column -> SQL half.
    expect(await rows([{ field: "first_name", op: "eq", value: "ada" }])).toEqual(["Ada"]);
    expect(await rows([{ field: "first_name", op: "in", value: "ADA" }])).toEqual(["Ada"]);
    expect(await rows([{ field: "first_name", op: "ne", value: "ada" }])).not.toContain("Ada");

    // Linked column -> in-memory half. Both spellings agree, which is the point.
    const linked = [{ field: "first_name" }, { field: "department_id.name", hidden: true }];
    expect(await rows([{ field: "department_id.name", op: "eq", value: "engineering" }], linked)).toHaveLength(2);
    expect(await rows([{ field: "department_id.name", op: "eq", value: "Engineering" }], linked)).toHaveLength(2);
  });

  // A joined DATE cell is `ymd()` text by the time the in-memory half sees it, so comparing it numerically
  // gave NaN and every gt/gte/lt/lte answered false: a date range on any column behind a link or a source
  // returned an empty grid, always, while the same filter on a base column went to SQL and worked.
  it("orders a joined DATE filter by instant, not by Number()", async () => {
    await seed();
    const sheet = { base: "employees", columns: [{ field: "first_name" }, { field: "@comp.effective_from" }] };
    const run = (op: ViewFilter["op"], value: string) =>
      runTableView(deps, SUPER(), allScopes(), { ...sheet, filters: [{ field: "@comp.effective_from", op, value }] }, { maxPageSize: 50 });
    // Both compensation rows are effective 2026-01-01.
    expect((await run("gte", "2026-01-01")).rows).toHaveLength(2);
    expect((await run("lte", "2026-01-01")).rows).toHaveLength(2);
    expect((await run("gt", "2026-01-01")).rows).toHaveLength(0);
    expect((await run("lt", "2025-12-31")).rows).toHaveLength(0);
    expect((await run("gt", "2025-12-31")).rows).toHaveLength(2);
  });

  // `%` and `_` in a `contains` needle used to be STRIPPED on the SQL side and taken literally on the
  // in-memory side, so one saved filter meant two things depending on where its column lived.
  it("treats a wildcard in a `contains` needle as a literal character", async () => {
    const { deptId } = await seed();
    // A name that actually CONTAINS the wildcards, which is what tells the three behaviours apart. Stripping
    // searched `AB` and found nothing; honouring them as wildcards would match either row from the other's
    // needle. Only escaping finds each row from its own.
    for (const name of ["A_B", "A%B"]) {
      await deps.db.insert(schema.employees).values({
        uuid: genId(), code: `04-1${name.charCodeAt(1)}`, firstName: name, lastName: "Test",
        workEmail: `${name}@test.example`, departmentId: deptId, status: "active",
      });
    }
    const sheet = { base: "employees", columns: [{ field: "first_name" }] };
    const find = async (value: string) =>
      (await runTableView(deps, SUPER(), allScopes(), { ...sheet, filters: [{ field: "first_name", op: "contains", value }] }, { maxPageSize: 50 }))
        .rows.map((r) => r.cells.first_name);
    expect(await find("A_B")).toEqual(["A_B"]); // the underscore is a character, not "any one character"
    expect(await find("A%B")).toEqual(["A%B"]); // the percent is a character, not "anything"
    expect(await find("AB")).toEqual([]); // and neither row is reachable by the stripped needle
  });

  it("sorts the page by the view's own sort", async () => {
    await seed();
    const asc = await runTableView(deps, SUPER(), allScopes(), { ...salarySheet(), sort: [{ field: "first_name", dir: "asc" }] }, { maxPageSize: 50, unmask: true });
    expect(asc.rows.map((r) => r.cells.first_name)).toEqual(["Ada", "Grace"]);
    const desc = await runTableView(deps, SUPER(), allScopes(), { ...salarySheet(), sort: [{ field: "first_name", dir: "desc" }] }, { maxPageSize: 50, unmask: true });
    expect(desc.rows.map((r) => r.cells.first_name)).toEqual(["Grace", "Ada"]);
  });

  // "Order by X, don't show X" is an ordinary thing to build a report out of, and `cleanSort` validates a sort
  // key's SHAPE only - never that it names a selected column - so it saves fine. The sort then read
  // `row.cells[field]`, which only ever holds the SELECTED columns: every comparison was `undefined` against
  // `undefined`, which `compareCells` answers 0 for, so the sort was a stable no-op. The page came back in
  // cursor order with nothing to say the view's sort had been ignored, and the `byKey.has` guard in front of it
  // made it look handled (`byKey` holds every resolved field, selected or not, so it passed).
  it("sorts by a column it does not display", async () => {
    await seed();
    const bare = { base: "employees", columns: [{ field: "@comp.ctc_annual" }] };

    // Hidden: the author asked for the column and then hid it.
    const hidden = await runTableView(
      deps, SUPER(), allScopes(),
      { ...bare, columns: [...bare.columns, { field: "first_name", hidden: true }], sort: [{ field: "first_name", dir: "desc" }] },
      { maxPageSize: 50, unmask: true },
    );
    // The hidden column is not returned...
    expect(hidden.columns.map((c) => c.key)).toEqual(["@comp.ctc_annual"]);
    // ...but it did the ordering. Ada and Grace have different CTCs, so the visible column proves the order.
    const byName = await runTableView(
      deps, SUPER(), allScopes(), { ...bare, columns: [{ field: "first_name" }, ...bare.columns], sort: [{ field: "first_name", dir: "desc" }] },
      { maxPageSize: 50, unmask: true },
    );
    expect(byName.rows.map((r) => r.cells.first_name)).toEqual(["Grace", "Ada"]);
    expect(hidden.rows.map((r) => r.cells["@comp.ctc_annual"])).toEqual(byName.rows.map((r) => r.cells["@comp.ctc_annual"]));

    // And the same for a field the view never names as a column at all, which a saved spec can carry.
    const unlisted = await runTableView(
      deps, SUPER(), allScopes(), { ...bare, sort: [{ field: "first_name", dir: "asc" }] }, { maxPageSize: 50, unmask: true },
    );
    expect(unlisted.rows.map((r) => r.cells["@comp.ctc_annual"])).toEqual(
      [...hidden.rows.map((r) => r.cells["@comp.ctc_annual"])].reverse(),
    );
  });

  it("never offers a bare foreign key as a column - the link's own fields are what a grid shows", async () => {
    await seed();
    const catalogue = await buildCatalogue(deps, "employees", new Set(TABLE_SOURCE_COLLECTIONS));
    expect(catalogue.fields.map((f) => f.key)).not.toContain("department_id");
    const dept = await buildCatalogue(deps, "employees", new Set(TABLE_SOURCE_COLLECTIONS), ["department_id"]);
    expect(dept.fields.map((f) => f.key)).toContain("department_id.name");
    // And asking for one anyway (a hand-written spec) gets it dropped rather than answered with an id.
    const result = await runTableView(deps, SUPER(), allScopes(), { base: "employees", columns: [{ field: "department_id" }] }, { maxPageSize: 50 });
    expect(result.columns).toEqual([]);
    expect(result.dropped).toEqual([{ field: "department_id", reason: "not available to you" }]);
  });

  it("pages, and the cursor carries a wire token rather than an internal id", async () => {
    await seed();
    const first = await runTableView(deps, SUPER(), allScopes(), { base: "employees", columns: [{ field: "first_name" }] }, { maxPageSize: 1 });
    expect(first.rows).toHaveLength(1);
    expect(first.next_page_token).toBeTruthy();
    const second = await runTableView(deps, SUPER(), allScopes(), { base: "employees", columns: [{ field: "first_name" }] }, { maxPageSize: 1, pageToken: first.next_page_token });
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]!.cells.first_name).not.toBe(first.rows[0]!.cells.first_name);
  });
});

describe("filters, and what they are allowed to spend", () => {
  // A grid's filters are compiled into the page query. D1 binds at most 100 parameters PER STATEMENT and an
  // `in` filter spends one per item, so a long list plus the caller's scope predicates plus the keyset bounds
  // went over the cap and the whole grid answered `D1_ERROR: too many SQL variables` - a 500 on a saved view,
  // at whatever list length happened to cross it. The budget hands the overflow to the in-memory half instead,
  // which is why that half had to be made correct for fields nobody selected.
  const nameSheet = (filters: ViewFilter[]) => ({ base: "employees", columns: [{ field: "first_name" }], filters });

  it("still narrows correctly when the in list is far past the parameter budget", async () => {
    await seed();
    // 200 values: one real, the rest noise. Well past FILTER_PARAM_BUDGET, so this filter is deferred rather
    // than bound - and the answer has to be the same either way.
    const names = ["Ada", ...Array.from({ length: 199 }, (_, i) => `Nobody${i}`)];
    const result = await runTableView(deps, SUPER(), allScopes(), nameSheet([{ field: "first_name", op: "in", value: names.join(",") }]), { maxPageSize: 50 });
    expect(result.rows.map((r) => r.cells.first_name)).toEqual(["Ada"]);
  });

  it("pushes a short in list down and answers the same rows", async () => {
    await seed();
    const result = await runTableView(deps, SUPER(), allScopes(), nameSheet([{ field: "first_name", op: "in", value: "Ada,Grace" }]), { maxPageSize: 50 });
    expect((result.rows.map((r) => r.cells.first_name) as string[]).sort()).toEqual(["Ada", "Grace"]);
  });

  it("narrows by a HIDDEN column instead of emptying the grid", async () => {
    // "Filter by department, don't show it" is what `hidden` is for, and a hidden column is not in `selected` -
    // so its cell was never computed, the deferred filter judged every row against `undefined`, and the grid
    // came back empty. Silently, and always.
    const spec = (value: string) => ({
      base: "employees",
      columns: [{ field: "first_name" }, { field: "department_id.name", hidden: true }],
      filters: [{ field: "department_id.name", op: "eq" as const, value }],
    });
    await seed();
    const result = await runTableView(deps, SUPER(), allScopes(), spec("Engineering"), { maxPageSize: 50 });
    expect(result.rows).toHaveLength(2);
    // Hidden means hidden: it narrowed the rows and is not one of the answer's columns or cells.
    expect(result.columns.map((c) => c.key)).toEqual(["first_name"]);
    expect(result.rows[0]!.cells["department_id.name"]).toBeUndefined();

    // And it still EXCLUDES: the same filter for a department nobody is in answers nothing.
    expect((await runTableView(deps, SUPER(), allScopes(), spec("Marketing"), { maxPageSize: 50 })).rows).toEqual([]);
  });

  it("narrows by a linked column the view does not carry at all", async () => {
    // Same shape as the hidden case, one step further: a filter whose field is not among the columns in any
    // form. The loading side already registered its link path; only the cell was missing.
    await seed();
    const result = await runTableView(
      deps,
      SUPER(),
      allScopes(),
      { base: "employees", columns: [{ field: "first_name" }], filters: [{ field: "department_id.name", op: "eq", value: "Engineering" }] },
      { maxPageSize: 50 },
    );
    expect(result.rows).toHaveLength(2);
  });
});

describe("the caps on a saved view", () => {
  const insert = (input: Parameters<NonNullable<typeof tableViewSpec.insert>>[0]) =>
    tableViewSpec.insert!(input, {} as Deps, { employeeId: "emp1" } as unknown as AppUser);

  it("caps the number of filters, which was the one list with no ceiling", () => {
    // Columns were capped at 60 and sorts at 4; filters were unbounded, so the count was caller-controlled -
    // and each one costs a bound parameter in the page query, a pass over the page in memory, or both.
    const many = (n: number): ViewFilter[] => Array.from({ length: n }, () => ({ field: "first_name", op: "eq" as const, value: "Ada" }));
    expect(() => insert({ display_name: "T", base: "employees", columns: [{ field: "first_name" }], filters: many(MAX_FILTERS + 1) })).toThrow(/at most 24 filters/);
    expect(() => insert({ display_name: "T", base: "employees", columns: [{ field: "first_name" }], filters: many(MAX_FILTERS) })).not.toThrow();
  });

  it("TRIMS an over-long stored spec rather than refusing to open it", () => {
    // On the read path an over-long list is a row that already exists - a row written before the cap, or one
    // edited by hand. Throwing there would make the view unopenable AND unfixable, because the editor cannot
    // load what it is meant to correct.
    const spec = parseSpec("employees", JSON.stringify({
      columns: [{ field: "first_name" }],
      filters: Array.from({ length: MAX_FILTERS + 10 }, () => ({ field: "first_name", op: "eq", value: "Ada" })),
    }));
    expect(spec.filters).toHaveLength(MAX_FILTERS);
  });
});
