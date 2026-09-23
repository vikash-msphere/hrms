/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { clearCache } from "../src/lib/cache";
import { invalidateCodeCache } from "../src/lib/authzResolve";
import { deriveNarrowing } from "../src/domain/compileGrants";
import { PROTECTED_FIELDS, REFERENCES, OWNER_REFS, SUBRESOURCE_BODY, subresourceBodyKey } from "../src/domain/manifests";
import type { Level } from "../src/domain/permissions";
import { app } from "../src/index";

// The WHOLE body-level access gate (middleware/authz.ts bodyDecision), driven over real HTTP, table-driven off
// the policy itself (src/domain/manifests.ts) rather than off a hand-picked example.
//
// The gate decides four separate things - protected fields, declared references, owner-on-create, and per-field
// sub-resource writes - and it had exactly one HTTP-level test, over one field of one collection. That is how
// the gate came to run switched OFF for every PATCH in the app without a test going red: its content-type
// predicate missed `application/merge-patch+json` (the type openapi.yaml declares for all 70 Updates and
// web/src/api.ts sends on every PATCH), and no test asked it a question over HTTP on that type.
//
// So every entry in PROTECTED_FIELDS, REFERENCES, OWNER_REFS and SUBRESOURCE_BODY gets a case here, and each
// case is asserted on BOTH JSON content types. A gate that holds for one and not the other is the bug class
// this file exists to catch.
//
// Each case makes three assertions, which together pin the denial to the gate rather than to anything else on
// the request path (the response body is deliberately generic, so the reason cannot be read off it):
//
//   1. no field grant + the gated field present  -> 403      (the gate denies)
//   2. no field grant + the field ABSENT         -> not 403   (so #1 was the field, not the resource-level
//                                                              write, the route, or the caller's identity)
//   3. WITH the field grant + the field present  -> not 403   (so the grant is what unlocks it - and, for a
//                                                              reference/owner case, that the target really
//                                                              resolves: an unresolved ref denies even here)
//
// "not 403" rather than a specific status on purpose: these bodies carry ONE field, so a request the gate lets
// through goes on to fail its own schema validation. What is being tested is the gate's verdict, not the
// handler's.
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const ROLE = "gate_tester";
let deps: Deps;
const b = env as unknown as Bindings;

// Both JSON content types the API speaks: `application/json` is what a create posts, and the merge-patch type
// is what every Update sends - the one that used to walk straight past this gate.
const JSON_TYPES = ["application/json", "application/merge-patch+json"];

