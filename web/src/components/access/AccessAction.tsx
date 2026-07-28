import * as React from "react";
import { AccessTarget } from "./AccessTarget";
import { useAccessScope } from "./AccessScope";
import type { AccessTargetRef } from "./AccessModeProvider";

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
  const col = collection ?? scope?.collection;
  if (!col) return <>{children}</>; // nothing to scope to -> no affordance (server still enforces)
  // A create target is collection-level by definition: never inherit the ambient object path (that would pin
  // the create gate to one row).
  const target: AccessTargetRef = { collection: col, objectPath: create ? undefined : objectPath ?? scope?.objectPath, field, verb, create, can, label };
  return <AccessTarget target={target}>{children}</AccessTarget>;
}
