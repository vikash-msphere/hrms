/// <reference types="vite/client" />
// Reading a receipt into expense fields.
//
// The model's answer stops being text and becomes data at `parseReceipt`, so that boundary is where the
// tests are. A lenient boundary is how a model ends up proposing a field nobody designed, or an amount that
// is not a number, and the person accepting it reads a filled field as "the document said this".
//
// The prompt builder is tested too, because the org's chosen field set has to reach the model AND be applied
// again after parsing. Only interpolating the key list was the bug the CV path already fixed once: a model
// told to return two fields was still being told what a good third one looks like.
import { describe, it, expect } from "vitest";
import { parseReceipt, systemFor } from "../src/services/receiptExtract";
import { RECEIPT_FIELDS, type ReceiptField } from "../src/domain/receiptFields";

const ALL = [...RECEIPT_FIELDS];
const json = (o: unknown) => JSON.stringify(o);

describe("parseReceipt", () => {
  it("reads the fields the org asked for", () => {
    const out = parseReceipt(json({ amount: 1250.5, tax_amount: 190.75, incurred_on: "2026-03-02", vendor_name: "Blue Cab", invoice_number: "INV-9" }), ALL);
    expect(out).toEqual({ amount: 1250.5, tax_amount: 190.75, incurred_on: "2026-03-02", vendor_name: "Blue Cab", invoice_number: "INV-9" });
  });

  it("unwraps a fenced answer", () => {
    // A model asked for bare JSON will sometimes wrap it however firmly the prompt says not to, so the
    // outermost braces are taken before parsing.
    const raw = "```json\n{\"amount\": 100}\n```";
    expect(parseReceipt(raw, ALL)).toEqual({ amount: 100 });
  });

  it("keeps null, because null is the answer for something the receipt does not state", () => {
    // Null is not absence. It is the model saying the document did not say - which is the whole reason the
    // prompt forbids guessing, and it must survive the parse to mean anything.
    const out = parseReceipt(json({ amount: 100, tax_amount: null }), ALL);
    expect(out).toEqual({ amount: 100, tax_amount: null });
  });

  it("DROPS a field the org switched off rather than failing the whole extraction", () => {
    // The filter runs after the schema, so a model that ignores the instruction has that field removed and
    // the rest still lands. The org's choice is enforced here regardless of what the prompt asked for.
    const allowed: ReceiptField[] = ["amount"];
    const out = parseReceipt(json({ amount: 100, vendor_name: "Sneaky Ltd" }), allowed);
    expect(out).toEqual({ amount: 100 });
  });

  it("refuses an unexpected key rather than letting it ride along", () => {
    // `.strict()`. A key nobody designed is a model proposing a field the form has no place for.
    expect(() => parseReceipt(json({ amount: 100, approved: true }), ALL)).toThrow();
  });

  it("refuses a negative amount", () => {
    // A negative total is a misread page or a credit note, and neither is an expense claim.
    expect(() => parseReceipt(json({ amount: -50 }), ALL)).toThrow();
  });

  it("refuses an amount that is not a number", () => {
    // "1,250.00" is what a receipt prints and is NOT a number. Accepting the string would put it in a money
    // field that everything downstream treats as numeric.
    expect(() => parseReceipt(json({ amount: "1,250.00" }), ALL)).toThrow();
  });

  it("refuses a date that is not YYYY-MM-DD", () => {
    // "02/03/2026" is ambiguous between two continents and the form stores a day, not a guess at one.
    expect(() => parseReceipt(json({ incurred_on: "02/03/2026" }), ALL)).toThrow();
  });

  it("refuses an answer that is not JSON at all", () => {
    expect(() => parseReceipt("I could not read that receipt, sorry.", ALL)).toThrow();
  });

  it("refuses an empty answer", () => {
    expect(() => parseReceipt("", ALL)).toThrow();
  });
});

describe("systemFor", () => {
  it("names exactly the chosen keys", () => {
    const s = systemFor(["amount", "incurred_on"]);
    expect(s).toContain("The keys are exactly: amount, incurred_on.");
  });

  it("omits the rule for a field the org did not choose", () => {
    // The bug the CV path fixed once: a model told to return two fields was still told what a good third
    // looks like, which works against the setting rather than with it.
    const s = systemFor(["amount"]);
    expect(s).toContain("amount is the TOTAL");
    expect(s).not.toContain("vendor_name is the seller");
    expect(s).not.toContain("invoice_number is the document");
  });

  it("forbids guessing, calculating and judging", () => {
    // The three things that would turn a transcription into something else. Asserted on the prompt because
    // the prompt is the only place they are said.
    const s = systemFor(ALL);
    expect(s).toMatch(/Do NOT guess, infer, calculate or estimate/);
    expect(s).toMatch(/Do not judge whether the expense is reasonable/);
  });

  it("carries the untrusted-content preamble", () => {
    // The receipt text is caller-controlled, so the model is told in the prompt that it is reading content
    // rather than receiving orders.
    expect(systemFor(ALL)).toMatch(/instruction|content|ignore/i);
  });
});
