import * as React from "react";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";
import { FieldAccess } from "@/components/access/FieldAccess";
import { InfoHint } from "@/components/common/InfoHint";
import type { AccessTargetRef } from "@/components/access/AccessModeProvider";

// Lay short, related fields (Amount + Installments, Start + End, …) side by side on desktop and stack them on
// mobile. Prefer this over a raw `grid grid-cols-2`, which forces two columns even on a phone. Use for paired
// short inputs only; keep full-width fields (textareas, long selects) outside it.
export function FieldRow({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("grid gap-4 sm:grid-cols-2", className)}>{children}</div>;
}

export function Field({
  label,
  htmlFor,
  hint,
  info,
  error,
  children,
  accessTarget,
  field,
  className,
  grow,
}: {
  label: string;
  className?: string;
  // Let the control fill the height the field is given, so a textarea can end level with a neighbouring column
  // instead of leaving a gap. The control itself still needs `h-full`.
  grow?: boolean;
  htmlFor?: string;
  hint?: string;
  // Inline validation message. When set it reddens the label, the contained input/textarea border, and
  // shows below the field in place of `hint`. One prop turns any Field into a validated field.
  error?: string;
  // Like `hint`, but tucked behind an "i" tooltip next to the label instead of rendered below the input.
  // Use it to keep dense forms short. `hint` and `info` can coexist.
  info?: string;
  children: React.ReactNode;
  // Access-management affordance. Resolution order: explicit `accessTarget` > ambient AccessScope (+ optional
  // `field` to refine to field-scope) > nothing. So inside an AccessScope every field gets the icon for free;
  // pass `field` (the wire field key) to manage that field's write-grant precisely, else it manages the object.
  accessTarget?: AccessTargetRef;
  field?: string;
}) {
  // The manage-access affordance (icon + modal) is encapsulated in <FieldAccess>: explicit `accessTarget` >
  // ambient AccessScope (+ optional `field` to refine to field scope) > nothing. So inside an AccessScope
  // every field gets the icon for free; pass `field` (the wire key) to manage that field precisely.
  // `grow` needs flex-1 on the field ITSELF to claim the leftover height of the flex column it sits in - without
  // that the field only takes its natural height and the control inside it never fills.
  return (
    <div className={cn("space-y-1.5", grow && "flex min-h-0 flex-1 flex-col", className)}>
      <div className="flex items-center gap-1.5">
        <Label htmlFor={htmlFor} className={cn(error && "text-destructive")}>{label}</Label>
        {info && <InfoHint text={info} />}
        <FieldAccess field={field} label={label} accessTarget={accessTarget} />
      </div>
      {/* On error, redden the contained control's border so the field reads as invalid without callers
          restyling each input. */}
      <div className={cn(grow && "min-h-0 flex-1", error && "[&_input]:border-destructive [&_input]:focus-visible:ring-destructive [&_textarea]:border-destructive [&_textarea]:focus-visible:ring-destructive")}>
        {children}
      </div>
      {error ? (
        <p className="text-xs font-medium text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
