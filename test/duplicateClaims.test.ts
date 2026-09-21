/// <reference types="vite/client" />
// "This looks like one you already filed."
//
// The rules are deliberately loose enough to warn and therefore loose enough to be WRONG, which is why this
// warns rather than blocks. So the cases that matter are the ones where a careless matcher would cry wolf on
// legitimate repeat spending, and the ones where it would stay silent on a real re-entry.
import { describe, it, expect } from "vitest";
import { findDuplicateClaims, DUPLICATE_DAY_WINDOW, type DuplicateCandidate } from "../src/domain/expenses";

const DAY = 86_400_000;
const MAR1 = Date.UTC(2026, 2, 1);

const claim = (over: Partial<DuplicateCandidate> = {}): DuplicateCandidate => ({
  id: "new",
  amount: 1_200,
  vendorId: "uber",
  categoryId: "travel",
  incurredMs: MAR1,
  invoiceNumber: null,
  ...over,
});

describe("findDuplicateClaims", () => {
  it("matches the same amount, vendor and date", () => {
    const m = findDuplicateClaims(claim(), [claim({ id: "old" })]);
    expect(m).toEqual([{ id: "old", reason: "same_amount_vendor_date" }]);
  });

  it("matches across the day window but not beyond it", () => {
    // The pair this exists for is a receipt re-entered from memory, often carrying the filing date.
    const inside = claim({ id: "old", incurredMs: MAR1 + DUPLICATE_DAY_WINDOW * DAY });
    const outside = claim({ id: "far", incurredMs: MAR1 + (DUPLICATE_DAY_WINDOW + 1) * DAY });
    expect(findDuplicateClaims(claim(), [inside]).map((x) => x.id)).toEqual(["old"]);
    expect(findDuplicateClaims(claim(), [outside])).toEqual([]);
  });

  it("matches an invoice number whatever else differs", () => {
    // An invoice number identifies a DOCUMENT. Two claims carrying the same one are the same document even
    // when the amount was corrected and the date retyped - which is exactly the re-entry that slips past an
    // amount-and-date rule.
    const old = claim({ id: "old", amount: 9_999, incurredMs: Date.UTC(2025, 0, 1), vendorId: "other", categoryId: "other", invoiceNumber: "INV-42" });
    const m = findDuplicateClaims(claim({ invoiceNumber: "inv-42  " }), [old]);
    expect(m).toEqual([{ id: "old", reason: "same_invoice" }]);
  });

  it("treats a blank invoice number as absent, not as a value that matches other blanks", () => {
    // Most claims have no invoice number. Matching empty against empty would make every same-day claim a
    // duplicate of every other, which is the fastest way to get the whole warning ignored.
    const m = findDuplicateClaims(
      claim({ invoiceNumber: "  ", vendorId: null, categoryId: null }),
      [claim({ id: "old", invoiceNumber: "", vendorId: null, categoryId: null })],
    );
    expect(m).toEqual([]);
  });

  it("falls back to category when the filer picked no vendor", () => {
    const m = findDuplicateClaims(
      claim({ vendorId: null }),
      [claim({ id: "old", vendorId: null })],
    );
    expect(m).toEqual([{ id: "old", reason: "same_amount_category_date" }]);
  });

  it("does not match a different vendor at the same amount and date", () => {
    // Two 1,200 taxi rides on one day from different vendors are two taxi rides. The category rule must not
    // overrule this: a vendor difference is positive evidence they are different claims, and the weaker rule
    // firing where the stronger one already said no is how a warning becomes noise.
    expect(findDuplicateClaims(claim(), [claim({ id: "old", vendorId: "ola" })])).toEqual([]);
  });

  it("still falls back to category when only ONE side records a vendor", () => {
    // The asymmetric case, and the reason the guard is "both vendors known" rather than "any vendor known".
    // A claim re-entered from memory often omits the vendor the original carried, so the vendor cannot
    // discriminate here - there is nothing to disagree with, and amount + category + date is all there is.
    const missingOnOld = findDuplicateClaims(claim({ vendorId: "uber" }), [claim({ id: "old", vendorId: null })]);
    expect(missingOnOld).toEqual([{ id: "old", reason: "same_amount_category_date" }]);
    const missingOnNew = findDuplicateClaims(claim({ vendorId: null }), [claim({ id: "old", vendorId: "uber" })]);
    expect(missingOnNew).toEqual([{ id: "old", reason: "same_amount_category_date" }]);
  });

  it("lets a vendor difference end it even when the categories match", () => {
    // Stated separately from the case above because this is the RANKING being honoured, not a coincidence:
    // both claims carry a category and it is the same one, and the answer is still no.
    const m = findDuplicateClaims(
      claim({ vendorId: "uber", categoryId: "travel" }),
      [claim({ id: "old", vendorId: "ola", categoryId: "travel" })],
    );
    expect(m).toEqual([]);
  });

  it("does not match a different amount from the same vendor", () => {
    expect(findDuplicateClaims(claim(), [claim({ id: "old", amount: 1_201 })])).toEqual([]);
  });

  it("compares amounts to the paisa rather than approximately", () => {
    // A tolerance would match a 500 lunch against a different 501 lunch. The re-entry this targets is exact.
    expect(findDuplicateClaims(claim({ amount: 500.01 }), [claim({ id: "old", amount: 500.02 })])).toEqual([]);
    expect(findDuplicateClaims(claim({ amount: 500.01 }), [claim({ id: "old", amount: 500.010 })]).length).toBe(1);
  });

  it("says nothing about an undated claim", () => {
    // A null date states nothing about when it happened, so the window cannot be satisfied. Treating null as
    // "matches anything" would make every draft with no date a duplicate of the whole ledger.
    expect(findDuplicateClaims(claim({ incurredMs: null }), [claim({ id: "old" })])).toEqual([]);
    expect(findDuplicateClaims(claim(), [claim({ id: "old", incurredMs: null })])).toEqual([]);
  });

  it("never matches the row being edited against itself", () => {
    expect(findDuplicateClaims(claim({ id: "same" }), [claim({ id: "same" })])).toEqual([]);
  });

  it("reports the strongest reason first", () => {
    const m = findDuplicateClaims(
      claim({ invoiceNumber: "INV-9" }),
      [claim({ id: "weak", vendorId: null }), claim({ id: "strong", invoiceNumber: "INV-9" })],
    );
    expect(m[0]!.reason).toBe("same_invoice");
  });

  it("gives one row at most one reason", () => {
    // A vendor match and a category match on the same row is one resemblance, not two - listing it twice
    // would make the warning read as though there were two prior claims.
    const m = findDuplicateClaims(claim(), [claim({ id: "old" })]);
    expect(m.length).toBe(1);
  });

  it("answers an empty ledger with nothing", () => {
    expect(findDuplicateClaims(claim(), [])).toEqual([]);
  });
});
