import * as React from "react";
import { AccessTarget } from "./AccessTarget";
import { useAccessScope } from "./AccessScope";
import { useAccessMode, type AccessTargetRef } from "./AccessModeProvider";
import { useCapabilities, hasCapability } from "@/lib/perm";
import { isCustomMethod } from "./customMethods";
import { useViewAs } from "@/lib/viewAsStore";

// Marks an ACTION element (a button, link, or menu item) as an access-management target - the action
// counterpart to <Field> for data. In normal use it renders its children untouched (AccessTarget is a no-op
// when access mode is off). In access mode it overlays the manage icon, scoped to:
//   - a CUSTOM method (`verb` set) -> grant/deny that custom method on this object/collection, OR
//   - the object/collection level (no `verb`) -> manage read/write/admin, like a row/nav icon.
// Collection + objectPath default to the ambient AccessScope; pass them explicitly inside a table cell (where
// the ambient scope is the page collection but the object is per-row).
//
// It is also the GATE for the action it wraps: `can` is the row's server-computed `access.can`, and a `verb`
// missing from it renders nothing. So an action button says what it needs (`verb`, including the standard
// `update`/`delete`) and hands over the row's hint, and the affordance appears only for a caller who may use
// it - no page-level `can.includes(...)` needed, and no button that can only 403.
export function AccessAction({
  verb,
  create,
  collection,
  objectPath,
  field,
  can,
  label,
  manageOnly,
  children,
}: {
  verb?: string;
  create?: boolean; // a "new <X>" button -> manage who can CREATE this collection (the create gate), not all objects
  collection?: string;
  objectPath?: string;
  field?: string;
  can?: string[];
  label?: string;
  // The child is a DISPLAY element that happens to name this verb (a read-only Status select still showing
  // which column a task sits in), not an affordance to withhold: carry the manage icon, skip the gate. Only
  // for children that are inert without the verb - never to keep a live button on screen.
  manageOnly?: boolean;
  children?: React.ReactNode; // omitted -> the key icon alone (access mode only), for a verb with no button of its own
}) {
  const scope = useAccessScope();
  const am = useAccessMode();
  const caps = useCapabilities();
  const viewAs = useViewAs();
  const col = collection ?? scope?.collection;
  if (!col) return <>{children ?? null}</>; // nothing to scope to -> no affordance (server still enforces)
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
  // A verb affordance is gated HERE the same way: an action the caller cannot invoke must not render, so
  // nobody is offered a button whose only outcome is 403. One gate instead of a `can.includes(verb) &&` at
  // every call site (a page may still write one - then redundant, not wrong). The row's server-computed
  // `access.can` answers per OBJECT and is the precise answer whenever a row is in hand; without it (a
  // collection-level action - "submit the week", "reject the selection") the caller's capability set is the
  // honest answer, since a verb held nowhere cannot be exercised here either. Access mode still shows the
  // affordance (an admin manages gates they do not hold themselves), except mid-simulation, where the
  // simulated user's own answer is what must be on screen.
  // The capability fallback speaks the capability vocabulary: a standard method (update/delete) is the WRITE
  // level, not a verb of its own name.
  const verbCap = verb && (isCustomMethod(verb) ? `${col}.${verb}` : `${col}.write`);
  if (verb && verbCap && !manageOnly && (!am.enabled || viewAs) && !(can ? can.includes(verb) : hasCapability(caps, verbCap))) return null;
  // The ambient object only applies to an action of the SAME collection: an action explicitly re-collectioned
  // away from the ambient scope (the export icon on a tickets detail route, a settings-blob gear on a feature
  // page) must never pin to the foreign object - that would author a rule whose scope_ref belongs to another
  // collection.
  const ambientObject = collection && scope && collection !== scope.collection ? undefined : scope?.objectPath;
  // A create target is collection-level by definition: never inherit the ambient object path (that would pin
  // the create gate to one row).
  // `verb` may name a STANDARD method (update/delete) - an edit or delete button declaring what it needs, so
  // the gate above can answer it. That is a level rule, not a custom-method rule, so it never reaches the
  // target: the icon on such a button manages the object's read/write/admin level, exactly as an un-verbed one.
  const ruleVerb = isCustomMethod(verb) ? verb : undefined;
  const target: AccessTargetRef = { collection: col, objectPath: create ? undefined : objectPath ?? ambientObject, field, verb: ruleVerb, create, can, label };
  return <AccessTarget target={target}>{children}</AccessTarget>;
}
