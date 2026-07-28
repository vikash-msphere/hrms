import * as React from "react";
import { KeyRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAccessMode, type AccessTargetRef } from "./AccessModeProvider";

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

  const icon = (
    <button
      type="button"
      title={`Manage access: ${target.label ?? target.collection}`}
      aria-label={`Manage access for ${target.label ?? target.collection}`}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        am.open(target);
      }}
      className={cn(
        "inline-flex h-6 w-6 items-center justify-center rounded-md text-amber-600 ring-1 ring-amber-400/60 transition-colors hover:bg-amber-100 dark:hover:bg-amber-950",
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
