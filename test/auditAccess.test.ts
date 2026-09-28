import { describe, it, expect } from "vitest";
import { accessAudit, mutationAudit, READ_VERBS } from "../src/domain/auditAccess";
import { AUDIT } from "../bootstrap/authz/policy";
import { COLLECTIONS } from "../src/domain/collections";
import type { Decision } from "../src/domain/permissions";
import { decide, resolveRequest } from "../src/domain/permissions";

// Audit coverage: the middleware records every denial + every sensitive allowed read, and nothing else.
const ALLOW: Decision = { allow: true };
const DENY: Decision = { allow: false, reason: "need read on employees.07-001" };
const ev = (m: string, p: string, d: Decision) => accessAudit(m, p, d, AUDIT);

// Sensitive verbs that also CHANGE STATE, so they are deliberately absent from READ_VERBS and produce BOTH
// rows: the `.read.sensitive` one for what they streamed, and the write backstop's one for what they changed.
// Each entry is a claim about the handler, so each carries what it mutates.
const SENSITIVE_AND_MUTATING: Record<string, string> = {
  "payroll-runs:bankFile":
    "stamps `bank_file_at` on the first generation (services/bankFile.ts), which irreversibly locks the run against deletion",
};

// Keeps the two audit tables honest as verbs are added: a "sensitive read" that actually MUTATES and is listed
// in READ_VERBS would be logged as a read AND skipped by the write backstop, silently losing the write from
// the trail. So a sensitive verb is either a genuine read (in READ_VERBS) or a declared mutator (named above,
// and out of READ_VERBS) - never both, and never neither.
describe("audit policy shape", () => {
  it("every sensitive verb is qualified `collection:verb` on a real collection, and is a read or a declared mutator", () => {
    for (const key of AUDIT.sensitive_verbs) {
      const [collection, verb, ...rest] = key.split(":");
      expect(rest, key).toHaveLength(0);
      expect(verb, key).toBeTruthy();
      expect(COLLECTIONS.has(collection!), key).toBe(true);
      if (SENSITIVE_AND_MUTATING[key]) {
        expect(READ_VERBS.has(key), `${key} mutates, so it must stay OUT of READ_VERBS or the write is lost`).toBe(false);
      } else {
        expect(READ_VERBS.has(key), `${key} is audited as a read but is not in READ_VERBS`).toBe(true);
      }
    }
  });
  it("every declared sensitive mutator is still a sensitive verb", () => {
    const stale = Object.keys(SENSITIVE_AND_MUTATING).filter((k) => !AUDIT.sensitive_verbs.includes(k));
    expect(stale).toEqual([]);
  });
  it("every read-only verb is qualified `collection:verb` on a real collection", () => {
    for (const key of READ_VERBS) {
      const [collection, verb, ...rest] = key.split(":");
      expect(rest, key).toHaveLength(0);
      expect(verb, key).toBeTruthy();
      expect(COLLECTIONS.has(collection!), key).toBe(true);
    }
  });
});

