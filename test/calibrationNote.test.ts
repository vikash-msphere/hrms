/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { calibrationNote, MIN_RATED, MIN_COHORT } from "../web/src/lib/calibrationNote";

// The shape of a cycle's rating distribution, said in a sentence and assembled from the counts.
//
// The properties worth holding: it says nothing at all when there is too little to say, it names COHORTS
// rather than people, and it never turns a comparison into a recommendation - the sentence is read in a
// calibration meeting, and deciding what to do about it is what that meeting is for.

const SCALE = [
  { value: 1, label: "Below" },
  { value: 2, label: "Developing" },
  { value: 3, label: "Meets" },
  { value: 4, label: "Exceeds" },
  { value: 5, label: "Outstanding" },
];
const deptName = (id: string) => ({ eng: "Engineering", ops: "Operations" })[id] ?? "";
const rows = (spec: [number, string][]) => spec.map(([rating, departmentId]) => ({ rating, departmentId }));

describe("when it says nothing", () => {
  it("is silent below the floor", () => {
    const few = rows(Array.from({ length: MIN_RATED - 1 }, () => [3, "eng"] as [number, string]));
    expect(calibrationNote(few, SCALE, deptName).text).toBe("");
  });

  it("is silent with no scale to read the middle off", () => {
    expect(calibrationNote(rows([[3, "eng"], [3, "eng"], [4, "eng"], [4, "ops"], [5, "ops"], [3, "ops"]]), [], deptName).text).toBe("");
  });
});

describe("what it says", () => {
  it("places the mass against the middle of the org's own scale", () => {
    const out = calibrationNote(rows([[4, "eng"], [4, "eng"], [5, "eng"], [4, "ops"], [5, "ops"], [4, "ops"]]), SCALE, deptName);
    expect(out.text).toMatch(/above the middle of the scale/);
    expect(out.facts[0]).toMatch(/scale midpoint 3/);
  });

  it("says when most of the cycle sits in one band", () => {
    const out = calibrationNote(rows([[3, "eng"], [3, "eng"], [3, "eng"], [3, "ops"], [4, "ops"], [2, "ops"]]), SCALE, deptName);
    expect(out.text).toMatch(/at "Meets"/);
  });

  it("names a cohort whose mean sits away from the rest", () => {
    const out = calibrationNote(rows([
      [5, "eng"], [5, "eng"], [4, "eng"], [5, "eng"],
      [3, "ops"], [3, "ops"], [2, "ops"], [3, "ops"],
    ]), SCALE, deptName);
    expect(out.text).toMatch(/Engineering averages 4\.8 against 2\.8 everywhere else/);
    // The one thing it must never do.
    expect(out.text).not.toMatch(/should|recommend|too high|too low/i);
  });

  it("will not name a cohort too small to be one", () => {
    const tiny = rows([
      ...Array.from({ length: MIN_COHORT - 1 }, () => [5, "eng"] as [number, string]),
      [3, "ops"], [3, "ops"], [3, "ops"], [3, "ops"], [2, "ops"],
    ]);
    const out = calibrationNote(tiny, SCALE, deptName);
    // Naming a cohort of three comes close to naming the three people in it.
    expect(out.text).not.toContain("Engineering");
  });

  it("says nothing about a department that is in line with the rest", () => {
    const out = calibrationNote(rows([
      [3, "eng"], [3, "eng"], [4, "eng"], [3, "eng"],
      [3, "ops"], [4, "ops"], [3, "ops"], [3, "ops"],
    ]), SCALE, deptName);
    expect(out.text).not.toContain("Engineering");
    expect(out.text).not.toContain("Operations");
  });

  it("never names a person, because it is never given one", () => {
    const out = calibrationNote(rows([[5, "eng"], [5, "eng"], [4, "eng"], [5, "eng"], [2, "ops"], [3, "ops"], [3, "ops"], [3, "ops"]]), SCALE, deptName);
    // The input shape has no room for one: a rating and a department id.
    expect(out.text).not.toMatch(/[A-Z][a-z]+ [A-Z][a-z]+/);
  });
});
