import * as React from "react";
import { KeyRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAccessMode, type AccessTargetRef } from "./AccessModeProvider";
import { metaFor } from "./collectionMeta";
import { verbInfo } from "./verbMeta";

// Tooltip for the key icon: name the target with the curated collection label (never the raw kebab token)
// and say WHAT KIND of rule the icon manages, so hovering answers "what will this key configure?".
function describeTarget(t: AccessTargetRef): string {
  const name = t.label ?? metaFor(t.collection).label;
  if (t.create) return `Manage access: who can create · ${name}`;
  if (t.verb) return `Manage access: ${verbInfo(t.collection, t.verb).label} · ${metaFor(t.collection).label}`;
  if (t.field) return `Manage access: "${t.label ?? t.field}" · ${metaFor(t.collection).label}`;
  return `Manage access: ${name}`;
}

// Marks a UI element as an access-control target. When access-management mode is OFF it renders its children
// untouched (zero overhead in normal use). When ON it surfaces a small "manage permissions" icon that opens
// the ACL modal scoped to this target. Used standalone (no children -> just the icon, e.g. a table row's
// action cell) or as a wrapper (children + the icon, e.g. a button or nav item). UX only; the server enforces.
export function AccessTarget({
  target,
  children,
  className,
}: {
  target: AccessTargetRef;
  children?: React.ReactNode;
  className?: string;
}) {
  const am = useAccessMode();
  if (!am.enabled) return <>{children ?? null}</>;

  // Red tint = an explicit deny rule covers this target - the lockouts worth finding. Amber = plain target.
  const deny = am.denyFor(target);
  const describe = describeTarget(target) + (deny ? " · an explicit deny is in effect here" : "");
  const icon = (
    <button
      type="button"
      title={describe}
      aria-label={describe}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        am.open(target);
      }}
      className={cn(
        "inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors",
        deny
          ? "text-red-600 ring-1 ring-red-400/70 hover:bg-red-100 dark:text-red-400 dark:hover:bg-red-950"
          : "text-amber-600 ring-1 ring-amber-400/60 hover:bg-amber-100 dark:hover:bg-amber-950",
        className,
      )}
    >
      <KeyRound className="h-3.5 w-3.5" />
    </button>
  );

  if (children === undefined) return icon;
  return (
    <span className="relative inline-flex items-center gap-1.5">
      {children}
      {icon}
    </span>
  );
}