describe("accessAudit", () => {
  it("records every denial as access.denied, anchored on the path id, with the reason in meta", () => {
    const a = ev("GET", "/v1/employees/abc123/bank-account", DENY);
    expect(a).toMatchObject({ action: "access.denied", entity: "employees", entityId: "abc123" });
    expect(a!.meta).toMatchObject({ method: "GET", reason: DENY.allow === false ? DENY.reason : "" });
  });

  it("records denial on an unmapped path (no id) too", () => {
    const a = ev("GET", "/v1/nonsense", DENY);
    expect(a).toMatchObject({ action: "access.denied", entity: "nonsense", entityId: null });
  });

  it("records an ALLOWED read of a sensitive PII sub-resource", () => {
    const a = ev("GET", "/v1/employees/abc123/identity", ALLOW);
    expect(a).toMatchObject({ action: "employees.read.sensitive", entity: "employees", entityId: "abc123" });
    expect(a!.meta).toMatchObject({ field: "identity" });
  });

  it("records an ALLOWED read of a sensitive whole-item collection (compensation)", () => {
    expect(ev("GET", "/v1/compensation/cmp9", ALLOW)).toMatchObject({ action: "compensation.read.sensitive", entityId: "cmp9" });
  });

  it("records an ALLOWED sensitive verb (download), regardless of method", () => {
    const a = ev("POST", "/v1/payslips/ps1:download", ALLOW);
    expect(a).toMatchObject({ action: "payslips.read.sensitive", entity: "payslips", entityId: "ps1" });
    expect(a!.meta).toMatchObject({ field: ":download" });
  });

  it("matches sensitive verbs per COLLECTION, not by bare verb name", () => {
    // Same verb, different exposure: a payslip is one person's pay; an org document is published to everyone.
    expect(ev("POST", "/v1/org-documents/od1:download", ALLOW)).toBeNull();
    expect(ev("POST", "/v1/expenses/ex1:download", ALLOW)).toBeNull();
    expect(ev("POST", "/v1/tax-declarations/td1:download", ALLOW)).toMatchObject({ action: "tax-declarations.read.sensitive" });
  });

  it("does NOT audit ordinary allowed reads (volume)", () => {
    expect(ev("GET", "/v1/holidays", ALLOW)).toBeNull();
    expect(ev("GET", "/v1/employees/abc123", ALLOW)).toBeNull(); // base record is not sensitive
    expect(ev("GET", "/v1/announcements/a1", ALLOW)).toBeNull();
  });

  it("does NOT audit previews of sample/already-visible data", () => {
    expect(ev("POST", "/v1/payslips:previewTemplate", ALLOW)).toBeNull(); // fabricated sample figures
    expect(ev("POST", "/v1/payroll-runs/pr1:previewPayslip", ALLOW)).toBeNull(); // numbers the run review already shows
    expect(ev("GET", "/v1/salary-structures/ss1", ALLOW)).toBeNull(); // org-level component catalog, nobody's data
    expect(ev("GET", "/v1/benefit-enrollments/be1", ALLOW)).toBeNull(); // which plan, no amounts
    expect(ev("GET", "/v1/personal-documents/pd1", ALLOW)).toBeNull(); // metadata only; the BYTES are audited
  });

  it("audits the sensitive READS around those previews", () => {
    expect(ev("POST", "/v1/personal-documents/pd1:download", ALLOW)).toMatchObject({ action: "personal-documents.read.sensitive" });
    expect(ev("POST", "/v1/personal-documents:previewLetter", ALLOW)).toMatchObject({ action: "personal-documents.read.sensitive", entityId: null });
    expect(ev("POST", "/v1/payroll-runs/pr1:bankFile", ALLOW)).toMatchObject({ action: "payroll-runs.read.sensitive", entityId: "pr1" });
    expect(ev("POST", "/v1/payroll-runs/pr1:statutoryReport", ALLOW)).toMatchObject({ action: "payroll-runs.read.sensitive" });
  });

  // `:bankFile` is BOTH, and the two rows answer different questions: the sensitive-read row says who was
  // handed every employee's account number, the write row says who locked the run against deletion
  // (services/bankFile.ts stamps `bank_file_at` on the first generation, and services/payroll.ts then refuses
  // to delete it). It sat in READ_VERBS, so only the read row was ever written, and "who locked this run"
  // answered with a read event that any write-keyed filter or alert missed.
  it("logs :bankFile as a WRITE as well - it stamps the run irreversibly", () => {
    expect(mutationAudit("POST", "/v1/payroll-runs/pr1:bankFile")).toMatchObject({ action: "payroll-runs.bankFile", entityId: "pr1" });
  });

  it("carries only safe keys - method + the field NAME, never a value", () => {
    const a = ev("GET", "/v1/employees/abc123/bank-account", ALLOW);
    expect(Object.keys(a!.meta).sort()).toEqual(["field", "method"]); // no value-bearing keys
    expect(a!.meta.field).toBe("bank-account"); // the sub-resource name, not its contents
  });

  it("does NOT audit a self-view of sensitive data (isSelf), but still records a self denial", () => {
    // Own PII sub-resource / own sensitive record / own download -> not logged.
    expect(accessAudit("GET", "/v1/employees/abc123/identity", ALLOW, AUDIT, true)).toBeNull();
    expect(accessAudit("GET", "/v1/compensation/cmp9", ALLOW, AUDIT, true)).toBeNull();
    expect(accessAudit("POST", "/v1/payslips/ps1:download", ALLOW, AUDIT, true)).toBeNull();
    // A denial is an abuse signal regardless of whose record it is.
    expect(accessAudit("GET", "/v1/employees/abc123/bank-account", DENY, AUDIT, true)).toMatchObject({ action: "access.denied" });
  });

  it("does NOT audit a sensitive whole-collection LIST read (no specific record)", () => {
    expect(ev("GET", "/v1/compensation", ALLOW)).toBeNull(); // list exposes no one record's fields
    expect(ev("GET", "/v1/payslips", ALLOW)).toBeNull();
  });

});

