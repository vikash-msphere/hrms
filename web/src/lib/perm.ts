import { createContext, useContext } from "react";

// UI gating against the server-computed capability set (users/me access.capabilities). THE MATCHING RULE IS
// THE SERVER'S (src/domain/capabilityMatch.ts), re-exported rather than restated: this was a byte-equivalent
// second implementation that declared itself a mirror, and a mirror is a thing that drifts. THIS IS UX ONLY -
// the server re-decides every request, which is why the shared leaf is safe to read on both sides.
import { hasCapability } from "../../../src/domain/capabilityMatch";
import type { CallerScopes } from "../types";
export { hasCapability };

// The caller's capability set, provided once at the app root (from me.capabilities) so <Can>/usePermission
// don't need it prop-drilled.
export const CapabilitiesContext = createContext<string[]>([]);

export function useCapabilities(): string[] {
  return useContext(CapabilitiesContext);
}

export function usePermission(perm: string): boolean {
  return hasCapability(useCapabilities(), perm);
}

export const NO_SCOPES: CallerScopes = { read: {}, write: {} };

/**
 * The caller's per-collection READ/WRITE breadth beyond their OWN rows (users/me
 * caller_access.read_scopes/write_scopes). Empty by default, so a consumer outside the provider fails closed.
 *
 * THIS IS A CALLER-LEVEL ANSWER AND ONLY EVER ANSWERS A CALLER-LEVEL QUESTION: "is there anybody but me I
 * could do this for at all" - should the org chart offer a who-is-off overlay, should the approvals page show
 * a queue whose whole premise is deciding for someone else. It is probed with synthetic codes, so it reports a
 * TIER and names nobody.
 *
 * It is therefore NOT the gate for a surface about a NAMED person - use `useSubjectCanRead` /
 * `useSubjectCanWrite` there. A tier cannot say whether THIS person is in the caller's team, is the subject of
 * a per-object share, or is the caller themselves; asking it on a profile shows a manager the tab for everyone
 * and the rows for their reports alone.
 */
export const ScopesContext = createContext<CallerScopes>(NO_SCOPES);

export function useCanReadOthers(collection: string): boolean {
  return !!useContext(ScopesContext).read[collection];
}
export function useCanWriteOthers(collection: string): boolean {
  return !!useContext(ScopesContext).write[collection];
}

/**
 * What the caller may reach ABOUT THE ONE PERSON a page is showing, as the server decided it
 * (`access.subject` on the employee item - src/domain/access.ts `subjectScopes`). Empty by default, so a
 * consumer mounted outside a provider shows nothing.
 *
 * THE CLIENT HOLDS NO POLICY. It does not know that an employee sees their own record, that a manager sees
 * their team, or that HR sees everyone - those are rules in `access_rules`, and the org that deploys this
 * will have roles that look nothing like the seeded ones. The engine decided every one of these keys against
 * THIS person's code, so `me` answered for the owner, `my-dept` / `my-reports` / `my-org` for the team, a
 * `<code>-*` rule for a branch and a per-object share for the single record. Reading a key here is reading
 * that decision, not re-deriving it.
 *
 * Why this and not `usePermission`: a capability string is scope-STRIPPED on the server
 * (domain/permissions.ts stripScope), so `attendance.me.**` and `attendance.**` both arrive as
 * `attendance.read`. That answers "may I call the attendance endpoint at all", which is the right question
 * for a nav item or a route gate and the wrong one for a surface about a named person - it is true for
 * everybody, about everybody.
 *
 * Keys are collection names, plus `employees.<sub>` for the field-precise sub-resources and
 * `activity.<collection>` for the per-entity trail. UX only: the server re-decides every request.
 */
export type SubjectScopes = { read: ReadonlySet<string>; write: ReadonlySet<string> };
export const NO_SUBJECT_SCOPES: SubjectScopes = { read: new Set(), write: new Set() };
export const SubjectScopesContext = createContext<SubjectScopes>(NO_SUBJECT_SCOPES);

/** Build the context value from an employee resource's `access.subject`. Absent = nothing, which fails closed. */
export function subjectScopesOf(access?: { subject?: { read?: string[]; write?: string[] } }): SubjectScopes {
  const sub = access?.subject;
  if (!sub) return NO_SUBJECT_SCOPES;
  return { read: new Set(sub.read ?? []), write: new Set(sub.write ?? []) };
}

/** May the caller read `collection` about the person this page is showing? */
export function useSubjectCanRead(collection: string): boolean {
  return useContext(SubjectScopesContext).read.has(collection);
}
/** May the caller write `collection` about the person this page is showing? */
export function useSubjectCanWrite(collection: string): boolean {
  return useContext(SubjectScopesContext).write.has(collection);
}

// Holds the `**` wildcard - the only grant collection stripScope never touches, so it is the one capability
// string no scoped grant (self, dept, or an explicit all-scope field grant) can also produce. Needed wherever
// a check must mean "every record, not just mine": e.g. "employees.bank-account.write" is true for EVERY
// role via its own self-service PII grant, so it can't tell a super_admin viewing a colleague's record apart
// from that colleague viewing their own - only the wildcard can.
export function useIsSuperAdmin(): boolean {
  const caps = useCapabilities();
  return caps.includes("**.write") || caps.includes("**.**");
}

// May the caller see the per-entity ACTIVITY trail — the broad `activity.read` cap (any collection) OR the
// per-collection `activity.<collection>.read` cap. UX only: the server still ANDs this with reading the record
// (a narrowed holder who opens the wrong record just gets an empty feed). Pass the record's collection (the
// first path segment) so a per-collection grant lights up only its own collection's affordance.
export function canSeeActivity(caps: string[], collection?: string): boolean {
  return hasCapability(caps, "activity.read") || (!!collection && hasCapability(caps, `activity.${collection}.read`));
}
export function useCanSeeActivity(collection?: string): boolean {
  return canSeeActivity(useCapabilities(), collection);
}

// May the caller EXPORT — the broad `export.read` cap (any table) OR the per-collection
// `export.<collection>.read` cap, exactly like activity above. Export is generated in the browser from rows
// already on screen, so this is the gate: it decides which tables offer the affordance, and an export can
// still only ever contain what the holder could already read (the list endpoint has already filtered it).
// Splitting it per collection is what lets "may export leave data" exist without also meaning "may export
// payroll". Pass the table's collection so a narrowed grant lights up only its own.
export function canExport(caps: string[], collection?: string): boolean {
  return hasCapability(caps, "export.read") || (!!collection && hasCapability(caps, `export.${collection}.read`));
}
export function useCanExport(collection?: string): boolean {
  return canExport(useCapabilities(), collection);
}

// "Manage access" permission (access-management mode). After the role/user unification there is ONE
// access-control resource (`access-rules`), so a single capability governs managing access for both roles
// and users; it gates the toggle and both modal tabs. Super passes via the ** wildcard. UX only - the
// backend still enforces every access-rules write.
export function useCanManageAccess(): boolean {
  return hasCapability(useCapabilities(), "access-rules.write");
}
