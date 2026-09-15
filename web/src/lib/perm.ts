import { createContext, useContext } from "react";

// UI gating against the server-computed capability set (users/me access.capabilities). THE MATCHING RULE IS
// THE SERVER'S (src/domain/capabilityMatch.ts), re-exported rather than restated: this was a byte-equivalent
// second implementation that declared itself a mirror, and a mirror is a thing that drifts. THIS IS UX ONLY -
// the server re-decides every request, which is why the shared leaf is safe to read on both sides.
import { hasCapability } from "../../../src/domain/capabilityMatch";
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