// Write backstop: mutationAudit builds the generic activity row the authz middleware emits after a successful
// mutation the handler did not already log. It must skip reads (GET, read-only custom verbs) and shape a clear
// action per method/verb, anchored on the path's internal id.
describe("mutationAudit", () => {
  it("logs a create for a collection POST (no id)", () => {
    expect(mutationAudit("POST", "/v1/leave-requests")).toMatchObject({ action: "leave-requests.create", entity: "leave-requests", entityId: null });
  });
  it("logs an update for a PATCH on an item, anchored on the internal id", () => {
    expect(mutationAudit("PATCH", "/v1/employees/abc123")).toMatchObject({ action: "employees.update", entity: "employees", entityId: "abc123" });
  });
  it("logs a delete for a DELETE", () => {
    expect(mutationAudit("DELETE", "/v1/goals/g1")).toMatchObject({ action: "goals.delete", entity: "goals", entityId: "g1" });
  });
  it("logs a custom method verb as collection.verb", () => {
    expect(mutationAudit("POST", "/v1/leave-requests/lr1:approve")).toMatchObject({ action: "leave-requests.approve", entity: "leave-requests", entityId: "lr1" });
  });
  it("qualifies a sub-resource write with the sub path", () => {
    expect(mutationAudit("PATCH", "/v1/employees/abc123/identity")).toMatchObject({ action: "employees.identity.update", entity: "employees", entityId: "abc123" });
  });
  it("ignores the query string when anchoring", () => {
    expect(mutationAudit("PATCH", "/v1/employees/abc123?foo=1")).toMatchObject({ action: "employees.update", entityId: "abc123" });
  });
  it("treats 'me' as no id", () => {
    expect(mutationAudit("PATCH", "/v1/employees/me")?.entityId).toBeNull();
  });
  it("returns null for reads (GET) — the mutation check excludes them", () => {
    expect(mutationAudit("GET", "/v1/employees/abc123")).toBeNull();
  });
  it("returns null for read-only custom methods (no state change) — a read is never logged as a write", () => {
    for (const p of [
      "/v1/employees/e1:getPhoto", "/v1/employees/e1:getSignature",
      "/v1/employees:upcomingCelebrations", "/v1/employees/e1:downloadIdentityDoc",
      "/v1/boards/b1:metrics", "/v1/automations/a1:test", "/v1/batch:run",
      "/v1/payslips:previewTemplate", "/v1/payslips/ps1:preview", "/v1/payslips/ps1:download",
      "/v1/payroll-runs/pr1:previewPayslip", "/v1/payroll-runs/pr1:statutoryReport",
      "/v1/personal-documents:previewLetter", "/v1/personal-documents/pd1:download",
      "/v1/org-documents/od1:download", "/v1/candidates/c1:download", "/v1/referrals/r1:download",
      "/v1/expenses/ex1:download", "/v1/reimbursements/rb1:download", "/v1/tax-declarations/td1:download",
    ]) {
      expect(mutationAudit("POST", p), p).toBeNull();
    }
  });
  it("keys read-only verbs per COLLECTION — a same-named verb that MUTATES is still logged", () => {
    // `batch:run` fans out GETs; these two really do run a job. `payslips:download` streams bytes; :upload stores them.
    expect(mutationAudit("POST", "/v1/operations/op1:run")).toMatchObject({ action: "operations.run", entityId: "op1" });
    expect(mutationAudit("POST", "/v1/cron-runs:run")).toMatchObject({ action: "cron-runs.run" });
    expect(mutationAudit("POST", "/v1/operations:clearCache")).toMatchObject({ action: "operations.clearCache" });
    expect(mutationAudit("POST", "/v1/transition-tasks/t1:upload")).toMatchObject({ action: "transition-tasks.upload" });
    expect(mutationAudit("POST", "/v1/personal-documents:generateForm16")).toMatchObject({ action: "personal-documents.generateForm16" });
  });
  it("returns null when there is no collection segment", () => {
    expect(mutationAudit("POST", "/v1/")).toBeNull();
  });

  // Self-referential personal state carries no accountability value — never reaches the feed.
  it("skips no-audit collections (notifications, preferences, attendance, holiday-selections)", () => {
    expect(mutationAudit("PATCH", "/v1/notifications/n1")).toBeNull();
    expect(mutationAudit("PATCH", "/v1/preferences/tab_seen")).toBeNull();
    expect(mutationAudit("POST", "/v1/notifications:markAllRead")).toBeNull();
    // Self clock in/out — high-frequency, already stored in the session row itself.
    expect(mutationAudit("POST", "/v1/attendance/me:clockIn")).toBeNull();
    expect(mutationAudit("POST", "/v1/attendance/me:clockOut")).toBeNull();
    expect(mutationAudit("POST", "/v1/holiday-selections")).toBeNull();
  });
  it("skips self-referential engagement verbs (read receipts, reactions, votes)", () => {
    expect(mutationAudit("POST", "/v1/announcements/a1:markRead")).toBeNull();
    expect(mutationAudit("POST", "/v1/announcements/a1:react")).toBeNull();
    expect(mutationAudit("POST", "/v1/announcements/a1:vote")).toBeNull();
    expect(mutationAudit("POST", "/v1/suggestions/s1:upvote")).toBeNull();
    expect(mutationAudit("POST", "/v1/suggestions/s1:downvote")).toBeNull();
    // …but a real comment/reply on the same collection IS an accountability event.
    expect(mutationAudit("POST", "/v1/announcements/a1:reply")).toMatchObject({ action: "announcements.reply" });
  });
  it("skips caller-owned sub-resources (notification-prefs) regardless of parent", () => {
    expect(mutationAudit("PATCH", "/v1/employees/abc123/notification-prefs")).toBeNull();
  });
});

