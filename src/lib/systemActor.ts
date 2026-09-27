import type { AppUser } from "../env";
import type { Deps } from "../deps";
import { SUPER_GRANT } from "../domain/grants";
import { loadManifest } from "./policyLoad";

// The identity automation actions and internal dispatch act as. Not a real login: it is injected via
// env.__sharedCtx.user so a re-dispatched internal API call passes the authz middleware (super grant), and it
// satisfies the service signatures (audit email + employeeId). The privileged act is AUTHORING a rule (gated to
// hr_admin/super at the route), not the action execution. See docs/workflow-engine-plan.md (Security).
//
// Its role is `system`, which names no `roles` row: the grant is the engine's super wildcard itself, not any
// role's data, so no edit in Access Management can widen or narrow what the system actor may do, and the audit
// trail records `system` rather than claiming a person's role acted. Its POLICY is the stored manifest, like
// every caller's - which reads are audited as sensitive is the org's call, and the system actor is audited by
// the same rule.
export async function systemActor(deps: Deps): Promise<AppUser> {
  return {
    uuid: "system",
    email: "system@automation",
    role: "system",
    roles: ["system"],
    status: "active",
    employeeId: null,
    employeeCode: null,
    name: "System",
    grant: SUPER_GRANT,
    policy: await loadManifest(deps),
  };
}
