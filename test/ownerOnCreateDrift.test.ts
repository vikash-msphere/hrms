/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { OWNER_REFS } from "../bootstrap/authz/policy";
import { LIST_OWNER_COLUMNS } from "../src/lib/authzResolve";

// OWNER-ON-CREATE, HELD AGAINST THE CREATE SCHEMAS.
//
// `middleware/authz.ts` states the rule: "a body owner field assigns who the NEW resource belongs to. The
// caller must be allowed to create under that owner - write on `<collection>.<ownerCode>` ... Absent field =>
// owned by the caller (the service default), which the resource-level write grant already covers."
//
// That gate runs ONLY for collections listed in `OWNER_REFS`. `bodyDecision` takes an early return when a
// collection has no fields, refs, owner refs or sub-body key - so a collection whose create schema accepts an
// owner ref but is absent from `OWNER_REFS` gets NO body gating at all, and the service is handed whatever the
// payload said.
//
// `expenses` was exactly that. The seeded `expenses: write` grant is what makes self-service filing work, so
// it decides nothing about WHOSE expense is being filed - which meant any employee could POST
// `{ "employee": "employees/<colleague>", ... }` and the row was created owned by the colleague, code-allocated
// under their code, landing in their list and their manager's queue; `:submit` then notified THEIR manager and
// drove automations against them, while the creator's own list (own-scoped) could no longer see it.
// `leave-requests` documents this trap in as many words and carries BOTH defences (an OWNER_REFS entry and a
// `reachesBeyondOwnRows` check in the service); `reimbursements`, the personal-money sibling with the identical
// grant shape, carries the entry. `expenses` carried neither.
//
// So: for every collection whose CREATE schema accepts an owner-shaped ref, require either an `OWNER_REFS`
// entry or a service that forces self - the latter declared here, with the line that forces it.
//
// A SOURCE scan, like test/listOwnerColumns.test.ts: a create schema is a zod literal at a call site.
const routes = import.meta.glob("../src/routes/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const services = import.meta.glob("../src/services/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/**
 * Collections whose create accepts an owner-shaped field but which need no OWNER_REFS entry, because the
 * SERVICE forces the owner to the caller (or to something no caller names). Each entry says what forces it -
 * an exemption is a claim about the code, not a silence.
 */
const SERVICE_FORCES_SELF: Record<string, string> = {
  loans: "SELF-SERVICE ONLY: createLoan throws on an `employee` that is not the actor - the service says so in its own comment, and that is why `loans` carries no owner_ref to gate",
};

// The owner field names a create schema can carry. `employee` is the overwhelming majority; the rest are the
// names OWNER_REFS itself uses, so a new spelling shows up as an unmatched collection rather than a silent pass.
const OWNER_FIELDS = ["employee", "author", "submitter", "referrer", "delegator"];

/** `<name>Schema = z.object({ ... })` bodies in a routes file, by variable name. */
function schemaBodies(src: string): Map<string, string> {
  const out = new Map<string, string>();
  // `z\n  .object({` is as common in this codebase as `z.object({`, so whitespace is allowed throughout.
  for (const m of src.matchAll(/const (\w*[Ss]chema)\s*=\s*z\s*\.\s*object\(\s*\{/g)) {
    const open = src.indexOf("{", m.index! + m[0].length - 1);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) {
        out.set(m[1]!, src.slice(open + 1, i));
        break;
      }
    }
  }
  return out;
}

/**
 * The wire collection a routes file declares. Either a literal (`collection: "expenses"`) or the `COL` const
 * several files hoist it into (`const COL = "expenses"` + `collection: COL`) - both spellings are in use, and
 * reading only the literal silently skipped the files that use the other, `expenses` among them.
 */
function collectionOf(src: string): string[] {
  const literal = [...src.matchAll(/^\s*collection: "([a-z0-9-]+)",/gm)].map((m) => m[1]!);
  if (literal.length) return literal;
  const viaConst = src.match(/^\s*collection: ([A-Z_][A-Z0-9_]*),/m);
  if (!viaConst) return [];
  const decl = src.match(new RegExp(`^const ${viaConst[1]} = "([a-z0-9-]+)";`, "m"));
  return decl ? [decl[1]!] : [];
}

type Candidate = { collection: string; field: string; file: string };

function candidates(): Candidate[] {
  const out: Candidate[] = [];
  for (const [path, src] of Object.entries(routes)) {
    const collections = collectionOf(src);
    if (collections.length !== 1) continue; // a file mounting several collections cannot attribute a schema
    const collection = collections[0]!;
    const bodies = schemaBodies(src);
    // Only the CREATE schema: a patch that re-points an owner is a different gate (protected fields).
    for (const [name, body] of bodies) {
      if (!/^create/i.test(name) && name !== "writeSchema") continue;
      for (const field of OWNER_FIELDS) {
        if (new RegExp(`^\\s*${field}: z\\.`, "m").test(body)) out.push({ collection, field, file: path.replace("../", "") });
      }
    }
  }
  return out;
}

describe("owner-on-create is declared wherever a create accepts an owner", () => {
  it("finds the create schemas (so a parser change cannot empty this suite)", () => {
    const found = candidates();
    expect(found.length).toBeGreaterThan(5);
    expect(found.map((c) => c.collection)).toContain("expenses");
  });

  it("every create that accepts an owner ref is gated by OWNER_REFS or forced self by its service", () => {
    const gaps = candidates()
      .filter((c) => !OWNER_REFS[c.collection]?.[c.field] && !SERVICE_FORCES_SELF[c.collection])
      .map((c) => `${c.collection}: create accepts "${c.field}" with no OWNER_REFS entry (${c.file})`);
    expect([...new Set(gaps)].sort()).toEqual([]);
  });

  it("every OWNER_REFS entry names a collection with a real owner column", () => {
    // The gate compiles `<collection>.<ownerCode>`, so the collection has to be one whose rows carry an owner
    // the list scope binds - otherwise the pattern it demands can never match anything.
    const bad = Object.keys(OWNER_REFS).filter((c) => !LIST_OWNER_COLUMNS[c]);
    expect(bad).toEqual([]);
  });

  it("every service-forces-self exemption still names a collection with such a create", () => {
    const seen = new Set(candidates().map((c) => c.collection));
    const stale = Object.keys(SERVICE_FORCES_SELF).filter((c) => !seen.has(c));
    expect(stale, "an exemption that has outlived its create schema is a hole nobody can see").toEqual([]);
  });

  it("each service-forces-self claim is visible in that service", () => {
    // Not a proof, a tripwire: the named service must still mention the actor's own employee id, so deleting
    // the forcing line fails here instead of silently widening the create.
    const missing = Object.keys(SERVICE_FORCES_SELF).filter((c) => {
      const src = Object.entries(services).find(([p]) => p.toLowerCase().includes(c.replace(/-/g, "").toLowerCase()))?.[1];
      return !src || !/actor\.employeeId/.test(src);
    });
    expect(missing).toEqual([]);
  });
});