// A denial has always named the pattern that refused it. Until now a PERMISSION named nothing, so "which grant
// let them do that" - the question an access review exists to ask - had an answer on only one side.
describe("decide() names the pattern that allowed a request, not only the one that refused it", () => {
  const grant = { levels: { "compensation.**": "write", "leave-requests.me.**": "read" }, allow: ["payroll-runs.*.publish"] } as never;
  const self = { employeeCode: "04-002" };

  it("reports the pattern that carried a standard method", () => {
    const d = decide(grant, resolveRequest("GET", "/v1/compensation/abc123"), self);
    expect(d.allow).toBe(true);
    expect(d.allow && d.via).toBe("compensation.**");
  });

  it("reports the pattern that carried a custom method", () => {
    const d = decide(grant, resolveRequest("POST", "/v1/payroll-runs/abc123:publish"), self);
    expect(d.allow).toBe(true);
    expect(d.allow && d.via).toBe("payroll-runs.*.publish");
  });

  it("still explains a refusal, and offers no pattern for one", () => {
    const d = decide(grant, resolveRequest("DELETE", "/v1/employees/abc123"), self);
    expect(d.allow).toBe(false);
    expect(!d.allow && d.reason).toMatch(/need/);
  });

  it("names the pattern that actually reached the required level, not a weaker earlier match", () => {
    // `employees.**` grants read; only `employees.me.**` reaches write. A write must be credited to the one
    // that got there - crediting the first match would name a grant that could not have allowed it.
    const laddered = { levels: { "employees.**": "read", "employees.me.**": "admin" }, allow: [] } as never;
    const d = decide(laddered, resolveRequest("PATCH", "/v1/employees/abc123"), { employeeCode: "abc123" });
    expect(d.allow && d.via).toBe("employees.me.**");
  });
});