// One row per collection any case has to name, seeded ONCE (the fixtures are read-only as far as the gate is
// concerned; only the access rules change per case). `uuid` is what a body ref carries, `code` is what the
// engine decides on.
const fixture: Record<string, string> = {}; // collection -> uuid of its fixture row
let callerEmail = "";
let otherEmployeeId = ""; // the owner/target that is NOT the caller
let targetUserId = "";
let compensationId = "";

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  (b as Record<string, unknown>).ALLOW_DEV_AUTH = "true";
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);

  await deps.db.insert(schema.roles).values([{ name: ROLE, label: "Gate tester" }, { name: "employee", label: "Employee" }]);

  // Flat fixture codes: one token, no hyphen, so a `<collection>.**` grant covers them and none of them can be
  // read as a scoped (dept-prefixed) code.
  let n = 0;
  const flat = () => `z${String(++n).padStart(4, "0")}`;
  const put = async (collection: string, table: any, values: Record<string, unknown>) => {
    const uuid = genId();
    await deps.db.insert(table).values({ uuid, code: flat(), ...values });
    fixture[collection] = uuid;
    return uuid;
  };

  // The caller and one OTHER person. Employee codes are dept-scoped, so "04-002" is a sibling of the caller
  // rather than something under them - which is what makes a `me`-scoped write grant deny the owner gate.
  const deptId = genId();
  await deps.db.insert(schema.departments).values({ uuid: deptId, code: "04", name: "Ops" });
  fixture.departments = deptId;
  const callerEmpId = genId();
  await deps.db.insert(schema.employees).values({ uuid: callerEmpId, code: "04-001", firstName: "Caller", lastName: "T", workEmail: "caller@test.example", status: "active" });
  otherEmployeeId = genId();
  await deps.db.insert(schema.employees).values({ uuid: otherEmployeeId, code: "04-002", firstName: "Other", lastName: "T", workEmail: "other@test.example", status: "active" });
  fixture.employees = otherEmployeeId;
  callerEmail = "caller@test.example";
  await deps.db.insert(schema.users).values({ uuid: genId(), code: "z9001", email: callerEmail, role: ROLE, employeeId: callerEmpId });
  // A second account, so the users protected-field cases patch somebody else's row (an admin may not strip
  // their own role - that guard would answer for the wrong reason).
  targetUserId = genId();
  await deps.db.insert(schema.users).values({ uuid: targetUserId, code: "z9002", email: "other@test.example", role: "employee", employeeId: otherEmployeeId });
  compensationId = genId();
  await deps.db.insert(schema.compensation).values({ uuid: compensationId, code: "04-002-1", employeeId: otherEmployeeId, basePay: 50000, effectiveFrom: new Date("2026-01-01") });

  // Reference targets. Only `uuid` + `code` matter to the gate (uuidToCode); the rest is whatever the table
  // requires NOT NULL.
  await put("leave-types", schema.leaveTypes, { name: "Casual" });
  await put("holidays", schema.holidays, { name: "Republic Day", date: new Date("2026-01-26") });
  await put("pay-periods", schema.payPeriods, { label: "2026-01", periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-01-31"), payDate: new Date("2026-01-31") });
  await put("reimbursement-categories", schema.reimbursementCategories, { name: "Travel" });
  await put("asset-categories", schema.assetCategories, { name: "Laptops", tagCode: "LAP" });
  await put("stocktakes", schema.stocktakes, { label: "Q1 count", startedAt: new Date("2026-01-05") });
  await put("benefit-plans", schema.benefitPlans, { name: "Health base" });
  await put("shifts", schema.shifts, { name: "General" });
  await put("projects", schema.projects, { name: "Platform" });
  await put("pay-grades", schema.payGrades, { name: "L3" });
  await put("boards", schema.boards, { name: "Delivery" });
  await put("goals", schema.goals, { employeeId: otherEmployeeId, title: "Ship it" });
  await put("review-cycles", schema.reviewCycles, { name: "H1 2026" });
  await put("sprints", schema.sprints, { boardId: fixture.boards!, name: "Sprint 1" });
  await put("referrals", schema.referrals, { referrerId: otherEmployeeId, candidateName: "Ada" });
  await put("candidates", schema.candidates, { name: "Ada Lovelace" });
  await put("job-requisitions", schema.jobRequisitions, { title: "Engineer" });
  await put("applications", schema.applications, { candidateId: fixture.candidates!, requisitionId: fixture["job-requisitions"]! });
  await put("interviews", schema.interviews, { applicationId: fixture.applications!, title: "Technical round" });
  // Not a reference target - the object an item-level custom method (`assets/<id>:verify`) is addressed by.
  await put("assets", schema.assets, { name: "MacBook Pro 14" });

  (b as Record<string, unknown>).DEV_FAKE_EMAIL = callerEmail;
});

// Seed exactly these grant patterns as the test role's rules. Written verbatim, with the narrowing derived the
// same way compileGrant derives it, so the engine sees the pattern the case is about and nothing else. A `null`
// level is a custom-method (verb) rule.
type Rule = [string, Level | null];
async function withRules(patterns: Rule[]) {
  await deps.db.delete(schema.accessRules);
  await deps.db.insert(schema.accessRules).values(
    patterns.map(([pattern, level]) => {
      const n = deriveNarrowing(pattern);
      // Same rewrite compileGrant does: a 2-token VERB rule ("assets.batchCreate") is a collection-level
      // capability, not a per-object row - leaving it on the exact lane would drop it from the broad grant.
      const broadVerb = level === null && n.scopeKind === "exact" && pattern.split(".").length === 2;
      const scopeKind = broadVerb ? ("all" as const) : n.scopeKind;
      const scopeCode = broadVerb ? "" : n.scopeCode;
      return { subject: ROLE, subjectKind: "role" as const, namespace: n.namespace, pattern, scopeKind, scopeCode, matchCode: null, level, effect: "allow" as const };
    }),
  );
  clearCache(); // the role-grant loader caches for ~5s
  invalidateCodeCache();
}

const send = (method: string, path: string, body: unknown, contentType: string) =>
  app.request(
    path,
    { method, headers: { "X-Requested-By": "hrms-spa", "Content-Type": contentType }, body: JSON.stringify(body) },
    b as unknown as Record<string, unknown>,
  );

/**
 * One gate case: the three assertions above, run on both JSON content types.
 *
 * `withField` is the body that carries the gated thing; `withoutField` is the same request without it (the
 * control that proves the 403 is the gate's and not the route's).
 */
