import * as React from "react";
import { AccessTarget } from "./AccessTarget";
import { useAccessScope } from "./AccessScope";
import { useAccessMode, type AccessTargetRef } from "./AccessModeProvider";
import { useCapabilities, hasCapability } from "@/lib/perm";
import { useViewAs } from "@/lib/viewAsStore";

// Marks an ACTION element (a button, link, or menu item) as an access-management target - the action
// counterpart to <Field> for data. In normal use it renders its children untouched (AccessTarget is a no-op
// when access mode is off). In access mode it overlays the manage icon, scoped to:
//   - a CUSTOM method (`verb` set) -> grant/deny that custom method on this object/collection, OR
//   - the object/collection level (no `verb`) -> manage read/write/admin, like a row/nav icon.
// Collection + objectPath default to the ambient AccessScope; pass them explicitly inside a table cell (where
// the ambient scope is the page collection but the object is per-row). `can` is the row's access.can hint.
export function AccessAction({
  verb,
  create,
  collection,
  objectPath,
  field,
  can,
  label,
  children,
}: {
  verb?: string;
  create?: boolean; // a "new <X>" button -> manage who can CREATE this collection (the create gate), not all objects
  collection?: string;
  objectPath?: string;
  field?: string;
  can?: string[];
  label?: string;
  children: React.ReactNode;
}) {
  const scope = useAccessScope();
  const am = useAccessMode();
  const caps = useCapabilities();
  const viewAs = useViewAs();
  const col = collection ?? scope?.collection;
  if (!col) return <>{children}</>; // nothing to scope to -> no affordance (server still enforces)
  // A create button is centrally capability-gated HERE: without `<collection>.write` at any scope the
  // server rejects the POST, so the affordance must not render - one gate covering every "new <X>" button
  // instead of per-page checks (and the reason view-as hides them). Access mode still shows it so an admin
  // can manage the create gate itself. VERB buttons are deliberately NOT gated by capabilities: a
  // per-object share grants a verb on one row without any broad capability, and those buttons are already
  // driven by the row's server-computed `access.can`.
  // "View as" is the exception to the access-mode exemption: exempting access mode would exempt every
  // simulation too and leave create buttons the simulated user could never use on screen while the rest of
  // the shell narrows correctly. Mid-simulation `caps` IS the simulated set (the server answers /users/me as
  // the subject), so gating on it answers the question honestly.
  if (create && (!am.enabled || viewAs) && !hasCapability(caps, `${col}.write`)) return null;
  // The ambient object only applies to an action of the SAME collection: an action explicitly re-collectioned
  // away from the ambient scope (the export icon on a tickets detail route, a settings-blob gear on a feature
  // page) must never pin to the foreign object - that would author a rule whose scope_ref belongs to another
  // collection.
  const ambientObject = collection && scope && collection !== scope.collection ? undefined : scope?.objectPath;
  // A create target is collection-level by definition: never inherit the ambient object path (that would pin
  // the create gate to one row).
  const target: AccessTargetRef = { collection: col, objectPath: create ? undefined : objectPath ?? ambientObject, field, verb, create, can, label };
  return <AccessTarget target={target}>{children}</AccessTarget>;
}
