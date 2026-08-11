import { describe, it, expect } from "vitest";
import { writeSchema } from "../src/routes/payComponents";
import * as schema from "../src/db/schema";

// A pay component's kind/method live in two places: the column enum (what the table can store, what the payroll
// engine dispatches on) and the route's write validator (what the API accepts). A value present in the first but
// missing from the second is a silent dead end - the Pay components editor offers it and the save 400s. This pins
// them together: every storable kind and method must be writable.
describe("pay-component write validator matches the column enums", () => {
  it("accepts every kind the table can store", () => {
    for (const kind of schema.payComponents.kind.enumValues) {
      expect(writeSchema.safeParse({ kind }).success, kind).toBe(true);
    }
  });
  it("accepts every method the table can store", () => {
    for (const method of schema.payComponents.method.enumValues) {
      expect(writeSchema.safeParse({ method }).success, method).toBe(true);
    }
  });
  it("still rejects values outside those enums", () => {
    expect(writeSchema.safeParse({ kind: "employer_deduction" }).success).toBe(false);
    expect(writeSchema.safeParse({ method: "gratuity" }).success).toBe(false);
  });
});
