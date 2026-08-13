/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { GRANTS } from "../src/domain/grants";
import { actorCan, actorScope } from "../src/domain/access";

// ONE way to define a collection. Every route file that exposes the AEP standard methods (a collection-level
// `GET /` plus an item-level `GET /:id`) must be built by http/collectionRoute.ts, so the paging cursor, the
// If-Match check, the soft-delete/restore pair, the access hints and the audit action stems have exactly one
// implementation. Hand-copying that surface is what produced every drift defect the conversion has found so far
// (a `?id=` silently dropped in five collections, a lifecycle verb 500ing on a column that does not exist, a
// missing lock guard, a collection with no tests at all).
//
// PENDING is the shrinking list of files still hand-rolled. It is a budget, not an exemption list: this suite
// fails BOTH when a new hand-rolled collection appears (use the factory) and when a listed one is converted
// without being removed (keep the ledger honest).
//
// NOT_COLLECTIONS is the permanent exemption: key/value config surfaces that borrow the route shape but have no
// collection semantics - the item id is a key the caller chooses, so PATCH upserts and there is nothing to
// create or delete. Each carries its reason, and a test below pins the property that makes the claim true: no
// collection-level `POST /` (an item-level `POST /:id:verb` is a custom method, not a create) and no DELETE. If one ever grows a create or a delete it has become a collection, that test fails,
// and it moves into the factory lane.
const sources = import.meta.glob("../src/routes/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const basename = (path: string) => path.split("/").pop()!.replace(/\.ts$/, "");
// A collection-level list plus an item-level get: the shape the factory owns. A factory-built file registers
// neither by hand, so this matches only the hand-written ones.
const isHandRolledCollection = (src: string) => /\.get\("\/"/.test(src) && /\.get\((?:"|`)\/:/.test(src);
// `collectionRoutes({...})` or `collectionRoutes<Input>({...})` - the type argument is common enough that
// missing it would silently under-count converted collections.
const usesFactory = (src: string) => /collectionRoutes\s*(?:<[^>]*>)?\s*\(/.test(src);

// Remaining conversion work, by plan step (collection-factory-plan.md). Delete a name when its file lands on
// the factory; never add one without a reason.
const PENDING = new Set(["accessRules", "roles"]);

// Route shape without collection semantics. Not conversion debt - these are done.
const NOT_COLLECTIONS = new Map([
  ["bankFormats", "per-bank column mappings kept in one settings key: the id is the bank, PATCH upserts its blob"],
  ["payrollDebit", "one settings key rendered per bank: no table of its own, PATCH /:bank upserts the blob"],
  ["policy", "leave-policy key/value: the id is the policy key, PATCH sets its value"],
  ["preferences", "per-user key/value: the id is the preference key, PATCH upserts it"],
  ["settings", "org key/value blobs: the id is the settings key, PATCH upserts it"],
]);

describe("every collection is built by the factory", () => {
  const entries = Object.entries(sources).map(([path, src]) => ({ name: basename(path), src }));

  it("finds the route sources (the glob is not silently empty)", () => {
    expect(entries.length).toBeGreaterThan(80);
  });

  it("has no hand-rolled collection outside the PENDING budget", () => {
    const offenders = entries
      .filter((e) => isHandRolledCollection(e.src) && !usesFactory(e.src) && !PENDING.has(e.name) && !NOT_COLLECTIONS.has(e.name))
      .map((e) => e.name);
    expect(offenders, "build these with collectionRoutes() from src/http/collectionRoute.ts - a hand-rolled standard-method surface drifts").toEqual([]);
  });

  it("lists nothing in PENDING that has already been converted", () => {
    const stale = [...PENDING].filter((name) => {
      const entry = entries.find((e) => e.name === name);
      return entry ? usesFactory(entry.src) : true; // gone or converted -> the entry is stale
    });
    expect(stale, "these are on the factory (or no longer exist) - remove them from PENDING").toEqual([]);
  });

  it("has every converted collection actually going through the factory", () => {
    const converted = entries.filter((e) => usesFactory(e.src));
    expect(converted.length, "the conversion has landed a good number of collections by now").toBeGreaterThanOrEqual(32);
    // A converted file must not also hand-register the standard methods - that would mean two lanes in one file.
    const mixed = converted.filter((e) => isHandRolledCollection(e.src)).map((e) => e.name);
    expect(mixed, "a factory-built collection must not also register GET / and GET /:id by hand").toEqual([]);
  });

  // A bespoke purge exists for one reason: the row has children the generic purge knows nothing about (a
  // board's cards, a cycle's reviews, a transition's tasks, a suggestion's votes). Converting a collection and
  // forgetting to wire it as `overrides.purge` leaves `?force=true` deleting the parent and orphaning the
  // children - which no test noticed, twice, during this conversion. If one is defined, something must call it.
  it("wires every bespoke purge into a caller", () => {
    const all = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    const services = Object.entries(all).filter(([p]) => p.includes("/services/") && !p.endsWith("/softDelete.ts"));
    const stranded: string[] = [];
    for (const [path, src] of services) {
      for (const m of src.matchAll(/export (?:async function|const) (purge[A-Z]\w*)/g)) {
        const used = Object.entries(all).some(([p, s]) => p !== path && new RegExp(`\\b${m[1]}\\b`).test(s));
        if (!used) stranded.push(`${basename(path)}.${m[1]}`);
      }
    }
    expect(stranded, "a bespoke purge nothing calls - wire it as overrides.purge, or delete it if the generic purge is enough").toEqual([]);
  });

  // The spec is typed against its own table: `insert` / `patch` return `SetOf<T>`, so a mistyped column name is
  // a compile error instead of a value that silently never lands. That only holds while the table type reaches
  // the spec. `collectionRoutes<Input>(...)` with one type argument leaves it at the permissive default and
  // quietly turns the checking off, so name the table: `collectionRoutes<Input, typeof schema.x>(...)`.
  it("types every factory spec against its table", () => {
    const untyped = entries
      .filter((e) => /collectionRoutes<[^<>,]*>\s*\(/.test(e.src))
      .map((e) => e.name);
    expect(untyped, "pass the table type too: collectionRoutes<Input, typeof schema.<table>>({ ... })").toEqual([]);
  });

  // A collection's own verb is answered BEFORE the shared lifecycle lane (http/collectionRoute.ts), so an
  // overlap is resolved rather than silent. It is still worth seeing: a collection that claims `:disable` owns
  // the whole meaning of that verb, including whether the row's `disabled` column is written at all. This lists
  // every overlap so one arrives as a visible change here rather than as a surprise in the route file.
  it("names every collection verb that shadows a shared lifecycle verb", () => {
    const SHARED = ["enable", "disable", "lock", "unlock", "publish", "unpublish", "restore"];
    // Verbs a collection claims for itself, read off the top level of its `verbs: { ... }` block.
    const shadowed: string[] = [];
    for (const { name, src } of entries) {
      if (!usesFactory(src)) continue;
      const block = src.match(/\n  verbs: \{\n([\s\S]*?)\n  \},?\n/);
      if (!block) continue;
      for (const m of block[1]!.matchAll(/^    (\w+): \{/gm)) if (SHARED.includes(m[1]!)) shadowed.push(`${name}:${m[1]}`);
    }
    // `payroll-runs:publish` is a long-running publish that answers 202 + an Operation to poll, not the run, so
    // it can never be the shared lane's column write. `automations:enable/disable` write the SAME `disabled`
    // column the shared verb would, with the same audit stem - they exist to drop the engine's rule cache, which
    // the shared verb knows nothing about.
    expect(shadowed.sort()).toEqual(["automations:disable", "automations:enable", "payrollRuns:publish"]);
  });

  // The generic list binds the caller's scope (services/crud.ts), and these tables are FLAT catalogs: a `code`
  // and no owner column. So a grant that narrowed one of them to `dept` or `own` would no longer return the
  // whole table - it would return nothing, and the SPA would render an empty dropdown where a leave type or a
  // pay component belongs. Every seeded role that may read one of these must therefore read it org-wide. This
  // is a claim about the GRANT policy (domain/grants.ts), which is where such a change would be made.
  it("keeps every generic-list catalog readable org-wide, so binding the scope cannot empty it", () => {
    // Wire names of the collections with no route-level `list` hook. The count is pinned below, so a 16th
    // joining the generic path fails here rather than silently escaping the check.
    const GENERIC_LIST = [
      "benefit-plans", "compliance-rules", "expense-budgets", "expense-categories", "holidays", "leave-types",
      "letter-templates", "pay-components", "pay-grades", "pay-periods", "projects", "reimbursement-categories",
      "salary-structures", "shifts", "vendors",
    ];
    const genericListFiles = entries.filter((e) => usesFactory(e.src) && !/^\s*list:/m.test(e.src)).map((e) => e.name);
    expect(genericListFiles.length, `these list through crud.ts: ${genericListFiles.join(", ")} - keep GENERIC_LIST in step`).toBe(GENERIC_LIST.length);

    // An employee code so `dept` is derivable: without one actorScope cannot answer dept and would fall to own.
    const narrowed: string[] = [];
    for (const [role, grant] of Object.entries(GRANTS)) {
      const actor = { grant, employeeCode: "04-0001" };
      for (const collection of GENERIC_LIST) {
        if (!actorCan(actor, `${collection}.read`)) continue; // cannot read it at all - the middleware 403s first
        const scope = actorScope(actor, collection);
        if (scope !== "all") narrowed.push(`${role} reads ${collection} as ${scope}`);
      }
    }
    expect(narrowed, "a flat catalog has no owner column, so a narrowed read grant lists NOTHING - give the collection a route-level scoped list before narrowing it").toEqual([]);
  });

  // The exemption is only honest while the claim holds: a key/value surface has no create and no delete, because
  // the caller names the key and PATCH upserts it. Growing either makes it a collection, and this test says so.
  it.each([...NOT_COLLECTIONS])("keeps %s a key/value surface, not a collection (%s)", (name) => {
    const entry = entries.find((e) => e.name === name);
    expect(entry, `src/routes/${name}.ts is gone - drop it from NOT_COLLECTIONS`).toBeDefined();
    expect(/\.post\(\s*(?:"|`)\/(?:"|`)/.test(entry!.src), `${name} grew a create - it is a collection now, build it with collectionRoutes()`).toBe(false);
    expect(/\.delete\(/.test(entry!.src), `${name} grew a delete - it is a collection now, build it with collectionRoutes()`).toBe(false);
  });
});
