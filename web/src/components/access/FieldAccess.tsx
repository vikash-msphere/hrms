import { AccessTarget } from "./AccessTarget";
import { useAccessScope } from "./AccessScope";
import { fieldIconShouldShow } from "./accessRuleScope";
import type { AccessTargetRef } from "./AccessModeProvider";

// The data-element counterpart to <AccessAction> (which marks an action). Renders the manage-access icon for
// a field, deriving the target from the ambient <AccessScope> (collection + object) plus the `field` key - so
// a raw read-card row (dt/dd) gets the same affordance the shared <Field> form control already has, without
// each call site repeating the guard + target-building. Resolution: explicit `accessTarget` > ambient scope
// (+ `field` to refine to field scope) > nothing. Renders null when there is no field-level target (and the
// icon itself is a no-op when access mode is off), so it is always safe to drop in.
export function FieldAccess({ field, label, accessTarget }: { field?: string; label?: string; accessTarget?: AccessTargetRef }) {
  const scope = useAccessScope();
  const target: AccessTargetRef | undefined =
    accessTarget ?? (scope && fieldIconShouldShow(field) ? { collection: scope.collection, objectPath: scope.objectPath, field, label } : undefined);
  return target ? <AccessTarget target={target} /> : null;
}
