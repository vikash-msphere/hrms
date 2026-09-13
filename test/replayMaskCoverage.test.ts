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

// Every one of these opens a dialog over an employee's pay, identity, medical or bank data.
const SENSITIVE_DIALOGS = [
  "EmployeeBankDetails", // account number, IFSC
  "EmployeeCompensation", // CTC, salary structure
  "EmployeeTaxDetails", // PAN, regime, declarations
  "EmployeeSettlement", // final payout
  "EmployeeBonuses", // amounts
  "EmployeeIdentityDetails", // Aadhaar, UAN, passport
  "EmployeePersonalDetails", // date of birth, address, personal contact
  "EmergencyQuickView", // blood group, allergies, medical notes - the only medical fields in the app
  "SignDocumentDialog", // the document body and the signer's legal name, at the moment they sign
];

const instrumentSource = (): string =>
  Object.entries(
    import.meta.glob("../web/src/instrument.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>,
  )[0]![1];

describe("session replay: sensitive dialogs are masked", () => {
  it.each(SENSITIVE_DIALOGS)("%s tags its dialog with sentry-mask", (name) => {
    const src = source(name);
    // Any of the three shapes counts: a raw <DialogContent className="sentry-mask">, WriteDialog's className
    // (forwarded to DialogContent), or a cn() that composes the class with a conditional width.
    expect(src).toMatch(/className="sentry-mask"|className=\{cn\("sentry-mask"/);
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
  "offers", // what the company offered a named person - the payroll-runs shape, before they are an employee
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

  it("an offered salary, on the two ATS surfaces that are not masked whole", () => {
    // `offers` is in SENSITIVE_PAGES above, but the same figure is rendered beside the same candidate's name on
    // #/candidates/<id> and on the pipeline board - routes that are mostly names and stages, so they are tagged
    // per value rather than masked whole. A title attribute is NOT masked (`maskAttributes: []`), so the board
    // card's tooltip must not carry the figure at all.
    expect(page("CandidateProfile")).toMatch(/data-sentry-mask[^>]*>\{money\(o\.base_comp/);
    expect(page("Pipeline")).toMatch(/data-sentry-mask[^>]*>\{o\.base_comp\.toLocaleString/);
    expect(page("Pipeline")).not.toMatch(/title=\{`Offer[^`]*base_comp/);
  });

  it("dependents - a family member's name, relationship and date of birth", () => {
    const src = page("Benefits");
    expect(src).toMatch(/id="benefit-dependents" data-sentry-mask/); // the list on the page
    expect(src).toMatch(/<DialogContent className="sentry-mask"/); // and the portalled edit form
  });

  it("an employee's personal documents, on the two routes the Documents mask does not cover", () => {
    // The Documents ROUTE is masked whole ("scanned identity documents, contracts, insurance cards"), but this
    // panel reads the same `personal-documents` collection onto #/profile and #/employees/<id>, which are not
    // in SENSITIVE_PAGES. It is the eighth panel on that page; the other seven are in SENSITIVE_DIALOGS above.
    expect(source("EmployeeDocuments")).toMatch(/<Card className="[^"]*\bsentry-mask\b/);
  });

  it("a handwritten signature - BLOCKED, in both places it renders", () => {
    // The signature is fetched as a data: URL and rendered as a plain <img>, so the bytes themselves travel in
    // the DOM snapshot rrweb serialises - and `img` is not in the block list (the `canvas` entry there covers
    // the signature PAD, not the stored image). Blocked rather than masked, because masking is a text
    // operation: a leaked signature bitmap is the whole input to forging the letters this app e-signs with it.
    const src = source("SignatureField");
    expect(src.match(/<img[^>]*data-sentry-block/g) ?? []).toHaveLength(2);
    expect(instrumentSource()).toContain('"[data-sentry-block]"');
  });

  it("the emergency panel's medical free text does not record keystrokes", () => {
    // The dialog carries `sentry-mask` (SENSITIVE_DIALOGS above); these two boxes are typed into, and
    // keystroke recording is the separate channel - same pairing as a leave reason.
    const src = source("EmergencyQuickView");
    expect(src.match(/<Textarea[^>]*data-sentry-ignore/g) ?? []).toHaveLength(2);
  });

  it("a leave reason in the calendar's hover card", () => {
    // The same field Leaves.tsx masks in two places, rendered by EntryCard on #/leave-calendar - a route that
    // is deliberately NOT masked whole (who is off when is exactly what a replay of it is wanted for).
    const files = import.meta.glob("../web/src/components/calendar/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    const shared = Object.entries(files).find(([path]) => path.endsWith("/shared.tsx"))![1];
    expect(shared).toMatch(/data-sentry-mask[^>]*>[^<]*\{en\.reason|\{en\.reason && <p [^>]*data-sentry-mask/);
  });
});
