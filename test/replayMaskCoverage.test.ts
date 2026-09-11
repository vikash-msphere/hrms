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
    // Both spellings are masked, because the tags below are attributes rather than classes.
    expect(instrument).toContain('"[data-sentry-mask]"');
  });
});

// ── The pages and fields the app PROMISED nobody would read over your shoulder ─────────────────────────────
//
// Replay is unmask-by-default here (see the posture note in web/src/instrument.ts), which means coverage is a
// list somebody has to maintain, and a page that grows a confidential field is recorded until someone
// remembers. These are the promises the product makes in words - anonymity on a suggestion, confidentiality
// on an appraisal or a scorecard, privacy on a 1:1 - plus the two fields that are routinely medical. Every
// one of them was being recorded in full while the payslip list next door was masked.
//
// Asserted from source, like the dialogs above: what is being checked is that the tag is PRESENT, which no
// single rendered case can prove.
const CONFIDENTIAL_ROUTES = [
  "reviews", // ratings, written assessments, 360 feedback the subject cannot attribute
  "suggestions", // anonymity is a product promise (services/suggestions.ts keeps the submitter hidden)
  "check-ins", // private 1:1 notes
  "tax-declarations", // PAN, regime, rent and investment proofs
  "background-checks", // what a verification came back with about somebody's past
];

const page = (name: string): string => {
  const files = import.meta.glob("../web/src/pages/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  const hit = Object.entries(files).find(([path]) => path.endsWith(`/${name}.tsx`));
  if (!hit) throw new Error(`replayMaskCoverage: pages/${name}.tsx not found - was it renamed?`);
  return hit[1];
};

describe("session replay: confidential routes are masked whole", () => {
  it.each(CONFIDENTIAL_ROUTES)("%s is in SENSITIVE_PAGES", (route) => {
    // The route key is what App.tsx stamps as `data-page`, so this string IS the selector.
    expect(instrumentSource()).toMatch(new RegExp(`^\\s*"${route}",`, "m"));
  });

  it("SENSITIVE_PAGES is still applied as a data-page selector", () => {
    // The list is inert if the mask stops deriving selectors from it - and the failure is silent.
    expect(instrumentSource()).toContain('[data-page="${p}"]');
  });
});

describe("session replay: the confidential fields on ordinary pages", () => {
  it("a leave request's reason - the column and the row detail", () => {
    // Leave is the ordinary-looking request whose free text is a diagnosis or a bereavement. The page is NOT
    // masked whole (types, dates, balances and states are exactly what a replay is wanted for), so the reason
    // carries its own tag in both places it is shown as a field.
    const src = page("Leaves");
    expect(src).toMatch(/id: "reason"[\s\S]{0,400}data-sentry-mask/);
    expect(src).toMatch(/<dd data-sentry-mask>\{detailRow\.reason/);
  });

  it("a leave request's reason box does not record keystrokes", () => {
    const src = source("RequestLeaveDialog");
    // `ignore` as well as `mask`: the text is typed into this box, and keystroke recording is a separate
    // channel from element masking.
    expect(src).toMatch(/<Textarea[^>]*data-sentry-mask[^>]*data-sentry-ignore/);
    expect(instrumentSource()).toContain('".sentry-ignore"');
    expect(instrumentSource()).toContain('"[data-sentry-ignore]"');
  });

  it("an interview scorecard - a panelist's private read, held back from the panel", () => {
    expect(page("Interviews")).toMatch(/className="sentry-mask"/);
  });

  it("dependents - a family member's name, relationship and date of birth", () => {
    const src = page("Benefits");
    expect(src).toMatch(/id="benefit-dependents" data-sentry-mask/); // the list on the page
    expect(src).toMatch(/<DialogContent className="sentry-mask"/); // and the portalled edit form
  });
});
