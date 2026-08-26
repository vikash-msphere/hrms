// The offer letter.
//
// An offer already holds everything a letter says - who, which role, how much, from when, valid until - and
// until now the letter itself was made somewhere else: a Word file with last year's numbers in it, retyped by
// hand from this screen. That is where a wrong figure in a signed document comes from.
//
// It is NOT built on the letter-template engine (domain/letters.ts), and that is deliberate: every template
// there resolves against an EMPLOYEE - compensation rows, employee number, manager, probation - and a
// candidate is precisely the person who has none of those yet. Rather than fake an employee row to satisfy the
// resolver, this composes the same `LetterContent` the renderer takes, from the offer. The wording, the
// signatory, the working hours and the probation period all come from the org's letter defaults, so the offer
// letter and every other letter the company sends still speak with one voice.
//
// NO access control here: the middleware gates `offers.letter`; the route only calls this.
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { LetterBlock, LetterContent, Run } from "../lib/letterPdf";
import { renderLetterPdf } from "../lib/letterPdf";
import type { LetterDefaults } from "../domain/letters";
import { failedPrecondition, notFound } from "../lib/errors";
import { getSettingValue } from "./settings";
import { amountInWords, moneyWhole } from "../lib/pdfPrimitives";

type OrgSettings = { name?: string; logo?: string; address?: string; letter_defaults?: LetterDefaults; default_currency?: string };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const fmtDate = (d?: Date | null) => (d ? `${new Date(d).getUTCDate()} ${MONTHS[new Date(d).getUTCMonth()]} ${new Date(d).getUTCFullYear()}` : "___________");
const money = (n: number, code: string) => `${code} ${moneyWhole(n)}`;

export type OfferLetter = { bytes: Uint8Array; fileName: string; title: string };

/** Compose and render one offer's letter. Nothing is persisted - the caller streams or files the bytes. */
export async function renderOfferLetter(deps: Deps, offerId: string): Promise<OfferLetter> {
  const offer = (await deps.db.select().from(schema.offers).where(eq(schema.offers.uuid, offerId)).limit(1))[0];
  if (!offer || offer.deleteTime) throw notFound("offer not found");
  const app = (await deps.db.select().from(schema.applications).where(eq(schema.applications.uuid, offer.applicationId)).limit(1))[0];
  if (!app) throw failedPrecondition("application not found");
  const cand = (await deps.db.select().from(schema.candidates).where(eq(schema.candidates.uuid, app.candidateId)).limit(1))[0];
  if (!cand) throw failedPrecondition("candidate not found");
  const req = (await deps.db.select().from(schema.jobRequisitions).where(eq(schema.jobRequisitions.uuid, app.requisitionId)).limit(1))[0];
  const dept = req?.departmentId
    ? (await deps.db.select().from(schema.departments).where(eq(schema.departments.uuid, req.departmentId)).limit(1))[0]
    : undefined;

  const org = await getSettingValue<OrgSettings>(deps, "organization", {});
  const d = org.letter_defaults ?? {};
  const orgName = org.name?.trim() || "the Company";
  const currency = offer.currency || org.default_currency || "INR";
  const role = req?.title ?? "the role";
  const ctc = offer.baseComp ?? null;

  const blocks: LetterBlock[] = [
    { kind: "subject", text: `Offer of employment - ${role}` },
    {
      kind: "para",
      runs: [
        `Dear ${cand.name.split(/\s+/)[0] ?? cand.name}, we are pleased to offer you the position of `,
        { b: role },
        dept?.name ? ` in ${dept.name}` : "",
        ` at `,
        { b: orgName },
        ".",
      ].filter((r) => r !== ""),
    },
  ];

  // The terms, as a list rather than a paragraph nobody reads to the end of.
  const terms: Run[][] = [];
  if (ctc != null) {
    terms.push(([
      "Annual cost to company: ",
      { b: money(ctc, currency) },
      currency === "INR" ? ` (${amountInWords(Math.round(ctc))})` : "",
    ] as Run[]).filter((r) => r !== ""));
  }
  terms.push(["Proposed date of joining: ", { b: fmtDate(offer.joinDate) }]);
  if (d.work_location || req?.location) terms.push(["Place of work: ", { b: (d.work_location || req?.location)! }]);
  if (d.work_mode) terms.push(["Work mode: ", { b: d.work_mode }]);
  if (d.working_days || d.working_hours) terms.push(["Working pattern: ", { b: [d.working_days, d.working_hours].filter(Boolean).join(", ") }]);
  if (d.probation_months) terms.push(["Probation: ", { b: `${d.probation_months} months from the date of joining` }]);
  if (req?.employmentType) terms.push(["Employment type: ", { b: req.employmentType.replace(/_/g, " ") }]);
  blocks.push({ kind: "bullets", items: terms });

  if (offer.expiryDate) {
    blocks.push({
      kind: "para",
      runs: ["This offer is open for your acceptance until ", { b: fmtDate(offer.expiryDate) }, ", after which it lapses."],
    });
  } else if (d.offer_validity_days) {
    blocks.push({ kind: "para", runs: [`This offer is open for your acceptance for ${d.offer_validity_days} days from the date of this letter.`] });
  }

  if (offer.notes?.trim()) blocks.push({ kind: "para", runs: [offer.notes.trim()] });

  blocks.push({
    kind: "para",
    runs: [
      "Your employment will be governed by the company's policies as they stand from time to time. Any questions",
      d.hr_name || d.hr_email ? ` may be addressed to ${[d.hr_name, d.hr_email].filter(Boolean).join(", ")}` : " may be addressed to the HR team",
      ". We look forward to working with you.",
    ],
  });
  blocks.push({
    kind: "signature",
    closing: "Yours sincerely,",
    name: d.signatory_name || orgName,
    title: d.signatory_title,
    signatureImage: d.signatory_signature,
    stampImage: d.company_stamp,
  });
  // The candidate's own countersignature: a letter that cannot be accepted on paper is only half a letter.
  blocks.push({ kind: "acceptance", name: cand.name });

  const content: LetterContent = {
    org: { name: orgName, address: org.address, logo: org.logo },
    date: fmtDate(offer.offerDate ?? deps.clock.now()),
    ref: offer.code ? `Ref: ${offer.code}` : undefined,
    to: { name: cand.name, lines: [cand.email, cand.phone].filter((x): x is string => !!x) },
    blocks,
  };

  const { bytes } = await renderLetterPdf(content);
  const safe = cand.name.replace(/[/\\]/g, "-").trim() || "candidate";
  return { bytes, fileName: `${safe} - Offer letter.pdf`, title: `Offer letter - ${cand.name}` };
}
