/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { subjectScopes, callerScopes } from "../src/domain/access";
import type { Grant, SelfContext } from "../src/domain/permissions";

// WHAT THE CALLER MAY SEE ABOUT ONE NAMED PERSON - and why a per-collection BREADTH could never answer it.
//
// Every case here is built from a SYNTHETIC grant rather than a seeded role. That is deliberate and it is the
// point of the feature: the deployment's roles will look nothing like `employee` / `manager` / `hr_admin`, the
// runtime authority is the `access_rules` table rather than the legacy static map, and a test that pins
// "manager sees attendance" is a test of today's seed rather than of the mechanism. What must hold is that a
// RULE of each shape produces the reach that rule describes, about the right person and nobody else.
//
// `subjectScopes` probes `<collection>.<subjectCode>-<leaf>` - a row OWNED BY the subject - so the engine
// answers on the real hierarchy. No branch in the function distinguishes owner from team from share; the
// tokens do it, which is what "no policy in code" means here.

const ME = "04-1c-0a9"; // dept 04-1c
const TEAMMATE = "04-1c-0b2"; // same dept, different person
const OUTSIDER = "07-2a-0f1"; // another department entirely
const REPORT = "09-3b-0c4"; // in neither dept: reachable only through the reporting chain

const grant = (levels: Grant["levels"], allow: Grant["allow"] = [], deny: string[] = []): Grant =>
  ({ levels, allow, ...(deny.length ? { deny } : {}) }) as Grant;
const self = (extra: Partial<SelfContext> = {}): SelfContext => ({ employeeCode: ME, ...extra });
/** Just the one collection, so a case reads as the rule it is about. */
const reaches = (g: Grant, s: SelfContext, subject: string, collection = "goals") =>
  subjectScopes(g, s, subject, [collection]).read.includes(collection);

