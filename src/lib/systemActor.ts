import type { AppUser } from "../env";
import { GRANTS } from "../domain/grants";
import { DEFAULT_POLICY } from "../domain/manifests";

// The identity automation actions and internal dispatch act as. Not a real login: it is injected via
// env.__sharedCtx.user so a re-dispatched internal API call passes the authz middleware (super grant), and it
// satisfies the service signatures (audit email + employeeId). The privileged act is AUTHORING a rule (gated to
// hr_admin/super at the route), not the action execution. See docs/workflow-engine-plan.md (Security).
export function systemActor(): AppUser {
  return {
    uuid: "system",
    email: "system@automation",
    role: "super_admin",
    status: "active",
    employeeId: null,
    employeeCode: null,
    name: "System",
    grant: GRANTS.super_admin,
    policy: DEFAULT_POLICY,
  };
}
