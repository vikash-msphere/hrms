// The caller's matcher context, assembled for one request.
//
// `employeeCode` is free - it rode the auth read. The MANAGER CHAIN is not: resolving who reports to somebody
// costs an indexed read (and, for the transitive form, one per level). Almost no grant mentions those tokens, so
// this resolves them only when the caller's own grant actually uses one, which keeps the cost at exactly zero
// for every request that was never going to ask. See domain/permissions.ts `grantNeedsReports`.
//
// FAIL-CLOSED BY CONSTRUCTION: a caller with no employee record has no reporting line, so the sets stay
// undefined and `my-reports` / `my-org` match nothing. That is the honest answer - a service account does not
// manage anybody - and it is the same direction every other unresolved scope fails in.
import type { AppUser } from "../env";
import type { Deps } from "../deps";
import { grantNeedsReports, type SelfContext } from "../domain/permissions";
import { loadReportCodes } from "./policyLoad";

export async function selfContextFor(deps: Deps, user: Pick<AppUser, "grant" | "employeeCode" | "employeeId">): Promise<SelfContext> {
  const base: SelfContext = { employeeCode: user.employeeCode ?? null };
  const need = grantNeedsReports(user.grant);
  if (!user.employeeId || (!need.direct && !need.org)) return base;
  // `my-org` is a superset of `my-reports`, but they are loaded and cached separately rather than derived from
  // one another: a grant that uses only the direct form must not pay for a transitive walk, and the two have
  // different cache keys precisely so the cheap one stays cheap.
  const [reportCodes, orgCodes] = await Promise.all([
    need.direct ? loadReportCodes(deps, user.employeeId, false) : Promise.resolve(undefined),
    need.org ? loadReportCodes(deps, user.employeeId, true) : Promise.resolve(undefined),
  ]);
  return { ...base, reportCodes, orgCodes };
}
