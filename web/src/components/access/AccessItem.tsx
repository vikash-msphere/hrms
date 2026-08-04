import * as React from "react";
import { AccessTarget } from "./AccessTarget";
import { AccessScope, useAccessScope } from "./AccessScope";
import type { AccessTargetRef } from "./AccessModeProvider";

// The universal drop-in for any bare card / widget / list-item that is NOT built from DataTable, <Field>, or
// <RowActions> (Loans cards, Kudos, Suggestions, Benefits, Events, board posts, dashboard feed widgets,
// org-chart nodes, ...). Generalizes DataTable's per-row access affordance into one wrapper:
//   (a) nests an item-level <AccessScope> (collection + objectPath) so every Field/AccessAction/FieldAccess
//       inside auto-scopes to THIS object - no per-child wiring;
//   (b) in access mode, overlays the standard corner manage-key (top-right), scoped to this object, carrying
//       the object's access.can hint for the modal's "current" banner.
// `collection` falls back to the ambient AccessScope (a card grid usually sits inside a page-level scope), so
// most call sites only pass `objectPath` + `can`. Zero overhead when access mode is off (the icon is a no-op).
export function AccessItem({
  collection,
  objectPath,
  field,
  verb,
  can,
  why,
  label,
  className,
  iconClassName,
  children,
}: {
  collection?: string;
  objectPath?: string;
  field?: string;
  verb?: string;
  can?: string[];
  why?: "all" | "subtree" | "exact" | "self" | "dept";
  label?: string;
  className?: string; // applied to the positioning wrapper
  iconClassName?: string; // applied to the corner icon (override placement if a card has its own top-right control)
  children: React.ReactNode;
}) {
  const scope = useAccessScope();
  const col = collection ?? scope?.collection;
  if (!col) return <>{children}</>; // nothing to scope to -> no affordance (server still enforces)

  // Same cross-collection guard as AccessAction: an item re-collectioned away from the ambient scope never
  // inherits the ambient object (a foreign scope_ref would corrupt the authored rule).
  const ambientObject = collection && scope && collection !== scope.collection ? undefined : scope?.objectPath;
  const target: AccessTargetRef = { collection: col, objectPath: objectPath ?? ambientObject, field, verb, can, why, label };

  return (
    <AccessScope collection={col} objectPath={objectPath ?? ambientObject}>
      <div className={className ? `relative ${className}` : "relative"}>
        <AccessItemCorner target={target} iconClassName={iconClassName} />
        {children}
      </div>
    </AccessScope>
  );
}

// The corner icon, absolutely positioned top-right of the wrapper. Rendered as a no-op (returns null) when
// access mode is off, so the wrapper adds no markup beyond the positioning <div> in normal use.
function AccessItemCorner({ target, iconClassName }: { target: AccessTargetRef; iconClassName?: string }) {
  return (
    <AccessTarget
      target={target}
      className={iconClassName ?? "absolute right-2 top-2 z-10 bg-background/80 backdrop-blur-sm"}
    />
  );
}