describe("subjectScopes - the answer correlates with WHO the subject is", () => {
  it("`me` reaches the caller's own record and no one else's", () => {
    const g = grant({ goals: "read", "goals.me.**": "read" });
    expect(reaches(g, self(), ME)).toBe(true);
    expect(reaches(g, self(), TEAMMATE)).toBe(false);
    expect(reaches(g, self(), OUTSIDER)).toBe(false);
  });

  it("`my-dept` reaches the caller's department and stops at its edge", () => {
    const g = grant({ "goals.my-dept.**": "read" });
    expect(reaches(g, self(), TEAMMATE)).toBe(true);
    expect(reaches(g, self(), ME)).toBe(true); // the caller is in their own department
    expect(reaches(g, self(), OUTSIDER)).toBe(false);
  });

  // THE CASE A BREADTH CANNOT EXPRESS, and the one that sent the profile tabs wrong. A reporting line is not a
  // tier: the people in it sit wherever the org chart puts them, so no synthetic code is ever "a report".
  it("`my-reports` reaches the people in the chain, and nobody else - not even a teammate", () => {
    const g = grant({ "goals.my-reports.**": "read" });
    const s = self({ reportCodes: [REPORT] });
    expect(reaches(g, s, REPORT)).toBe(true);
    expect(reaches(g, s, TEAMMATE)).toBe(false); // same department, not a report
    expect(reaches(g, s, OUTSIDER)).toBe(false);
    // And with no chain resolved it reaches nobody, rather than falling open.
    expect(reaches(g, self(), REPORT)).toBe(false);
  });

  it("`my-org` reaches the whole reporting subtree", () => {
    const g = grant({ "goals.my-org.**": "read" });
    expect(reaches(g, self({ orgCodes: [REPORT] }), REPORT)).toBe(true);
    expect(reaches(g, self({ orgCodes: [REPORT] }), OUTSIDER)).toBe(false);
  });

  it("a `<code>-*` SUBTREE reaches a branch that has nothing to do with where the caller sits", () => {
    const g = grant({ "goals.07-2a-*.**": "read" });
    expect(reaches(g, self(), OUTSIDER)).toBe(true); // 07-2a-0f1 is under 07-2a
    expect(reaches(g, self(), TEAMMATE)).toBe(false); // the caller's OWN department is not granted
    expect(reaches(g, self(), ME)).toBe(false);
  });

  // A per-object share arrives as an extra pattern merged onto the role grant for the request
  // (middleware/authz.ts `objectGrant`), so passing the merged grant is all this needs to see it.
  it("a per-object share reaches exactly the record it names", () => {
    const g = grant({ [`goals.${TEAMMATE}-*.**`]: "read" });
    expect(reaches(g, self(), TEAMMATE)).toBe(true);
    expect(reaches(g, self(), OUTSIDER)).toBe(false);
  });

  it("`*` / `**` reach everyone, which is the point of granting them", () => {
    for (const pattern of ["goals.*.**", "goals.**"]) {
      const g = grant({ [pattern]: "read" });
      for (const who of [ME, TEAMMATE, OUTSIDER, REPORT]) {
        expect(reaches(g, self(), who), `${pattern} -> ${who}`).toBe(true);
      }
    }
  });

  it("read and write are separate answers", () => {
    const s = subjectScopes(grant({ "goals.my-dept.**": "read", "cards.my-dept.**": "write" }), self(), TEAMMATE, ["goals", "cards"]);
    expect(s.read).toContain("goals");
    expect(s.write).not.toContain("goals"); // a read grant is not a write one
    expect(s.read).toContain("cards"); // write implies read down the ladder
    expect(s.write).toContain("cards");
  });

  it("the employee sub-resources are their own gate, reached by no grant on the base record", () => {
    const broad = subjectScopes(grant({ "employees.**": "read" }), self(), TEAMMATE, []);
    expect(broad.read).toContain("employees.tax"); // `**` does reach them
    const base = subjectScopes(grant({ "employees.*": "read" }), self(), TEAMMATE, []);
    expect(base.read, "a 2-token grant on the base record must not reach a 3-token sub-resource").not.toContain("employees.tax");
    const own = subjectScopes(grant({ "employees.me.tax.**": "write" }), self(), TEAMMATE, []);
    expect(own.read).not.toContain("employees.tax"); // self-service, about somebody else
    expect(subjectScopes(grant({ "employees.me.tax.**": "write" }), self(), ME, []).write).toContain("employees.tax");
  });

  // The profile asks for presence only when this says so; before it was reported, every colleague's profile
  // fetched presence and 403'd for a caller holding only their own.
  it("presence is reported like the other sub-resources, read-only", () => {
    const own = grant({ "employees.me.presence.**": "read" });
    expect(subjectScopes(own, self(), ME, []).read).toContain("employees.presence");
    expect(subjectScopes(own, self(), TEAMMATE, []).read).not.toContain("employees.presence");
    const dept = grant({ "employees.my-dept.presence.**": "read" });
    expect(subjectScopes(dept, self(), TEAMMATE, []).read).toContain("employees.presence");
    expect(subjectScopes(dept, self(), OUTSIDER, []).read).not.toContain("employees.presence");
    expect(subjectScopes(grant({ "employees.**": "write" }), self(), TEAMMATE, []).write).not.toContain("employees.presence");
  });

  it("the activity trail is asked for separately, with its own scope", () => {
    const s = subjectScopes(grant({ "activity.my-dept.**": "read" }), self(), TEAMMATE, ["employees"]);
    expect(s.read).toContain("activity.employees");
    expect(subjectScopes(grant({ "activity.me.**": "read" }), self(), TEAMMATE, ["employees"]).read)
      .not.toContain("activity.employees");
  });

  it("a deny subtracts, on the person it names", () => {
    const g = grant({ "goals.**": "read" }, [], [`goals.${TEAMMATE}-*.**`]);
    expect(reaches(g, self(), OUTSIDER)).toBe(true);
    expect(reaches(g, self(), TEAMMATE)).toBe(false);
  });

  it("an unknown collection is absent rather than allowed", () => {
    expect(subjectScopes(grant({ "goals.**": "read" }), self(), TEAMMATE, ["not-a-collection"]).read).toEqual([]);
  });
});

// The contrast, pinned so the two are never confused again: `callerScopes` is a CALLER-level tier and says
// nothing about a person. It is still the right answer for "should this page offer a team overlay at all";
// it was the wrong answer for "may I see Asha's goals", and this is exactly how it was wrong.
describe("callerScopes is a tier, and a tier is not a relationship", () => {
  const managerChain = grant({ goals: "read", "goals.my-reports.**": "read" });
  const s = self({ reportCodes: [REPORT] });

  it("reports a manager-chain grant as a blanket tier, about nobody in particular", () => {
    expect(callerScopes({ grant: managerChain, employeeCode: ME }, s).read.goals).toBe("dept");
  });

  it("...while subjectScopes says yes for the report and no for the teammate, from the same grant", () => {
    expect(reaches(managerChain, s, REPORT)).toBe(true);
    expect(reaches(managerChain, s, TEAMMATE)).toBe(false);
  });
});
