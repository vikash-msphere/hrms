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
import { DEFAULT_POLICY, type Policy } from "../src/domain/manifests";
import { decide, resolveRequest } from "../src/domain/permissions";
import { GRANTS } from "../src/domain/grants";
import { scopeFor } from "../src/domain/access";
import { listableCollectionsFor } from "../src/middleware/authz";
import { basesFor } from "../src/services/tableCatalog";
import { scopeCanMatch } from "../src/services/listScope";
import { catalogueFieldGate } from "../src/http/tableFieldAccess";
import { TABLES as TABLE_REGISTRY, listOwnerColumn } from "../src/lib/authzResolve";

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

const TABLES = [schema.auditLog, schema.applications, schema.jobRequisitions, schema.candidates, schema.tickets, schema.compensation, schema.employees, schema.departments, schema.users, schema.roles, schema.payComponents, schema.leaveTypes, schema.settings];
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

// `policy` is part of the fixture, not an optional extra: the runner reads `redacted_fields` and
// `state_visibility` off it exactly as every list does, and a principal without one is a bug rather than a
// case to tolerate (services/crud.ts says so beside the same read). See [[test-fixtures-cast-away-appuser-fields]].
const hrUser = (grantPatterns: CompiledRule[], employeeCode: string | null = null, policy: Policy = DEFAULT_POLICY): AppUser =>
  ({ uuid: genId(), email: "hr@test.example", role: "hr_admin", status: "active", employeeId: null, employeeCode, name: "HR", policy, grant: rulesToGrant(grantPatterns) }) as unknown as AppUser;

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

  it("carries the trail a field sits under, so a header can be qualified from it", async () => {
    await seed();
    const listable = new Set(TABLE_SOURCE_COLLECTIONS);
    // The picker files a field under the node it came from, so at the base the plain name is the whole story.
    const base = await buildCatalogue(deps, "employees", listable);
    expect(base.fields.find((f) => f.key === "first_name")!.trail).toBeUndefined();
    const dept = await buildCatalogue(deps, "employees", listable, ["department_id"]);
    const deptName = dept.fields.find((f) => f.key === "department_id.name")!;
    expect(deptName.trail).toEqual(["Department"]);
    // A department IS its name, so a header may collapse to the link ("Department" over "Engineering").
    expect(deptName.nodeName).toBe(true);
    expect(dept.fields.find((f) => f.key === "department_id.disabled")!.nodeName).toBeUndefined();
    const deep = await buildCatalogue(deps, "employees", listable, ["manager_id", "department_id"]);
    expect(deep.fields.find((f) => f.key === "manager_id.department_id.name")!.trail).toEqual(["Manager", "Department"]);
    // A per-employee source hanging off a linked node carries the same trail as that node's own columns.
    const mgr = await buildCatalogue(deps, "employees", listable, ["manager_id"]);
    expect(mgr.fields.find((f) => f.key === "manager_id.@personal.personal_email")!.trail).toEqual(["Manager"]);
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

  it("names the headers against each other: short where it can be, qualified where it must be", async () => {
    await seed();
    const run = async (columns: { field: string; label?: string }[]) =>
      (await runTableView(deps, SUPER(), allScopes(), { base: "employees", columns }, { maxPageSize: 50 })).columns;
    const header = (cols: Awaited<ReturnType<typeof run>>, key: string) => cols.find((c) => c.key === key)!.label;

    // One linked name and nothing to confuse it with: the link is the header, and the ": Name" that would
    // have been on the end of it says nothing the reader did not already know.
    const one = await run([{ field: "first_name" }, { field: "department_id.name" }]);
    expect(header(one, "first_name")).toBe("First name");
    expect(header(one, "department_id.name")).toBe("Department");
    // ...and the name it did not need to spell out is still one hover away.
    expect(one.find((c) => c.key === "department_id.name")!.full_label).toBe("Department: Name");
    expect(one.find((c) => c.key === "first_name")!.full_label).toBeUndefined();

    // Add the manager's department and the two grow - each by exactly one hop, and nothing else moves.
    const two = await run([{ field: "first_name" }, { field: "department_id.name" }, { field: "manager_id.department_id.name" }]);
    expect(two.map((c) => c.label)).toEqual(["First name", "Department", "Manager -> Department"]);

    // Two "First name"s, one of them the base's own: the linked one qualifies, the base's stays plain.
    const clash = await run([{ field: "first_name" }, { field: "manager_id.first_name" }]);
    expect(clash.map((c) => c.label)).toEqual(["First name", "Manager: First name"]);

    // The author's own header is never rewritten, and the rest are named around it.
    const named = await run([{ field: "first_name" }, { field: "manager_id.first_name", label: "Reports to" }]);
    expect(named.map((c) => c.label)).toEqual(["First name", "Reports to"]);
  });

  it("keeps the whole trail one hover away from a header it shortened", async () => {
    await seed();
    const spec = { base: "employees", columns: [{ field: "manager_id.department_id.name" }] };
    const [col] = (await runTableView(deps, SUPER(), allScopes(), spec, { maxPageSize: 50 })).columns;
    // Alone in the grid it is just "Department"; what that is the department OF is on the tooltip rather
    // than in the header of every row.
    expect(col!.label).toBe("Department");
    expect(col!.full_label).toBe("Manager -> Department: Name");
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

  // The same split as the case one above, on the kind rather than on the operator. The in-memory half compared
  // `String(cell) === String(value)` for EVERY kind, which is only the right question for text: SQL compares a
  // money column against `Number(value)`, so `eq 1200000.00` matched there and matched nothing here (and `ne`
  // inverted it, excluding nobody). A saved grid filtering CTC therefore found everyone or nobody depending on
  // whether the column sat on the base table or behind a link.
  it("matches `eq` / `ne` / `in` on a NUMBER column by value, on a base column and behind a link alike", async () => {
    await seed(); // Ada 1200000, Grace 1300000
    const onBase = (f: ViewFilter) => // compensation.ctc_annual is a plain base column -> SQL half
      runTableView(deps, SUPER(), allScopes(), { base: "compensation", columns: [{ field: "ctc_annual" }], filters: [f] }, { maxPageSize: 50 }).then((r) => r.rows.length);
    const behindLink = (f: ViewFilter) => // @comp.ctc_annual is a source -> in-memory half
      runTableView(deps, SUPER(), allScopes(), { base: "employees", columns: [{ field: "first_name" }], filters: [{ ...f, field: `@comp.${(f.field as string).replace(/^@comp\./, "")}` }] }, { maxPageSize: 50 }).then((r) => r.rows.length);
    const both = async (f: ViewFilter) => ({ sql: await onBase(f), mem: await behindLink(f) });

    // The plain spelling already agreed; it is the formatting of the SAME number that did not.
    expect(await both({ field: "ctc_annual", op: "eq", value: "1200000" })).toEqual({ sql: 1, mem: 1 });
    expect(await both({ field: "ctc_annual", op: "eq", value: "1200000.00" })).toEqual({ sql: 1, mem: 1 });
    expect(await both({ field: "ctc_annual", op: "ne", value: "1200000.00" })).toEqual({ sql: 1, mem: 1 });
    expect(await both({ field: "ctc_annual", op: "in", value: "1200000.00,1300000" })).toEqual({ sql: 2, mem: 2 });
    // A value that is not a number matches nothing rather than falling back to a string compare.
    expect(await both({ field: "ctc_annual", op: "eq", value: "not-a-number" })).toEqual({ sql: 0, mem: 0 });
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

describe("a base field the caller may not READ is not a column of the grid either", () => {
  // `policy.redacted_fields` is the per-field read gate for plain columns - the one http/accessHint.ts applies
  // to every serialized resource in the app. The grid projects raw columns, so it went round it: a deny on
  // `tickets.*.description` took the field out of the tickets list and out of the ticket itself, and left it
  // fully readable as a column of a saved grid, on the same rows, to the same caller.
  const ticketSheet = (columns: string[]) => ({ base: "tickets", columns: columns.map((field) => ({ field })) });
  const SECRET = "the note says what the ticket is really about";

  async function seedTicket() {
    const { people } = await seed();
    await deps.db.insert(schema.tickets).values({
      uuid: genId(), code: "04-001-001", employeeId: people[0]!.id, subject: "Laptop won't boot", description: SECRET,
    });
    return people;
  }

  it("blanks the redacted column on the row and names it in `denied`", async () => {
    await seedTicket();
    const user = hrUser([rule("**.**", "admin"), rule("**.**.**", "admin"), rule("tickets.*.description.**", null, "deny")]);
    const result = await runTableView(deps, user, allScopes(), ticketSheet(["subject", "description"]), { maxPageSize: 50 });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.cells.subject).toBe("Laptop won't boot");
    expect(result.rows[0]!.cells.description).toBeNull();
    expect(result.rows[0]!.denied).toEqual(["description"]);
  });

  it("leaves it alone for a caller with no deny - the manifest takes a field away, it never hands one over", async () => {
    await seedTicket();
    const result = await runTableView(deps, SUPER(), allScopes(), ticketSheet(["subject", "description"]), { maxPageSize: 50 });
    expect(result.rows[0]!.cells.description).toBe(SECRET);
    expect(result.rows[0]!.denied).toBeUndefined();
  });

  it("does not let a hidden FILTER read the value it may not show", async () => {
    await seedTicket();
    const user = hrUser([rule("**.**", "admin"), rule("**.**.**", "admin"), rule("tickets.*.description.**", null, "deny")]);
    // Filtering by a column is not a way to read it: the cell the predicate judges is the denied one, so the
    // probe cannot come back "matched" and confirm a guess at the text.
    const probe = { ...ticketSheet(["subject"]), filters: [{ field: "description", op: "contains", value: "really about" }] as ViewFilter[] };
    const result = await runTableView(deps, user, allScopes(), probe, { maxPageSize: 50 });
    expect(result.rows).toEqual([]);
    // ...and the same probe by a caller who may read it does match, so the filter itself still works.
    const allowed = await runTableView(deps, SUPER(), allScopes(), probe, { maxPageSize: 50 });
    expect(allowed.rows).toHaveLength(1);
  });
});

describe("state-gated rows stay out of the grid", () => {
  // `policy.state_visibility` is org-editable policy DATA. Every list in the app binds it (services/crud.ts
  // via publicStateFilter, announcements through its own visibleWhere) off the `seeRestricted` the middleware
  // resolved; the grid bound only the breadth, so a saved view answered with rows the collection's own list
  // hides - the restricted half of a state-gated collection, to whoever could list the public half.
  const gatedPolicy: Policy = {
    ...DEFAULT_POLICY,
    state_visibility: { ...DEFAULT_POLICY.state_visibility, tickets: { requires: "write", public_when: { state: ["OPEN"] } } },
  };
  const restricted = (): ListScope => ({ breadth: "all", deptCode: null, ownerId: null, seeRestricted: false });

  async function seedTwoTickets() {
    const { people } = await seed();
    await deps.db.insert(schema.tickets).values([
      { uuid: genId(), code: "04-001-001", employeeId: people[0]!.id, subject: "Public one", state: "OPEN" },
      { uuid: genId(), code: "04-001-002", employeeId: people[0]!.id, subject: "Restricted one", state: "CLOSED" },
    ]);
  }

  it("hides the non-public rows from a caller who may not see restricted ones", async () => {
    await seedTwoTickets();
    const scopes = new Map<string, ListScope>(TABLE_SOURCE_COLLECTIONS.map((c) => [c, restricted()]));
    const user = hrUser([rule("**.**", "admin"), rule("**.**.**", "admin")], null, gatedPolicy);
    const result = await runTableView(deps, user, scopes, { base: "tickets", columns: [{ field: "subject" }] }, { maxPageSize: 50 });
    expect(result.rows.map((r) => r.cells.subject)).toEqual(["Public one"]);
  });

  it("shows them to a caller the middleware resolved `seeRestricted` for", async () => {
    await seedTwoTickets();
    const user = hrUser([rule("**.**", "admin"), rule("**.**.**", "admin")], null, gatedPolicy);
    const result = await runTableView(deps, user, allScopes(), { base: "tickets", columns: [{ field: "subject" }] }, { maxPageSize: 50 });
    expect(result.rows.map((r) => r.cells.subject).sort()).toEqual(["Public one", "Restricted one"]);
  });
});

describe("a saved view belongs to the person who saved it", () => {
  // The object-level half of the same question, pinned because the seeded grant reads like it could go either
  // way: `table-views` is held at ALL scope (so the list and create endpoints can be called at all) and only
  // `table-views.me.**` / `table-views.me.run` name rows. The bare capability carries no trailing tokens, so it
  // matches no item path - which is what keeps "may build a grid" from meaning "may open, edit, delete or run
  // everybody else's".
  const self = { employeeCode: "04-001" };
  const mine = "04-001-0001"; // an owned code: the author's employee code plus one segment
  const theirs = "04-002-0001";
  const asks = (method: string, code: string, verb = "") =>
    decide(GRANTS.employee, resolveRequest(method, `/v1/table-views/${code}${verb}`), self).allow;

  it("lets an employee run their own view and refuses a colleague's", () => {
    expect(asks("POST", mine, ":run")).toBe(true);
    expect(asks("POST", theirs, ":run")).toBe(false);
  });

  it("refuses reading, editing and deleting a colleague's view", () => {
    for (const method of ["GET", "PATCH", "DELETE"]) {
      expect([method, asks(method, mine)]).toEqual([method, true]);
      expect([method, asks(method, theirs)]).toEqual([method, false]);
    }
  });

  it("scopes the LIST to own rows, so the grid picker never names a colleague's table", () => {
    const actor = { grant: GRANTS.employee, employeeCode: "04-001", employeeId: "emp1", policy: DEFAULT_POLICY };
    expect(scopeFor(actor, "table-views").breadth).toBe("own");
  });
});

describe("a redacted field is gated on the row it LIVES on, not on the base row", () => {
  // The linked half. A grid based on Applications reaches the candidate's contact details through
  // `candidate_id`, and `candidates: ["email", "phone", "notes"]` is in REDACTED_FIELDS - so the decision has
  // to be taken against the CANDIDATE's code, not the application's. Taking it on the base row would decide a
  // candidates rule against an applications code and allow whatever happened not to match.
  async function seedApplication() {
    await seed();
    const candidateId = genId();
    const reqId = genId();
    await deps.db.insert(schema.candidates).values({ uuid: candidateId, code: "cn-001", name: "Alan", email: "alan@candidate.example" });
    await deps.db.insert(schema.jobRequisitions).values({ uuid: reqId, code: "jr-001", title: "Engineer" });
    await deps.db.insert(schema.applications).values({ uuid: genId(), code: "ap-001", candidateId, requisitionId: reqId, stage: "applied" });
  }

  const sheet = { base: "applications", columns: [{ field: "stage" }, { field: "candidate_id.email" }] };

  it("blanks the linked field for a caller denied it on the candidate", async () => {
    await seedApplication();
    const user = hrUser([rule("**.**", "admin"), rule("**.**.**", "admin"), rule("candidates.*.email.**", null, "deny")]);
    const result = await runTableView(deps, user, allScopes(), sheet, { maxPageSize: 50 });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.cells.stage).toBe("applied");
    expect(result.rows[0]!.cells["candidate_id.email"]).toBeNull();
    expect(result.rows[0]!.denied).toEqual(["candidate_id.email"]);
    // The deny is about the CANDIDATE's field: a deny written against the application's own namespace must not
    // be what happens to catch it, and a caller with neither deny keeps the column.
    const wide = await runTableView(deps, SUPER(), allScopes(), sheet, { maxPageSize: 50 });
    expect(wide.rows[0]!.cells["candidate_id.email"]).toBe("alan@candidate.example");
  });

  it("does not let a filter on the linked field read it either", async () => {
    await seedApplication();
    const user = hrUser([rule("**.**", "admin"), rule("**.**.**", "admin"), rule("candidates.*.email.**", null, "deny")]);
    const probe = { base: "applications", columns: [{ field: "stage" }], filters: [{ field: "candidate_id.email", op: "contains", value: "alan" }] as ViewFilter[] };
    expect((await runTableView(deps, user, allScopes(), probe, { maxPageSize: 50 })).rows).toEqual([]);
    expect((await runTableView(deps, SUPER(), allScopes(), probe, { maxPageSize: 50 })).rows).toHaveLength(1);
  });
});

describe("the base picker offers only bases the caller can get a row of", () => {
  // `GET /v1/table-fields` used to answer from the boolean half of the verdict alone - "may this caller call
  // `GET /v1/<collection>`" - and a collection-level capability is routinely held by somebody whose breadth
  // then binds to nothing. A principal with no employee record is the clearest case: every `me`-scoped grant
  // they hold resolves to own breadth with no owner to bind, so `applyScope` answers `1 = 0` and the base can
  // only ever produce an empty grid. Offering it is the menu of empty reports the field catalogue one level
  // down already refuses to be.
  const scopesOf = (user: AppUser) => {
    const listable = listableCollectionsFor(user);
    const m = new Map<string, ListScope>();
    for (const c of TABLE_SOURCE_COLLECTIONS) if (listable.has(c)) m.set(c, scopeFor(user, c));
    return m;
  };
  const employee = (employeeCode: string | null, employeeId: string | null) =>
    ({ grant: GRANTS.employee, employeeCode, employeeId, role: "employee", policy: DEFAULT_POLICY }) as unknown as AppUser;

  it("offers the own-breadth bases to an employee with a record", () => {
    const offered = basesFor(scopesOf(employee("04-002-001", "emp1"))).map((b) => b.collection);
    expect(offered).toContain("payslips"); // own breadth, bound by the owner column
    expect(offered).toContain("employees"); // the directory, at whatever breadth they hold
  });

  it("drops them for a principal with no employee record, whose own breadth binds nothing", () => {
    const withRecord = basesFor(scopesOf(employee("04-002-001", "emp1"))).map((b) => b.collection);
    const without = basesFor(scopesOf(employee(null, null))).map((b) => b.collection);
    expect(without).not.toContain("payslips");
    expect(without.length).toBeLessThan(withRecord.length);
    // Not everything goes: an org-wide catalogue is readable at `all` breadth, which needs no owner at all.
    expect(without).toContain("holidays");
  });

  it("never offers a base whose scope predicate is the constant false", () => {
    for (const user of [employee("04-002-001", "emp1"), employee(null, null)]) {
      const scopes = scopesOf(user);
      for (const b of basesFor(scopes)) {
        const table = TABLE_REGISTRY[b.collection] as any;
        expect([b.collection, scopeCanMatch(scopes.get(b.collection), table.code, listOwnerColumn(b.collection, table))]).toEqual([b.collection, true]);
      }
    }
  });
});

describe("the column picker offers only fields the caller can read", () => {
  // One level down from the base picker, and the same promise: the builder offers what the caller can have.
  // Collection-level access was already asked here; FIELD-level access was not, so a caller denied `identity`
  // was offered the whole Identity group and a caller denied `tickets.*.description` was offered that column -
  // and found out by adding it and getting back a grid of restricted markers.
  const listable = () => new Set(TABLE_SOURCE_COLLECTIONS);
  const keysFor = async (user: AppUser, base = "employees") =>
    (await buildCatalogue(deps, base, listable(), [], catalogueFieldGate(user))).fields.map((f) => f.key);

  it("drops a whole PII sub-resource the caller may not read", async () => {
    await seed();
    const denied = hrUser([rule("**.**", "admin"), rule("**.**.**", "admin"), rule("employees.*.identity.**", null, "deny")], "04-001");
    const keys = await keysFor(denied);
    expect(keys).not.toContain("@identity.pan");
    expect(keys).not.toContain("@identity.uan");
    // The rest of the person is untouched, and so is the group that WAS readable.
    expect(keys).toContain("first_name");
    expect(keys).toContain("@personal.personal_email");
    // ...and the heading goes with the fields, rather than standing empty.
    const cat = await buildCatalogue(deps, "employees", listable(), [], catalogueFieldGate(denied));
    expect(cat.groups.map((g) => g.label)).not.toContain("Identity");
  });

  it("drops a single key within a sub-resource and keeps its siblings", async () => {
    await seed();
    const keys = await keysFor(hrUser([rule("**.**", "admin"), rule("**.**.**", "admin"), rule("employees.*.identity.pan.**", null, "deny")], "04-001"));
    expect(keys).not.toContain("@identity.pan");
    expect(keys).toContain("@identity.uan");
  });

  it("drops a redacted base column the caller may not read", async () => {
    await seed();
    const denied = hrUser([rule("**.**", "admin"), rule("**.**.**", "admin"), rule("tickets.*.description.**", null, "deny")], "04-001");
    const keys = await keysFor(denied, "tickets");
    expect(keys).not.toContain("description");
    expect(keys).toContain("subject");
    // Nobody loses a field by the manifest listing it - only a deny takes one away.
    expect(await keysFor(SUPER(), "tickets")).toContain("description");
  });

  it("keeps a field a manager reads only on their REPORTS, which needs the reporting line", async () => {
    await seed();
    // `my-reports` matches real codes and nothing else, so neither the unscoped sentinel nor the caller's own
    // code can stand in for one. The matcher context the middleware already resolved is what answers it.
    const mgr = hrUser([rule("employees", "read"), rule("employees.my-reports.**", "read")], "04-001");
    const withChain = await buildCatalogue(deps, "employees", listable(), [], catalogueFieldGate(mgr, { employeeCode: "04-001", reportCodes: ["04-009"] }));
    expect(withChain.fields.map((f) => f.key)).toContain("@identity.pan");
    // Same grant, no reporting line resolved: the gate has no code their rule could match, so it withholds -
    // which is why the route hands it the context rather than rebuilding a half of one.
    const without = await buildCatalogue(deps, "employees", listable(), [], catalogueFieldGate(mgr));
    expect(without.fields.map((f) => f.key)).not.toContain("@identity.pan");
  });

  it("keeps a field a `me`-scoped caller reads on their OWN row", async () => {
    await seed();
    // The probe that matters: an employee holds `employees.me.identity.**` and nothing unscoped, so a gate that
    // asked only the unscoped sentinel would have hidden their own PAN from them in the builder while the run
    // happily returned it.
    const employee = hrUser([rule("employees", "read"), rule("employees.**", "read"), rule("employees.me.identity.**", "read")], "04-001");
    expect(await keysFor(employee)).toContain("@identity.pan");
  });
});

describe("a filter means the same thing wherever it is judged", () => {
  // The runner evaluates a filter in SQL when it sits on a base column and in memory when it sits behind a
  // link or a source. Every operator therefore has two implementations, and the file's history is a list of
  // the ones that had drifted apart (`likeEscape`, `lowerEq`, `equalsValue`). These are the last two.
  const year = String(new Date().getFullYear());
  const run = (filters: ViewFilter[], columns: { field: string }[]) =>
    runTableView(deps, SUPER(), allScopes(), { base: "employees", columns, filters }, { maxPageSize: 50 });

  it("orders TEXT as text on both halves", async () => {
    await seed();
    // SQL compared a text column lexicographically while the in-memory half read `Number(cell)` and got NaN,
    // so "name is after G" answered the whole page on a base column and nothing behind a link.
    const base = await run([{ field: "first_name", op: "gt", value: "b" }], [{ field: "first_name" }]);
    expect(base.rows.map((r) => r.cells.first_name)).toEqual(["Grace"]);
    // Case is folded, matching `lowerEq` next door: "Grace" > "b" needs the two sides in one case to be true.
    const folded = await run([{ field: "first_name", op: "gte", value: "ADA" }], [{ field: "first_name" }]);
    expect(folded.rows.map((r) => r.cells.first_name).sort()).toEqual(["Ada", "Grace"]);
    // The same operator on a LINKED text column, judged in memory, answers rather than excluding everything.
    const linked = [{ field: "first_name" }, { field: "department_id.name" }];
    expect((await run([{ field: "department_id.name", op: "gt", value: "A" }], linked)).rows).toHaveLength(2);
    expect((await run([{ field: "department_id.name", op: "lt", value: "A" }], linked)).rows).toEqual([]);
  });

  it("matches `contains` on a date against the text the grid shows, not the stored instant", async () => {
    await seed();
    // A date column is stored as an instant and rendered as `ymd()`. LIKE over the stored form asked a
    // different question from the one the reader is looking at, so this matched nothing on a base column and
    // matched behind a link.
    const base = await run([{ field: "created_at", op: "contains", value: year }], [{ field: "first_name" }]);
    expect(base.rows).toHaveLength(2);
    expect((await run([{ field: "created_at", op: "contains", value: "1999" }], [{ field: "first_name" }])).rows).toEqual([]);
    const linked = [{ field: "first_name" }, { field: "department_id.name" }];
    expect((await run([{ field: "department_id.created_at", op: "contains", value: year }], linked)).rows).toHaveLength(2);
  });
});