async function assertGate(opts: {
  method: "POST" | "PATCH";
  path: string;
  withField: unknown;
  withoutField: unknown;
  denyRules: Rule[];
  allowRules: Rule[];
}) {
  await withRules(opts.denyRules);
  for (const ct of JSON_TYPES) {
    expect((await send(opts.method, opts.path, opts.withField, ct)).status, `expected the gate to DENY on ${ct}`).toBe(403);
    expect((await send(opts.method, opts.path, opts.withoutField, ct)).status, `the same request WITHOUT the gated field must not be 403 on ${ct}`).not.toBe(403);
  }
  await withRules(opts.allowRules);
  for (const ct of JSON_TYPES) {
    expect((await send(opts.method, opts.path, opts.withField, ct)).status, `the field/reference grant must ALLOW the gate on ${ct}`).not.toBe(403);
  }
}

// ---- 1. Protected fields -------------------------------------------------------------------------------
//
// The row each collection's cases patch. A protected field is gated on PRESENCE, so every case sends the field
// as `null` - which needs no valid target value and keeps the table uniform across the three collections.
const FIELD_TARGET: Record<string, () => string> = {
  users: () => targetUserId,
  employees: () => otherEmployeeId,
  compensation: () => compensationId,
};

describe("protected fields: every entry in PROTECTED_FIELDS, over HTTP, on both JSON content types", () => {
  it("has a case for every collection in the policy", () => {
    expect(Object.keys(PROTECTED_FIELDS).sort()).toEqual(Object.keys(FIELD_TARGET).sort());
  });

  for (const [collection, fields] of Object.entries(PROTECTED_FIELDS)) {
    for (const field of fields) {
      it(`${collection}.${field} needs write on the field, not just on the record`, async () => {
        // `<col>.*` grants write on the RECORD (2 tokens) but cannot reach the 3-token field resource;
        // `<col>.*.<field>` is exactly the field grant. `<col>` alone is the create gate, harmless here.
        const record: Rule[] = [[collection, "write"], [`${collection}.*`, "write"]];
        await assertGate({
          method: "PATCH",
          path: `/v1/${collection}/${FIELD_TARGET[collection]!()}`,
          withField: { [field]: null },
          withoutField: {},
          denyRules: record,
          allowRules: [...record, [`${collection}.*.${field}`, "write"]],
        });
      });
    }
  }
});

// ---- 2. Per-field sub-resource writes ------------------------------------------------------------------
//
// One representative key per field-bearing sub-resource. The key itself is never validated by the gate (the
// leaf names are admin-configurable, see manifests.isFieldScopeTarget), so what matters is that a key PRESENT
// in the field map is gated at `employees.<code>.<sub>.<key>`.
const SUB_FIELD_KEY: Record<string, string> = {
  identity: "uan",
  "bank-account": "account_number",
  "personal-info": "blood_group",
  tax: "regime",
};

describe("sub-resource field writes: every entry in SUBRESOURCE_BODY, on both JSON content types", () => {
  it("has a case for every field-gated sub-resource", () => {
    expect(Object.keys(SUBRESOURCE_BODY).sort()).toEqual(Object.keys(SUB_FIELD_KEY).sort());
  });

  for (const sub of Object.keys(SUBRESOURCE_BODY)) {
    it(`employees/<id>/${sub} gates each key in its field map`, async () => {
      const wrapper = subresourceBodyKey(sub)!; // "" means the body IS the field map
      const map = { [SUB_FIELD_KEY[sub]!]: "x" };
      const withField = wrapper === "" ? map : { [wrapper]: map };
      // `employees.*.<sub>` write is the WHOLE sub-resource grant: it passes the resource-level write on the
      // path but cannot reach the 4-token per-field resource. `employees.*.<sub>.**` reaches both.
      const whole: Rule[] = [["employees", "write"], [`employees.*.${sub}`, "write"]];
      await assertGate({
        method: "PATCH",
        path: `/v1/employees/${otherEmployeeId}/${sub}`,
        withField,
        withoutField: wrapper === "" ? {} : { [wrapper]: {} },
        denyRules: whole,
        allowRules: [["employees", "write"], [`employees.*.${sub}.**`, "write"]],
      });
    });
  }
});

// ---- 3. Declared references ----------------------------------------------------------------------------

describe("declared references: every entry in REFERENCES, on both JSON content types", () => {
  it("has a seeded fixture row for every reference TARGET collection", () => {
    const targets = [...new Set(Object.values(REFERENCES).flatMap((refs) => Object.values(refs).map((r) => r.collection)))];
    expect(targets.filter((t) => !fixture[t])).toEqual([]);
  });

  for (const [collection, refs] of Object.entries(REFERENCES)) {
    for (const [field, spec] of Object.entries(refs)) {
      it(`${collection}.${field} needs ${spec.level} on the referenced ${spec.collection}`, async () => {
        // The create gate alone: the caller may create in `<collection>` but holds nothing on the ref target,
        // so the only thing that can deny is the reference gate.
        const create: Rule[] = [[collection, "write"]];
        await assertGate({
          method: "POST",
          path: `/v1/${collection}`,
          withField: { [field]: `${spec.collection}/${fixture[spec.collection]}` },
          withoutField: {},
          denyRules: create,
          allowRules: [...create, [`${spec.collection}.**`, spec.level]],
        });
      });
    }
  }
});

