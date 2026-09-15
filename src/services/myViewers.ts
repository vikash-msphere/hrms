// "Who can see my record?" - the access report pointed at the person asking, rather than at the admin.
//
// Every effective-access surface in this app answers the ADMIN's question: who can do what, previewed from
// the permissions screen. Nobody could ask the other direction - the one an employee actually has - which is
// "who can read my bank details". The engine has always known; there was simply no way to ask it about
// yourself.
//
// It is `previewAccess` with the target NAILED to the caller's own employee record. That is the whole security
// argument: the target is never taken from the request, so holding this verb reveals nothing about anybody
// else's record, and the report is the same read-only assembly the ACL modal's preview panel already runs
// (test/singleSource.test.ts allow-lists it as a report, not an enforcement path).
import { eq, isNull, and } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { previewAccess, type PreviewVerdict } from "./accessPreview";
import { failedPrecondition } from "../lib/errors";

// The sub-resources reported alongside the base record - the ones whose exposure a person actually worries
// about. Mirrors AUDIT.sensitive_subresources (manifests.ts): if reading it is worth an audit row, it is worth
// telling its owner who can. `personal-info` is deliberately included even though it is not audited (it is the
// contact card, read constantly and so too noisy to log) - "who has my home address" is exactly this question.
const REPORTED_SUBRESOURCES = ["bank-account", "identity", "tax", "personal-info"] as const;

/** One person who can see something of yours, and how much. */
export type ViewerReport = {
  /** What is visible: "" for the base record, else the sub-resource name. */
  target: string;
  viewers: { name: string | null; email: string; role: string; why?: string }[];
};

/**
 * Everyone who can READ the caller's own employee record, and each of its sensitive sub-resources.
 *
 * The roster is capped at `previewAccess`'s own subject limit. On a larger org this is a SAMPLE, and the
 * response says so rather than quietly reporting a short list as if it were complete - a trust feature that
 * under-reports who can see your bank details is worse than no feature.
 */
export async function whoCanSeeMe(deps: Deps, actor: AppUser): Promise<{ reports: ViewerReport[]; roster: number; complete: boolean }> {
  if (!actor.employeeId) throw failedPrecondition("your account is not linked to an employee record");
  const self = `employees/${actor.employeeId}`;

  // Active, non-deleted people only: a leaver who still has a row is not someone reading your file today, and
  // listing them would make the report read as alarming when it is not.
  const roster = await deps.db
    .select({ uuid: schema.employees.uuid })
    .from(schema.employees)
    .where(and(isNull(schema.employees.deleteTime), eq(schema.employees.status, "active")))
    .limit(MAX_ROSTER + 1);
  const complete = roster.length <= MAX_ROSTER;
  const subjects = roster.slice(0, MAX_ROSTER).map((r) => `employees/${r.uuid}`);

  const reports: ViewerReport[] = [];
  for (const target of ["", ...REPORTED_SUBRESOURCES]) {
    const verdicts = await previewAccess(
      deps,
      { subjects, collection: "employees", object: self, ...(target ? { field: target } : {}) },
      actor,
    );
    reports.push({ target, viewers: verdicts.filter(canRead).map(describe) });
  }
  return { reports, roster: subjects.length, complete };
}

// `previewAccess` caps subjects at 100 per call; ask for exactly that and report whether the org outran it.
const MAX_ROSTER = 100;

// A disabled account cannot read anything, whatever its rules say - it is refused at auth. Listing one would
// name somebody who genuinely cannot see the record.
const canRead = (v: PreviewVerdict): boolean => v.read && !v.disabled && !v.denied;

const WHY: Record<string, string> = {
  self: "it is their own record",
  dept: "they are in your department",
  subtree: "they cover your part of the org",
  exact: "someone granted them this record",
  all: "their role can see everyone",
};

const describe = (v: PreviewVerdict) => ({
  name: v.name,
  email: v.email,
  role: v.role,
  ...(v.why ? { why: WHY[v.why] ?? undefined } : {}),
});
