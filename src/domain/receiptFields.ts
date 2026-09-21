// WHICH fields a model may propose from a receipt, as an org setting rather than a constant.
//
// The same two-question split `domain/resumeFields.ts` makes: the feature flag answers "may a receipt be
// read by a model at all", and this answers "which parts of it". Every field below is already a column on
// the expense record, so nothing here can propose something the form could not have been typed into.
//
// WHAT THIS DELIBERATELY DOES NOT DO IS READ AN IMAGE. The text arrives from the browser, extracted by the
// pdfjs the SPA already runs for the document viewer, exactly as `services/resumeExtract.ts` gets CV text -
// so a PDF invoice works and a photograph of a till receipt does not. That is a real limitation and it is
// the intended one: a vision model would have to be added to `MODELS`, and an IMAGE CANNOT BE SCRUBBED.
// `scrubStatutoryIds` runs over text before it reaches the model; there is no equivalent for a photo, which
// would have to be seen before it could be redacted. A receipt is submitted to prove an amount and carries
// whatever else is printed on it - a pharmacy receipt names the drug, a clinic receipt names the treatment -
// so the one path where redaction is impossible is also the one where the incidental content is medical.
// Vendor invoices are PDFs and are most of what `expenses` holds; photographed receipts stay manual.
//
// NO CONSENTED PATH IS NEEDED, which the plan assumed otherwise. `expenses` is not in `NEVER_TO_MODEL` -
// not in `AUDIT.sensitive_collections` and not in the literal list beside it - so `assertMayReachModel`
// admits it and there is no exception to argue for. Checked rather than inherited from the plan's wording.
import type { Deps } from "../deps";
import { getSettingValue } from "../services/settings";

/** Every field extraction can offer. Each is a column on the expense row. */
export const RECEIPT_FIELDS = [
  "amount",
  "tax_amount",
  "incurred_on",
  "vendor_name",
  "invoice_number",
] as const;

export type ReceiptField = (typeof RECEIPT_FIELDS)[number];

/** What each field is, in the words the settings screen shows. `caution` marks the ones where the model is
 *  doing more than copying a number off the page. */
export const RECEIPT_FIELD_META: Record<ReceiptField, { label: string; caution?: string }> = {
  amount: {
    label: "Total amount",
    caution: "A receipt often shows several totals - subtotal, tax, tip, amount paid. The model picks one, and the person accepting it is the check.",
  },
  tax_amount: { label: "Tax amount" },
  incurred_on: { label: "Date incurred", caution: "An invoice can carry an issue date, a service date and a due date. Only the person filing knows which one the claim is for." },
  vendor_name: {
    label: "Vendor name",
    caution: "Suggested as TEXT to match against the vendor list, never as a vendor reference. Picking the wrong existing vendor would misattribute spend silently.",
  },
  invoice_number: { label: "Invoice number" },
};

/** The org's chosen fields, defaulting to none. Empty is a configuration mistake rather than a licence to
 *  read everything, and the service refuses rather than guessing - the same rule the CV path applies. */
export async function receiptExtractionConfig(deps: Deps): Promise<ReceiptField[]> {
  const cfg = await getSettingValue<{ receipt_fields?: string[] }>(deps, "ai", {});
  const chosen = cfg.receipt_fields ?? [];
  return RECEIPT_FIELDS.filter((f) => chosen.includes(f));
}