// ---- 3b. The same gate on a CUSTOM METHOD's body -------------------------------------------------------
//
// A custom method carries its verb in the last path segment, and the gate is about the collection and the
// object. Both spellings have to reach it: `assets:batchCreate` (collection-level, and the one route the
// bulk-items loop in bodyDecision was written for) and `assets/<code>:verify` (item-level).

describe("custom-method bodies reach the body gate", () => {
  // The two verb grants themselves, so the only thing left that can deny is the body gate.
  const batch: Rule[] = [["assets", "write"], ["assets.batchCreate", null]];
  const verify: Rule[] = [["assets.**", "write"], ["assets.*.verify", null]];
  const catRef = () => `asset-categories/${fixture["asset-categories"]}`;

  it("gates a reference inside assets:batchCreate, per record in the envelope", async () => {
    // The bulk envelope is many records in one request; wrapping a record in `items` must not be a way past
    // the reference gate, so each record is gated. The single-record body is asserted first, then the envelope.
    await assertGate({
      method: "POST",
      path: "/v1/assets:batchCreate",
      withField: { items: [{ name: "Laptop" }, { name: "Laptop", category: catRef() }] },
      withoutField: { items: [{ name: "Laptop" }] },
      denyRules: batch,
      allowRules: [...batch, ["asset-categories.**", "read"]],
    });
  });

  // The ceiling on the bulk loop REFUSES; it does not walk the first N and wave the rest through. That
  // direction matters more than the number: the gate used to slice the list, so a caller holding no reference
  // grant could put the record it was not allowed to write past position N and have it arrive ungated. No
  // route accepts a list this long anyway (ASSET_BATCH_MAX is 100), which is exactly why nothing would have
  // noticed. The grant here is the FULL allow set, so the only thing left that can answer 403 is the ceiling.
  it("refuses a bulk envelope longer than the gate will walk, rather than gating part of it", async () => {
    await withRules([...batch, ["asset-categories.**", "read"]]);
    const items = (n: number) => ({ items: Array.from({ length: n }, () => ({ name: "Laptop", category: catRef() })) });
    expect((await send("POST", "/v1/assets:batchCreate", items(200), JSON_TYPES[0]!)).status).not.toBe(403);
    expect((await send("POST", "/v1/assets:batchCreate", items(201), JSON_TYPES[0]!)).status).toBe(403);
  });

  it("gates a reference on an item-level verb, whose code is not `<code>:verb`", async () => {
    // `assets:verify` carries a `stocktake` ref: filing a sighting against a count you cannot read would be
    // recording into somebody else's report. The path's code segment must be the code, not code-plus-verb.
    await assertGate({
      method: "POST",
      path: `/v1/assets/${fixture.assets}:verify`,
      withField: { stocktake: `stocktakes/${fixture.stocktakes}` },
      withoutField: {},
      denyRules: verify,
      allowRules: [...verify, ["stocktakes.**", "read"]],
    });
  });
});

// ---- 4. Owner on create --------------------------------------------------------------------------------

describe("owner refs: every entry in OWNER_REFS, on both JSON content types", () => {
  it("every owner ref targets employees (the fixture this table assumes)", () => {
    const targets = [...new Set(Object.values(OWNER_REFS).flatMap((o) => Object.values(o).map((r) => r.collection)))];
    expect(targets).toEqual(["employees"]);
  });

  for (const [collection, owners] of Object.entries(OWNER_REFS)) {
    for (const field of Object.keys(owners)) {
      it(`${collection}.${field} may not name an owner the caller cannot write under`, async () => {
        // Self-scoped write: the caller may create their OWN rows in this collection. The body names a sibling
        // employee (04-002, not under the caller's 04-001), so creating on their behalf must be refused.
        const own: Rule[] = [[collection, "write"], [`${collection}.me.**`, "write"]];
        await assertGate({
          method: "POST",
          path: `/v1/${collection}`,
          withField: { [field]: `employees/${otherEmployeeId}` },
          withoutField: {},
          denyRules: own,
          allowRules: [[collection, "write"], [`${collection}.**`, "write"]],
        });
      });
    }
  }
});
