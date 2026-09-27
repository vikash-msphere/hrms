import { describe, it, expect } from "vitest";
import { withAccess } from "../src/http/accessHint";
import { isFieldScopeTarget } from "../src/domain/manifests";
import { DEFAULT_POLICY } from "../bootstrap/authz/policy";
import type { Grant } from "../src/domain/permissions";

// Per-field READ for base-record fields. Field access used to reach three collections and four PII
// sub-resources; everything else was all-or-nothing at the row, so a recruiter coordinating interviews read
// the offer's money and the hiring panel read the candidate's personal phone number.
//
// The design point these tests exist to pin is that listing a field is ADDITIVE. A pattern's `**` matches
// trailing tokens, so every ordinary grant already satisfies `<collection>.<code>.<field>.read` and nobody
// loses a field by it being listed. What the list buys is the ability to take ONE away.

const CODE = "04-1c-0a9-01";
const OTHER_DEPT = "07-1a-002-01";
const user = (grant: Grant) => ({ grant, employeeCode: "04-1c-0a9", policy: DEFAULT_POLICY }) as any;
const offer = { path: "offers/x", status: "extended", base_comp: 2_500_000 };

describe("redacted fields - the additive half", () => {
  it("an org-wide grant keeps the field", () => {
    expect(withAccess(offer, user({ levels: { "offers.**": "read" }, allow: [] }), "offers", CODE).base_comp).toBe(2_500_000);
  });

  it("a scoped grant keeps it too - `**` matches the field and action tokens", () => {
    // The property that makes growing REDACTED_FIELDS safe: no existing grant is narrowed by an entry.
    expect(withAccess(offer, user({ levels: { "offers.my-dept.**": "read" }, allow: [] }), "offers", CODE).base_comp).toBe(2_500_000);
  });

  it("a field can also be granted positively to an otherwise narrow reader", () => {
    // `offers.*` reads the row but not its sub-tokens, so the field rule is what adds the number back.
    const g: Grant = { levels: { "offers.*": "read", "offers.*.base_comp.**": "read" }, allow: [] };
    expect(withAccess(offer, user(g), "offers", CODE).base_comp).toBe(2_500_000);
  });
});

describe("redacted fields - taking one away", () => {
  it("a deny on the field removes exactly that field, and nothing else", () => {
    const g: Grant = { levels: { "offers.**": "read" }, allow: [], deny: ["offers.*.base_comp.**"] };
    const r = withAccess(offer, user(g), "offers", CODE) as Record<string, unknown>;
    expect("base_comp" in r).toBe(false); // DROPPED, not nulled - `null` would be a real empty value
    expect(r.status).toBe("extended");
    expect(r.access).toBeTruthy();
  });

  it("the deny is scoped like any other pattern", () => {
    const g: Grant = { levels: { "offers.**": "read" }, allow: [], deny: ["offers.07-*.base_comp.**"] };
    expect("base_comp" in (withAccess(offer, user(g), "offers", OTHER_DEPT) as object)).toBe(false);
    expect("base_comp" in (withAccess(offer, user(g), "offers", CODE) as object)).toBe(true);
  });

  it("removes a candidate's contact details while leaving the rest of the record", () => {
    const cand = { path: "candidates/x", name: "A", email: "a@example.com", phone: "1", notes: "n" };
    const g: Grant = { levels: { "candidates.**": "read" }, allow: [], deny: ["candidates.*.email.**", "candidates.*.phone.**"] };
    const r = withAccess(cand, user(g), "candidates", CODE) as Record<string, unknown>;
    expect("email" in r).toBe(false);
    expect("phone" in r).toBe(false);
    expect(r.notes).toBe("n");
    expect(r.name).toBe("A");
  });
});

describe("redacted fields - the cheap exits", () => {
  it("a field already absent needs no decision", () => {
    const r = withAccess({ path: "offers/x" }, user({ levels: {}, allow: [] }), "offers", CODE) as Record<string, unknown>;
    expect("base_comp" in r).toBe(false);
  });

  it("a collection with no listed fields is untouched", () => {
    const g: Grant = { levels: {}, allow: [], deny: ["goals.*.title.**"] };
    expect((withAccess({ path: "goals/x", title: "T" }, user(g), "goals", CODE) as any).title).toBe("T");
  });

  it("a row with no code skips the pass (nothing to decide against)", () => {
    expect(withAccess(offer, user({ levels: {}, allow: [] }), "offers", null).base_comp).toBe(2_500_000);
  });
});

describe("redacted fields are authorable as rule targets", () => {
  it("the validator accepts them, so a deny can be written in the ACL", () => {
    expect(isFieldScopeTarget(DEFAULT_POLICY, "offers", "base_comp")).toBe(true);
    expect(isFieldScopeTarget(DEFAULT_POLICY, "candidates", "phone")).toBe(true);
    expect(isFieldScopeTarget(DEFAULT_POLICY, "leave-requests", "reason")).toBe(true);
    // Still refuses a field that is not access-controlled - an inert rule is the thing to prevent.
    expect(isFieldScopeTarget(DEFAULT_POLICY, "offers", "status")).toBe(false);
  });
});
