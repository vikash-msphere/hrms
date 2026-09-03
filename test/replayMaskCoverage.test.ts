/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

// The profile's sensitive editing dialogs must carry the replay mask.
//
// A dialog renders through a PORTAL, as a child of <body>, so it is outside `<main data-page="…">` and the
// route-level masking in web/src/instrument.ts cannot reach it: the page behind "edit bank details" is masked
// and the account number in the open form is not. The fix is per-dialog (`sentry-mask`), because the blanket
// alternative - mask every overlay while on a sensitive route - also swallowed confirm prompts, pickers and
// the report form, leaving replays that show nothing.
//
// Per-dialog means someone has to remember, which is exactly the kind of thing that gets forgotten in a
// refactor and fails SILENTLY: the dialog still works, the replay still records, and the account number is
// simply in it. So it is asserted here rather than trusted. A source scan and not a browser test on purpose -
// this is about the tag being present on all of them, which no single rendered case can prove.
const files = import.meta.glob("../web/src/components/common/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const source = (name: string): string => {
  const hit = Object.entries(files).find(([path]) => path.endsWith(`/${name}.tsx`));
  if (!hit) throw new Error(`replayMaskCoverage: ${name}.tsx not found - was it renamed?`);
  return hit[1];
};

// Every one of these opens a dialog over an employee's pay, identity or bank data.
const SENSITIVE_DIALOGS = [
  "EmployeeBankDetails", // account number, IFSC
  "EmployeeCompensation", // CTC, salary structure
  "EmployeeTaxDetails", // PAN, regime, declarations
  "EmployeeSettlement", // final payout
  "EmployeeBonuses", // amounts
  "EmployeeIdentityDetails", // Aadhaar, UAN, passport
  "EmployeePersonalDetails", // date of birth, address, personal contact
];

const instrumentSource = (): string =>
  Object.entries(
    import.meta.glob("../web/src/instrument.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>,
  )[0]![1];

describe("session replay: sensitive dialogs are masked", () => {
  it.each(SENSITIVE_DIALOGS)("%s tags its dialog with sentry-mask", (name) => {
    const src = source(name);
    // Either shape counts: a raw <DialogContent className="sentry-mask">, or WriteDialog's className, which it
    // forwards to DialogContent.
    expect(src).toMatch(/className="sentry-mask"/);
  });

  it("does not mask every dialog on a sensitive route", () => {
    const instrument = instrumentSource();
    // The blanket rule this replaced - `[data-sensitive-route] [role="dialog"]` - covered the seven above and
    // also every confirm prompt, picker and the report form itself, which left replays showing a person
    // operating a dialog of asterisks. The narrow tags are the point; a blanket selector creeping back would
    // undo them silently, because over-masking never throws.
    expect(instrument).not.toMatch(/mask[\s\S]{0,600}\[role="dialog"\]/);
  });

  it("the class is the one instrument.ts actually masks on", () => {
    const instrument = instrumentSource();
    // The tag above is worthless if the selector list drops it, and the two files cannot see each other.
    expect(instrument).toContain('".sentry-mask"');
  });
});
