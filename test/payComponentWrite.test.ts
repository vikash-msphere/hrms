import { describe, it, expect } from "vitest";
import { writeSchema } from "../src/routes/payComponents";
import * as schema from "../src/db/schema";
import { payComponentLineCode } from "../src/domain/payroll";

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

// Every line a run writes is matched downstream by its exact CODE, and an ordinary component's code is the slug
// of its NAME. So two names that differ only in punctuation or case are one code for two heads: the run prices
// and writes both, they read as a single payslip line, and anything reading a head by code gets whichever came
// last. Nothing downstream can notice, because by then there is only one code - so the catalog refuses the
// collision (services/payComponents.ts validateLineCode), and this pins the function that decides it.
describe("a component's payslip line code", () => {
  const code = (name: string, kind = "earning", method = "fixed") => payComponentLineCode({ kind, method, name });

  it("slugs the name, and namespaces an employer contribution", () => {
    expect(code("House Rent Allowance")).toBe("HOUSE_RENT_ALLOWANCE");
    expect(code("Gratuity", "employer_contribution", "percent_base")).toBe("ER_GRATUITY");
    // The statutory employer heads are named by METHOD, not by the (renameable) component name.
    expect(code("Employer PF", "employer_contribution", "epf")).toBe("ER_EPF");
    expect(code("Anything at all", "employer_contribution", "esi")).toBe("ER_ESI");
  });

  it("is the SAME code for names that differ only in punctuation or case", () => {
    // This is the collision itself. It is legal to write both of these into the catalog by hand; what must not
    // happen is that they both reach a payroll run.
    expect(code("Travel Allowance")).toBe(code("Travel-Allowance"));
    expect(code("Travel Allowance")).toBe(code("travel allowance"));
    expect(code("Fuel")).toBe(code("  fuel  "));
    expect(code("Meal / Food")).toBe(code("Meal Food"));
    // And among employer contributions, on the same rule.
    expect(code("Group Term Life", "employer_contribution", "fixed")).toBe(code("group-term-life", "employer_contribution", "fixed"));
  });

  it("never lets a plain component mint a code the engine owns", () => {
    // The build matches "BASIC", "LOP", "EPF", "ROUND" and the rest by exact code, so a component named after
    // one of them is prefixed rather than allowed to shadow it.
    for (const reserved of ["Basic", "LOP", "EPF", "ESI", "PT", "TDS", "Round", "Bonus"]) {
      expect(code(reserved)).toBe(`C_${reserved.toUpperCase()}`);
    }
    // Nor one in the employer namespace, which employerLineCode owns.
    expect(code("ER Something")).toBe("C_ER_SOMETHING");
  });

  it("falls back to a readable code for a name with nothing sluggable in it", () => {
    expect(code("!!!")).toBe("COMPONENT");
  });
});
