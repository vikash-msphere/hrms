/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createdMeta, removedMeta, stateMeta, fieldsMeta, rowValues, fieldDiff, diffMeta, audit, auditUpdate } from "../src/lib/audit";
// Glob every migration (ordered by filename) so squashing/adding migrations never breaks this suite.
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import { makeDeps } from "../src/deps";
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import type { Deps } from "../src/deps";

// The audit trail's meta is the difference between "someone changed a record" and "someone raised this salary
// from X to Y". These helpers are what every write in the app now goes through to say the second thing, so
// what they will and will not put in that table is asserted here rather than trusted.
describe("audit meta: what a create, a delete and a transition record", () => {
  it("records a create as a diff FROM nothing, and a delete as a diff TO nothing", () => {
    const row = { uuid: "abc", code: "04-001", name: "Asha", amount: 4200, createdAt: new Date(), updatedAt: new Date() };
    expect(createdMeta(row)).toEqual({ diff: { name: { from: null, to: "Asha" }, amount: { from: null, to: 4200 } } });
    expect(removedMeta(row)).toEqual({ diff: { name: { from: "Asha", to: null }, amount: { from: 4200, to: null } } });
  });

  it("keeps identity and timestamps out - they are already columns on the audit row itself", () => {
    expect(Object.keys(rowValues({ uuid: "a", code: "b", id: "c", createdAt: new Date(), updatedAt: new Date(), deleteTime: null, kind: "loan" })))
      .toEqual(["kind"]);
  });

  it("drops unset fields, so an entry states what a write DID rather than what it left alone", () => {
    expect(rowValues({ note: null, decidedBy: undefined, days: 0, billable: false })).toEqual({ days: 0, billable: false });
  });

  it("normalizes dates to ISO and leaves objects out (a blob has no readable form in a feed)", () => {
    const values = rowValues({ effectiveFrom: new Date("2026-03-01T00:00:00Z"), linesJson: { a: 1 }, tags: ["x"] });
    expect(values).toEqual({ effectiveFrom: "2026-03-01T00:00:00.000Z" });
  });

  it("truncates a long value rather than copying a whole description into every entry", () => {
    const long = "x".repeat(500);
    expect(String(rowValues({ description: long }).description)).toHaveLength(141); // 140 + the ellipsis
  });

  // The security-critical one. `audit_log` is readable by whoever holds the `audit` capability, which is a
  // wider set than the people who may read the record a secret came from - so a secret copied here outlives
  // its own access control. Nothing in the app sets one of these through a write path today; this test is what
  // keeps that true when a new column is added to a table one of these helpers is already pointed at.
  it("never copies a secret into the trail, whatever the column is called", () => {
    const row = {
      name: "CI key",
      hash: "aGFzaA==",
      tagSecret: "nonce-1234",
      apiToken: "tok_live_x",
      passwordSalt: "s",
      otpCode: "123456",
      signatureName: "Asha Rao",
      signatureKey: "signatures/abc",
      photoKey: "photos/abc",
      linesJson: "[]",
    };
    expect(rowValues(row)).toEqual({ name: "CI key" });
    expect(JSON.stringify(createdMeta(row))).not.toMatch(/aGFzaA|nonce-1234|tok_live_x|123456|Asha Rao/);
    // The same rule on the UPDATE path, which diffs whatever columns a mapper touched.
    expect(fieldDiff({ hash: "old" }, { hash: "new" }, ["hash"])).toEqual({});
  });

  // ENCRYPTED-AT-REST COLUMNS ARE SECRETS TOO, and they were the half the denylist missed: every one of them
  // is named `<what>Enc`, which matches none of the secret WORDS and none of the `(Json|Key)$` noise rule. So
  // the generic row walk treated them as ordinary strings, and soft-deleting or purging any employee copied
  // all five ciphertexts (truncated, but AES-GCM is CTR underneath, so a prefix still decrypts under the field
  // key) into `audit_log.meta` - a table whose readership is deliberately wider than the record's own.
  it("never records an encrypted-at-rest column", () => {
    const row = {
      firstName: "Asha",
      nationalIdEnc: "ZW5jcnlwdGVkLW5hdGlvbmFsLWlk",
      bankDetailsEnc: "ZW5jcnlwdGVkLWJhbms=",
      identityDetailsEnc: "ZW5jcnlwdGVkLWlkZW50aXR5",
      personalDetailsEnc: "ZW5jcnlwdGVkLXBlcnNvbmFs",
      taxDetailsEnc: "ZW5jcnlwdGVkLXRheA==",
    };
    expect(rowValues(row, "employees")).toEqual({ firstName: "Asha" });
    expect(JSON.stringify(removedMeta(row, "employees"))).not.toMatch(/ZW5jcnlwdGVk/);
    // And on the update path, which diffs whatever columns a mapper happened to set.
    expect(fieldDiff({ nationalIdEnc: "old" }, { nationalIdEnc: "new" }, ["nationalIdEnc"])).toEqual({});
  });

  // A foreign key stored as its bare column value is two problems at once: unreadable, and an INTERNAL id on
  // the wire (middleware/encodeWireIds only tokenizes `<collection>/<id>` strings, so a bare one is published
  // raw). Both are fixed by the same thing - writing it as a ref - so both are asserted here.
  it("writes a foreign key as a resource ref, never the raw internal id", () => {
    const values = rowValues({ employeeId: "aa11bb22cc33d", leaveTypeId: "zz99yy88xx77w", days: 3 }, "leave-requests");
    expect(values).toEqual({ employeeId: "employees/aa11bb22cc33d", leaveTypeId: "leave-types/zz99yy88xx77w", days: 3 });
    expect(JSON.stringify(values)).not.toMatch(/"aa11bb22cc33d"|"zz99yy88xx77w"/); // never the bare id
  });

  it("reads the FK target from the schema, so a column name shared by two tables resolves to the right one", () => {
    // `categoryId` is an expense category here and an asset category on asset-requests. A name-based guess
    // gets exactly this wrong, which is why the lookup goes through Drizzle's FK metadata.
    expect(rowValues({ categoryId: "cat1234567890" }, "expenses")).toEqual({ categoryId: "expense-categories/cat1234567890" });
    expect(rowValues({ categoryId: "cat1234567890" }, "asset-requests")).toEqual({ categoryId: "asset-categories/cat1234567890" });
  });

  it("resolves refs on the update path too, not only on create and delete", () => {
    expect(fieldDiff({ assigneeId: "aa11bb22cc33d" }, { assigneeId: "ee55ff66gg77h" }, ["assigneeId"], "tickets"))
      .toEqual({ assigneeId: { from: "employees/aa11bb22cc33d", to: "employees/ee55ff66gg77h" } });
  });

  it("leaves a non-FK string alone - not every 13-character column is an id", () => {
    expect(rowValues({ reason: "family wedding", state: "PENDING" }, "leave-requests"))
      .toEqual({ reason: "family wedding", state: "PENDING" });
  });

  // `/(Json|Key)$/` is excluded by default and must stay so - but for a few records the blob IS the record,
  // and those writes used to audit as a bare "updated" with nothing under them.
  it("expands an opted-in blob into per-key entries, and leaves every other blob out", () => {
    const before = { ratingsJson: JSON.stringify({ communication: 3, delivery: 4 }) };
    const after = { ratingsJson: JSON.stringify({ communication: 5, delivery: 4 }) };
    expect(fieldDiff(before, after, ["ratingsJson"], "interview-feedback"))
      .toEqual({ "ratings.communication": { from: 3, to: 5 } }); // only what moved; `delivery` is unchanged
    // A collection that has not opted in keeps the blob out entirely.
    expect(fieldDiff({ linesJson: "[1]" }, { linesJson: "[2]" }, ["linesJson"], "payslips")).toEqual({});
  });

  it("keys an array blob by the item's own key, so a reorder is one entry and not N", () => {
    const cols = (order: string[]) => JSON.stringify(order.map((k) => ({ key: k, label: k, wipLimit: null })));
    const diff = fieldDiff({ columnsJson: cols(["todo", "doing", "done"]) }, { columnsJson: cols(["doing", "todo", "done"]) }, ["columnsJson"], "boards");
    expect(Object.keys(diff)).toEqual(["columns.order"]); // the columns themselves did not change, their order did
    expect(diff["columns.order"]).toEqual({ from: "todo › doing › done", to: "doing › todo › done" });
  });

  it("names the renamed column rather than reporting the whole board changed", () => {
    const cols = (label: string) => JSON.stringify([{ key: "doing", label }]);
    const diff = fieldDiff({ columnsJson: cols("Doing") }, { columnsJson: cols("In progress") }, ["columnsJson"], "boards");
    expect(diff["columns.doing"]!.from).toContain("Doing");
    expect(diff["columns.doing"]!.to).toContain("In progress");
  });

  // The regression this guards: excluding blobs from `fieldDiff` silenced every collection whose substance IS
  // a blob - editing an automation's actions audited as a bare "updated" with nothing under it. Naming the
  // column is not the whole story, but it is a true one, and it is what the feed already renders.
  it("names a blob that changed but is not expanded, rather than saying nothing", () => {
    const meta = diffMeta({ actionsJson: "[1]" }, { actionsJson: "[2]" }, { actionsJson: "[2]" }, "automations");
    expect(meta).toEqual({ changed: ["actionsJson"] });
    // An expanded one reports its keys instead, and is NOT also listed by name.
    const board = diffMeta({ ratingsJson: '{"a":1}' }, { ratingsJson: '{"a":2}' }, { ratingsJson: "" }, "interview-feedback");
    expect(board).toEqual({ diff: { "ratings.a": { from: 1, to: 2 } } });
    // An unchanged blob is not reported at all.
    expect(diffMeta({ actionsJson: "[1]" }, { actionsJson: "[1]" }, { actionsJson: "[1]" }, "automations")).toBeUndefined();
  });

  // `auditUpdate` drops the row when diffMeta says nothing changed, so a change the diff may not SHOW must still
  // count as a change, or an edit that moved only a secret would vanish from the trail. Named, never valued.
  it("names a secret, encrypted or denied column that changed, and never its value", () => {
    expect(diffMeta({ tagSecret: "a" }, { tagSecret: "b" }, { tagSecret: "b" }, "assets")).toEqual({ changed: ["tagSecret"] });
    expect(diffMeta({ bankDetailsEnc: "x" }, { bankDetailsEnc: "y" }, { bankDetailsEnc: "y" }, "employees")).toEqual({ changed: ["bankDetails"] });
    expect(diffMeta({ submitterId: "aa11bb22cc33d" }, { submitterId: "zz99yy88xx77w" }, { submitterId: "zz99yy88xx77w" }, "suggestions")).toEqual({ changed: ["submitterId"] });
    expect(diffMeta({ tagSecret: "a" }, { tagSecret: "a" }, { tagSecret: "a" }, "assets")).toBeUndefined();
  });

  // audit_log is read through a capability that knows nothing about a review's state, and the manager's
  // assessment is withheld from the employee until the review is SHARED. So none of it may be copied into an
  // entry - not the ratings blob (which is why `reviews` is not in DIFFABLE_BLOBS) and not the two plain
  // columns beside it, which no name-matched rule would ever catch.
  it("keeps a manager's unshared assessment out of the trail entirely", () => {
    expect(fieldDiff(
      { managerComment: "not ready", overallRating: 2, ratingsJson: '{"a":1}' },
      { managerComment: "coasting", overallRating: 3, ratingsJson: '{"a":2}' },
      ["managerComment", "overallRating", "ratingsJson"],
      "reviews",
    )).toEqual({});
    expect(rowValues({ managerComment: "not ready", overallRating: 2, state: "SELF" }, "reviews")).toEqual({ state: "SELF" });
  });

  // The suggestion box's one promise. The row's serializer hides an anonymous submitter and the reviewer nudge
  // drops the actor face; a create that copied `submitter_id` into the meta handed it straight back.
  it("keeps a suggestion's submitter out of the trail", () => {
    expect(rowValues({ submitterId: "aa11bb22cc33d", title: "better coffee" }, "suggestions")).toEqual({ title: "better coffee" });
  });

  // A private 1:1 note is served to the ONE person who wrote it. Neither column matches SECRETISH or the
  // Json/Key rule, so an edit used to copy both sides of the note into the meta as a from/to pair.
  it("keeps private check-in notes out of the trail", () => {
    expect(fieldDiff({ employeeNote: "old" }, { employeeNote: "new" }, ["employeeNote"], "check-ins")).toEqual({});
    expect(rowValues({ employeeNote: "mine", counterpartNote: "theirs", meetingDate: "2026-01-02" }, "check-ins"))
      .toEqual({ meetingDate: "2026-01-02" });
  });

  it("applies the field cap and the secret denylist INSIDE a blob too", () => {
    const wide = JSON.stringify(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`c${i}`, i])));
    expect(Object.keys(rowValues({ ratingsJson: wide }, "interview-feedback")).length).toBeLessThanOrEqual(24);
    expect(rowValues({ ratingsJson: JSON.stringify({ apiToken: "tok_live_x", communication: 4 }) }, "interview-feedback"))
      .toEqual({ "ratings.communication": 4 });
  });

  it("caps how many fields one entry carries - a trail, not a dump", () => {
    const wide = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}`, i + 1]));
    expect(Object.keys(rowValues(wide))).toHaveLength(24);
  });

  it("records a transition as the state it moved FROM, which is what tells a repeat from a first decision", () => {
    expect(stateMeta("PENDING", "APPROVED")).toEqual({ diff: { status: { from: "PENDING", to: "APPROVED" } } });
    expect(stateMeta("PENDING", "REJECTED", { reason: "over budget" }))
      .toEqual({ diff: { status: { from: "PENDING", to: "REJECTED" } }, reason: "over budget" });
    // A no-op flip has no change to state; whatever else the caller attached still rides.
    expect(stateMeta("PAID", "PAID", { employee: "employees/x" })).toEqual({ employee: "employees/x" });
  });

  it("records the FIELD NAMES only for the sub-resources whose values must never leave the record", () => {
    expect(fieldsMeta({ account_number: "12345678", ifsc_code: "HDFC0001", account_name: undefined }))
      .toEqual({ fields: ["account_number", "ifsc_code"] });
    expect(fieldsMeta({})).toBeUndefined();
  });

  it("says nothing rather than something empty, so a caller can spread it unconditionally", () => {
    expect(createdMeta(null)).toBeUndefined();
    expect(createdMeta({ uuid: "a", updatedAt: new Date() })).toBeUndefined();
    expect(removedMeta(undefined)).toBeUndefined();
  });
});

// One act writes many entries. Without a shared trace they are unrelated lines that happen to share a
// timestamp, and "what else did that request change?" - the question every incident review opens with - has no
// answer. The trace is minted per request (middleware) or per cron tick and parked on Deps, which is also
// where the workflow engine reads it, so an automation's writes land under the act that triggered them.
describe("audit lineage: one act, one trace", () => {
  const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const b = env as unknown as Bindings;
  let deps: Deps;
  beforeAll(async () => {
    (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
    (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
    for (const stmt of migrationSql.split("--> statement-breakpoint")) {
      const t = stmt.trim();
      if (t) await b.DB.prepare(t).run();
    }
    deps = makeDeps(b);
  });
  const actor = { uuid: "u1", email: "priya@test.example", role: "payroll_admin", status: "active", employeeId: null, employeeCode: null, name: "Priya" } as unknown as AppUser;
  const entries = async (action: string) => (await deps.db.select().from(schema.auditLog)).filter((r) => r.action === action);

  it("stamps every entry of one act with the same correlation id, and none when untraced", async () => {
    await audit(deps, actor, "lineage.untraced", "employees", "aa11bb22cc33d");
    expect((await entries("lineage.untraced"))[0]!.correlationId).toBeNull();

    deps.trace = "trace-abc";
    await audit(deps, actor, "lineage.one", "employees", "aa11bb22cc33d");
    await audit(deps, actor, "lineage.two", "compensation", "zz99yy88xx77w");
    deps.trace = undefined;

    const both = [...(await entries("lineage.one")), ...(await entries("lineage.two"))];
    expect(both).toHaveLength(2);
    expect(new Set(both.map((r) => r.correlationId))).toEqual(new Set(["trace-abc"])); // two records, one act
  });

  it("records the role the act was performed under, not just who performed it", async () => {
    await audit(deps, actor, "lineage.role", "employees", "aa11bb22cc33d");
    expect((await entries("lineage.role"))[0]!.actorRole).toBe("payroll_admin");
    // A string actor (system/cron call sites) has no role to snapshot rather than a guessed one.
    await audit(deps, "system", "lineage.systemRole", "employees", "aa11bb22cc33d");
    expect((await entries("lineage.systemRole"))[0]!.actorRole).toBeNull();
  });

  it("names WHAT acted when the actor is the system principal", async () => {
    deps.actingAs = { kind: "automation", name: "Auto-approve short leave", ref: "automations/rule1234567ab" };
    await audit(deps, "system", "lineage.byRule", "leave-requests", "aa11bb22cc33d");
    deps.actingAs = { kind: "cron", name: "0 2 * * *", ref: "cron-runs/run1234567abc" };
    await audit(deps, "system", "lineage.byCron", "leave-balances", undefined);
    deps.actingAs = undefined;

    const rule = JSON.parse((await entries("lineage.byRule"))[0]!.meta!) as { via_automation: { name: string; ref: string } };
    expect(rule.via_automation).toEqual({ name: "Auto-approve short leave", ref: "automations/rule1234567ab" });
    const cron = JSON.parse((await entries("lineage.byCron"))[0]!.meta!) as { via_cron: { name: string } };
    expect(cron.via_cron.name).toBe("0 2 * * *");
  });

  it("keeps the acting label alongside a caller's own meta rather than replacing it", async () => {
    deps.actingAs = { kind: "automation", name: "Nudge stale reviews" };
    await audit(deps, "system", "lineage.merged", "reviews", "aa11bb22cc33d", { diff: { state: { from: "SELF", to: "MANAGER" } } });
    deps.actingAs = undefined;
    const meta = JSON.parse((await entries("lineage.merged"))[0]!.meta!) as Record<string, unknown>;
    expect(meta.diff).toBeTruthy();
    expect(meta.via_automation).toBeTruthy();
  });

  // A save that changed nothing writes no row. It still marks the request as audited: the authz write backstop
  // logs any write that wrote no row of its own, and would otherwise record the same no-op as a generic entry.
  it("writes no update row when nothing changed, and keeps the write backstop from writing one instead", async () => {
    const u = { ...actor, audited: false } as AppUser;
    await auditUpdate(deps, u, "lineage.noop", "employees", "aa11bb22cc33d", undefined);
    expect(await entries("lineage.noop")).toHaveLength(0);
    expect(u.audited).toBe(true);
    await auditUpdate(deps, u, "lineage.changed", "employees", "aa11bb22cc33d", { diff: { title: { from: "a", to: "b" } } });
    expect(await entries("lineage.changed")).toHaveLength(1);
  });
});

// "Everything that happened to Asha" spans a dozen collections. The entry anchors on the touched RECORD, so
// without a subject column that question is a LIKE over a JSON text field - which is a scan, and which the
// employee profile therefore could not offer at all.
describe("audit subject: the person an entry is about", () => {
  const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const b = env as unknown as Bindings;
  let deps: Deps;
  beforeAll(async () => {
    (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
    (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
    for (const stmt of migrationSql.split("--> statement-breakpoint")) {
      const t = stmt.trim();
      if (t) await b.DB.prepare(t).run();
    }
    deps = makeDeps(b);
  });
  const actor = { uuid: "u2", email: "hr@test.example", role: "hr_admin", status: "active", employeeId: "mgr1234567890", employeeCode: null, name: "HR" } as unknown as AppUser;
  const entries = async (action: string) => (await deps.db.select().from(schema.auditLog)).filter((r) => r.action === action);

  it("takes the subject from the `employee` ref the meta already carries", async () => {
    await audit(deps, actor, "subject.withEmployee", "leave-requests", "req1234567890", { employee: "employees/asha123456789" });
    expect((await entries("subject.withEmployee"))[0]!.subjectId).toBe("asha123456789");
  });

  it("is null when the entry is about a record rather than a person", async () => {
    await audit(deps, actor, "subject.none", "boards", "brd1234567890", { diff: { name: { from: "A", to: "B" } } });
    expect((await entries("subject.none"))[0]!.subjectId).toBeNull();
  });

  it("is the SUBJECT, not the actor - the two differ wherever somebody acts on another person's record", async () => {
    await audit(deps, actor, "subject.onBehalf", "leave-requests", "req2234567890", { employee: "employees/asha123456789" });
    const row = (await entries("subject.onBehalf"))[0]!;
    expect(row.subjectId).toBe("asha123456789");
    expect(row.actorId).toBe("mgr1234567890");
  });
});

// A job runs in a later invocation than the request that enqueued it, so without carrying the trace the async
// half of every long operation - the payslips a publish generates, a workflow timer that fires days later - is
// orphaned from the act it came from.
describe("audit lineage: an enqueued job belongs to the act that enqueued it", () => {
  const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const b = env as unknown as Bindings;
  let deps: Deps;
  beforeAll(async () => {
    (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
    (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
    for (const stmt of migrationSql.split("--> statement-breakpoint")) {
      const t = stmt.trim();
      if (t) await b.DB.prepare(t).run();
    }
    deps = makeDeps(b);
  });

  it("stamps the enqueuing trace onto the job payload, and the runner adopts it", async () => {
    // The shape both halves agree on: publishRun writes it, cron's processOneJob reads it back.
    deps.trace = "act-xyz";
    const payload = JSON.stringify({ runId: "run1234567890", correlationId: deps.trace });
    deps.trace = undefined;
    expect(JSON.parse(payload).correlationId).toBe("act-xyz");

    // What the runner then does: the job's own writes land under the act, not under the tick draining it.
    const tickTrace = "tick-123";
    deps.trace = tickTrace;
    deps.trace = JSON.parse(payload).correlationId;
    await audit(deps, "system", "lineage.jobWrite", "payslips", "slip123456789");
    deps.trace = tickTrace;
    const row = (await deps.db.select().from(schema.auditLog)).find((r) => r.action === "lineage.jobWrite")!;
    expect(row.correlationId).toBe("act-xyz");
    expect(deps.trace).toBe(tickTrace); // and the tick gets its own trace back
    deps.trace = undefined;
  });
});
