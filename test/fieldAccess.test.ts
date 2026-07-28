import { describe, it, expect } from "vitest";
import { deniedFieldKeys, redactIdentity, redactFlat } from "../src/http/fieldAccess";
import { decide, type Grant } from "../src/domain/permissions";
import { toAccessRuleResource } from "../src/http/serialize";

// Field-level access control: denying ONE field of ONE object affects only that field. The engine already
// supports the dotted field path (employees.<code>.identity.uan); these assert the read-redaction helper and
// the per-field deny semantics that the route + middleware rely on.

const CODE = "04-002-001";
const SELF = { employeeCode: null };
// A caller with full employee access plus a deny on exactly one field of one object.
const denyUan: Grant = { levels: { "employees.**": "admin" }, allow: [], deny: [`employees.${CODE}.identity.uan.**`] };
const noRule: Grant = { levels: { "employees.**": "admin" }, allow: [], deny: [] };

describe("deniedFieldKeys - exactly the denied field, nothing else", () => {
  it("a deny on identity.uan denies only uan; siblings inherit the broad allow", () => {
    const denied = deniedFieldKeys(denyUan, "employees", CODE, "identity", ["pan", "aadhaar", "uan"], SELF);
    expect([...denied]).toEqual(["uan"]);
  });
  it("a field with no rule is never denied (inherit by default)", () => {
    expect(deniedFieldKeys(noRule, "employees", CODE, "identity", ["pan", "aadhaar", "uan"], SELF).size).toBe(0);
  });
  it("the deny does not reach a different sub-resource (bank-account)", () => {
    const denied = deniedFieldKeys(denyUan, "employees", CODE, "bank-account", ["account_number", "ifsc_code"], SELF);
    expect(denied.size).toBe(0);
  });
  it("the deny does not reach a different object", () => {
    const denied = deniedFieldKeys(denyUan, "employees", "07-001-001", "identity", ["uan"], SELF);
    expect(denied.size).toBe(0);
  });
});

describe("per-field WRITE is gated by the same deny (mirrors bodyDecision)", () => {
  const canWrite = (g: Grant, key: string) => decide(g, { kind: "standard", resource: `employees.${CODE}.identity.${key}`, level: "write" }, SELF).allow;
  it("blocks write on the denied field, allows its siblings", () => {
    expect(canWrite(denyUan, "uan")).toBe(false);
    expect(canWrite(denyUan, "aadhaar")).toBe(true);
    expect(canWrite(denyUan, "pan")).toBe(true);
  });
});

describe("redactIdentity - keeps the row, withholds the value, flags denied", () => {
  const view = {
    fields: [
      { key: "pan", label: "PAN", mandatory: false, sensitive: true, value: "•••• 1234", has_value: true },
      { key: "aadhaar", label: "Aadhaar", mandatory: false, sensitive: true, value: "•••• 5678", has_value: true },
      { key: "uan", label: "UAN", mandatory: false, sensitive: false, value: "100200300", has_value: true },
    ],
  };
  it("blanks only the denied field's value and marks it denied", () => {
    const out = redactIdentity(view, denyUan, CODE, SELF);
    const uan = out.fields.find((f) => f.key === "uan")!;
    expect(uan.value).toBeUndefined();
    expect(uan.has_value).toBe(false);
    expect(uan.denied).toBe(true);
    expect(out.fields.find((f) => f.key === "aadhaar")!.value).toBe("•••• 5678"); // sibling untouched
  });
  it("returns the view unchanged when nothing is denied", () => {
    expect(redactIdentity(view, noRule, CODE, SELF)).toBe(view);
  });
});

describe("redactFlat - omits denied keys, remaps the masked read alias", () => {
  it("a deny on account_number drops account_number_masked (the read alias), keeps on_file + siblings", () => {
    const bank = { bank_name: "Acme", account_number_masked: "•••• 9999", ifsc_code: "X", on_file: true };
    const denyAcct: Grant = { levels: { "employees.**": "admin" }, allow: [], deny: [`employees.${CODE}.bank-account.account_number.**`] };
    const out = redactFlat(bank, "bank-account", denyAcct, CODE, SELF) as Record<string, unknown>;
    expect(out.account_number_masked).toBeUndefined();
    expect(out.bank_name).toBe("Acme");
    expect(out.ifsc_code).toBe("X");
    expect(out.on_file).toBe(true);
  });
  it("personal-info drops the denied key only", () => {
    const personal = { blood_group: "O+", allergies: "none", personal_email: "a@b.c" };
    const deny: Grant = { levels: { "employees.**": "admin" }, allow: [], deny: [`employees.${CODE}.personal-info.blood_group.**`] };
    const out = redactFlat(personal, "personal-info", deny, CODE, SELF) as Record<string, unknown>;
    expect(out.blood_group).toBeUndefined();
    expect(out.allergies).toBe("none");
    expect(out.personal_email).toBe("a@b.c");
  });
});

describe("access-rule serialize round-trips a dotted sub-resource field", () => {
  const row = (pattern: string) => ({ id: "r1", pattern, namespace: "employees", scopeKind: "exact", matchCode: "x", level: "read", effect: "allow", createdAt: new Date(0), updatedAt: new Date(0) });
  it("a per-field pattern yields the FULL field path, not just its last token", () => {
    expect(toAccessRuleResource(row(`employees.${CODE}.identity.uan.**`), "u").field).toBe("identity.uan");
  });
  it("a single-token field (department / bank-account) still round-trips", () => {
    expect(toAccessRuleResource(row("employees.*.department.**"), null).field).toBe("department");
    expect(toAccessRuleResource(row(`employees.${CODE}.bank-account.**`), "u").field).toBe("bank-account");
  });
  it("a collection-scope custom-method rule round-trips its verb (not a field)", () => {
    const r = { id: "r2", pattern: "leave-requests.*.approve", namespace: "leave-requests", scopeKind: "all", matchCode: null, level: null, effect: "allow", createdAt: new Date(0), updatedAt: new Date(0) };
    const out = toAccessRuleResource(r, null);
    expect(out.verb).toBe("approve");
    expect(out.field).toBeUndefined();
    expect(out.scope).toBe("all");
  });
  it("a custom-method DENY round-trips its verb (not misread as an object-level deny)", () => {
    const r = { id: "r3", pattern: `leave-requests.${CODE}.approve`, namespace: "leave-requests", scopeKind: "exact", matchCode: CODE, level: null, effect: "deny", createdAt: new Date(0), updatedAt: new Date(0) };
    const out = toAccessRuleResource(r, "u");
    expect(out.verb).toBe("approve");
    expect(out.effect).toBe("deny");
    expect(out.field).toBeUndefined();
  });
});
