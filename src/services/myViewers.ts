// "Who can see my record?" - the access report pointed at the person asking, rather than at the admin.
//
// Every effective-access surface in this app answers the ADMIN's question: who can do what, previewed from
// the permissions screen. Nobody could ask the other direction - the one an employee actually has - which is
// "who can read my bank details". The engine has always known; there was simply no way to ask it about
// yourself.
//
// It is `previewAccessMany` with the target NAILED to the caller's own records. That is the whole security
// argument: no target is taken from the request, so holding this verb reveals nothing about anybody else's
// record, and the report is the same read-only assembly the ACL modal's preview panel already runs
// (test/singleSource.test.ts allow-lists it as a report, not an enforcement path).
//
// It runs WITHOUT `previewAccess`'s actor bound, and that is deliberate rather than an omission. That bound
// asks "may the caller read each SUBJECT's user record", which an ordinary employee never can (`users.me.**`
// is the whole of their reach) - so with it, the one report written for ordinary employees refused every one
// of them. What it would have protected is a directory of names, emails and roles; what this answers with is
// strictly narrower - only people who can already read something of the caller's, and only their name, work
// email and role, which the employee directory shows every colleague anyway. The caller cannot point it at
// anyone else, so there is no second record to leak.
import { eq, isNull, and, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { previewAccessMany, type PreviewTarget, type PreviewVerdict } from "./accessPreview";
import { listOwnerColumn, tableFor } from "../lib/authzResolve";
import { failedPrecondition } from "../lib/errors";
import { photoMarker } from "../http/serialize";

/** The sections the areas are shown in, in order. */
export const VIEWER_GROUPS = [
  { key: "record", label: "Your record", hint: "The employee file itself, and the sensitive sections inside it." },
  { key: "money", label: "Pay and money", hint: "What you are paid, what you claimed back, what you owe." },
  { key: "work", label: "Work and performance", hint: "Time, goals and the written record of how work is going." },
  { key: "documents", label: "Documents and cover", hint: "Papers filed under your name, and who is on your benefits." },
] as const;
type GroupKey = (typeof VIEWER_GROUPS)[number]["key"];

/**
 * One reportable area of a person's data.
 *
 * `field` areas are sub-resources of the employee record, graded as `employees.<code>.<field>`. `collection`
 * areas are rows the person OWNS elsewhere, graded on one real row of theirs - owner-coded, so the row's code
 * sits under their employee code and every `me` / `my-dept` / subtree rule lands the same way it would on a
 * live request.
 *
 * The list is the point of the feature, not a sample of it: "who can see my payslips" and "who can read my
 * 1:1 notes" are the questions people actually have, and an answer that covered only the five sub-resources
 * of the employee row left the sensitive half of an HR system unanswered.
 */
type AreaSpec = {
  key: string;
  label: string;
  hint: string;
  group: GroupKey;
  field?: string;
  collection?: string;
};

const AREAS: AreaSpec[] = [
  { key: "profile", group: "record", label: "Your profile", hint: "Name, photo, job title, department, manager and work contact." },
  { key: "personal-info", field: "personal-info", group: "record", label: "Personal and emergency details", hint: "Home address, personal phone, date of birth, blood group and emergency contacts." },
  { key: "identity", field: "identity", group: "record", label: "Identity documents", hint: "PAN, Aadhaar, UAN and passport, and the scans filed against them." },
  { key: "bank-account", field: "bank-account", group: "record", label: "Bank details", hint: "The account your salary is paid into." },
  { key: "tax", field: "tax", group: "record", label: "Tax details", hint: "Your regime, exemptions and the tax withheld each month." },

  { key: "compensation", collection: "compensation", group: "money", label: "Salary and CTC", hint: "Your pay structure and every revision of it." },
  { key: "payslips", collection: "payslips", group: "money", label: "Payslips", hint: "What you were paid each month, line by line." },
  { key: "bonuses", collection: "bonuses", group: "money", label: "Bonuses", hint: "One-off awards and incentives." },
  { key: "reimbursements", collection: "reimbursements", group: "money", label: "Reimbursement claims", hint: "Personal spend you claimed back, with the bills attached." },
  { key: "expenses", collection: "expenses", group: "money", label: "Company expenses", hint: "Spend you filed on the company's behalf." },
  { key: "loans", collection: "loans", group: "money", label: "Loans and advances", hint: "The balance outstanding and the instalment recovered each month." },
  { key: "tax-declarations", collection: "tax-declarations", group: "money", label: "Tax declarations", hint: "Rent receipts, investment proofs and prior-employer income." },
  { key: "settlements", collection: "settlements", group: "money", label: "Final settlement", hint: "The exit payout worksheet." },

  { key: "leave-requests", collection: "leave-requests", group: "work", label: "Leave requests", hint: "Days you asked for, and the reason where you gave one." },
  { key: "attendance", collection: "attendance", group: "work", label: "Attendance", hint: "When you clocked in and out, and from where." },
  { key: "time-entries", collection: "time-entries", group: "work", label: "Timesheets", hint: "Hours you booked against projects." },
  { key: "goals", collection: "goals", group: "work", label: "Goals", hint: "What you are working towards, and how it is going." },
  { key: "reviews", collection: "reviews", group: "work", label: "Performance reviews", hint: "Ratings, written feedback and calibration notes." },
  { key: "check-ins", collection: "check-ins", group: "work", label: "Check-ins", hint: "Notes and action items from your 1:1s." },
  { key: "tickets", collection: "tickets", group: "work", label: "Tickets you raised", hint: "What you asked HR, IT and facilities for." },

  { key: "personal-documents", collection: "personal-documents", group: "documents", label: "Documents", hint: "Contracts, letters and certificates filed under your name." },
  { key: "benefit-enrollments", collection: "benefit-enrollments", group: "documents", label: "Benefit enrolments", hint: "Which plans you are on." },
  { key: "dependents", collection: "dependents", group: "documents", label: "Dependents", hint: "The family members listed on your cover." },
  { key: "background-checks", collection: "background-checks", group: "documents", label: "Background check", hint: "What the verification vendor reported." },
  { key: "transitions", collection: "transitions", group: "documents", label: "Joining and exit", hint: "Your onboarding and offboarding checklists." },
];

/** One person who can see something of yours, and how much. */
export type Viewer = {
  name: string | null;
  email: string;
  /** True when they can also CHANGE it, not just read it - the distinction people ask about second. */
  write: boolean;
  why?: string;
  /** Their photo marker (http/serialize.ts#photoMarker), present when they have one. */
  photo?: string;
};

export type AreaReport = {
  key: string;
  group: GroupKey;
  label: string;
  hint: string;
  /** How many rows of yours the area holds. Absent for the sub-resources of the employee record itself. */
  records?: number;
  viewers: Viewer[];
};

export type ViewerReportResponse = {
  groups: typeof VIEWER_GROUPS;
  areas: AreaReport[];
  roster: number;
  complete: boolean;
};

/**
 * Everyone who can READ anything of the caller's, area by area.
 *
 * The roster is capped at `previewAccess`'s own subject limit. On a larger org this is a SAMPLE, and the
 * response says so rather than quietly reporting a short list as if it were complete - a trust feature that
 * under-reports who can see your bank details is worse than no feature.
 */
export async function whoCanSeeMe(deps: Deps, actor: AppUser): Promise<ViewerReportResponse> {
  if (!actor.employeeId) throw failedPrecondition("your account is not linked to an employee record");
  const selfRef = `employees/${actor.employeeId}`;
  const selfCode = actor.employeeCode;
  if (!selfCode) throw failedPrecondition("your employee record has no access code yet");

  // Active, non-deleted people only: a leaver who still has a row is not someone reading your file today, and
  // listing them would make the report read as alarming when it is not.
  const roster = await deps.db
    .select({ uuid: schema.employees.uuid, photoKey: schema.employees.photoKey, photoAt: schema.employees.photoAt })
    .from(schema.employees)
    .where(and(isNull(schema.employees.deleteTime), eq(schema.employees.status, "active")))
    .limit(MAX_ROSTER + 1);
  const complete = roster.length <= MAX_ROSTER;
  const subjects = roster.slice(0, MAX_ROSTER).map((r) => `employees/${r.uuid}`);
  const photos = new Map(roster.map((r) => [`employees/${r.uuid}`, photoMarker(r)]));
  const describe = (v: PreviewVerdict): Viewer => {
    const viewer = describeVerdict(v);
    const photo = photos.get(v.subject);
    return photo ? { ...viewer, photo } : viewer;
  };

  // One probe per collection area: how many rows the caller owns, and the code of one of them to grade. Issued
  // together, because each is a single indexed aggregate and the report is already behind an explicit press.
  const owned = await Promise.all(AREAS.map((a) => (a.collection ? ownedRows(deps, a.collection, actor.employeeId!) : Promise.resolve(null))));

  const targets: PreviewTarget[] = AREAS.map((a, i) => {
    if (!a.collection) return { collection: "employees", code: selfCode, ...(a.field ? { field: a.field } : {}) };
    // With no row of your own yet, grade a code that WOULD be yours: owner-coded collections allocate under
    // the employee's code, so `<yours>-0` matches exactly the rules a real row would. The answer is then "who
    // would see one", which is the useful thing to know BEFORE you file your first claim - and the record
    // count next to it stops that reading as though rows already existed.
    return { collection: a.collection, code: owned[i]!.code ?? `${selfCode}-0` };
  });

  const graded = await previewAccessMany(deps, subjects, targets);
  const areas: AreaReport[] = AREAS.map((a, i) => {
    const rows = owned[i];
    const verdicts = graded[i] ?? [];
    return {
      key: a.key,
      group: a.group,
      label: a.label,
      hint: a.hint,
      ...(rows ? { records: rows.count } : {}),
      // Yourself dropped: "it is their own record" is the one line on this page nobody needs told, and leaving
      // it in put the reader in their own list of watchers.
      viewers: verdicts.filter((v) => v.subject !== selfRef && canRead(v)).map(describe),
    };
  });
  return { groups: VIEWER_GROUPS, areas, roster: subjects.length, complete };
}

// `previewAccess` caps subjects at 100 per call; ask for exactly that and report whether the org outran it.
const MAX_ROSTER = 100;

/**
 * How many rows of `collection` the caller owns, and one row's code.
 *
 * `max(code)` rather than a separate lookup: it is any one of their codes, and which one does not matter -
 * they all sit under the same employee prefix, so every scope rule in the engine grades them identically. Only
 * a per-object share on one specific row could differ, and that is an exception by definition. Count and code
 * come back in one aggregate, so an area costs one read.
 */
async function ownedRows(deps: Deps, collection: string, employeeId: string): Promise<{ count: number; code: string | null }> {
  const table = tableFor(collection);
  const owner = listOwnerColumn(collection, table);
  // Fail CLOSED on a collection this cannot scope: reporting zero rows is honest (the probe code still grades
  // the rules), where reporting the whole table's codes would put somebody else's row in your report.
  if (!table || !owner) return { count: 0, code: null };
  const deleted = table.deleteTime as typeof schema.employees.deleteTime | undefined;
  const [row] = await deps.db
    .select({ count: sql<number>`count(*)`, code: sql<string | null>`max(${table.code})` })
    .from(table)
    .where(deleted ? and(eq(owner, employeeId), isNull(deleted)) : eq(owner, employeeId));
  return { count: Number(row?.count ?? 0), code: row?.code ?? null };
}

// A disabled account cannot read anything, whatever its rules say - it is refused at auth. Listing one would
// name somebody who genuinely cannot see the record.
const canRead = (v: PreviewVerdict): boolean => v.read && !v.disabled && !v.denied;

/**
 * Why they can see it - and ONLY for the one reason that is a fact about the caller's own record.
 *
 * The other three scope kinds (`dept`, `subtree`, `all`) all answer with the READER'S REACH: how far their
 * access runs, whether that is a department, a branch of the org or the whole company. Said out loud on a page
 * every employee can open, those sentences are a survey of who is powerful, assembled one colleague at a time
 * - the same thing that took the role field out of this payload, and the same thing that took the per-person
 * lens out of the UI. A scope-derived reason is therefore left off entirely rather than reworded; no reason at
 * all is a safe answer, and the name above it is the answer that was actually asked for.
 *
 * `exact` survives because it is not about the reader: it says something was shared FROM THIS RECORD, which is
 * a fact about the caller's own data and the one line here they might want to act on.
 *
 * `self` is absent for a different reason: every target here is the caller's own, so the only subject it could
 * describe is the caller, and they are filtered out of their own lists.
 */
const WHY: Record<string, string> = {
  exact: "shared with them specifically",
};

// The key is added only when there is a sentence to put in it. Keying off the verdict's scope kind instead
// (`v.why ? {...} : {}`) spelled every unmapped kind as `why: undefined` - invisible over JSON, but a property
// the object carries, which is one `?? ""` in a future caller away from rendering as an empty reason.
const describeVerdict = (v: PreviewVerdict): Viewer => {
  const why = v.why ? WHY[v.why] : undefined;
  return { name: v.name, email: v.email, write: v.write, ...(why ? { why } : {}) };
};
