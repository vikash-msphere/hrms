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

// Errors arm on blur, not on the first keystroke.
//
// A field that reddens while it is being typed into ("v" is not a valid email address) is telling the reader
// off for not having finished. So a Field holds its message back until the reader has left the field once -
// after which it updates live, because once you know a field is wrong you want to see it become right.
//
// A submit attempt arms every field at once through this context: pressing Save must surface everything that
// is blocking it, including fields nobody ever focused. WriteDialog bumps the counter; forms outside one can
// use <FormArm armed> directly.
const ArmCtx = React.createContext(0);

// What the server said about individual fields on the last failed submit, keyed by wire field name. Provided by
// WriteDialog (see lib/formError.ts#fieldErrors); a Field with a matching `field` prop shows it without the
// dialog having to thread anything through. Empty in forms that never failed, and cleared on the next attempt.
const FieldErrorCtx = React.createContext<Record<string, string>>({});

export function FormArm({ armed, fieldErrors, children }: { armed: number; fieldErrors?: Record<string, string>; children: React.ReactNode }) {
  return (
    <ArmCtx.Provider value={armed}>
      <FieldErrorCtx.Provider value={fieldErrors ?? EMPTY_FIELD_ERRORS}>{children}</FieldErrorCtx.Provider>
    </ArmCtx.Provider>
  );
}
// A stable identity, so a form with no server errors doesn't re-render every Field on every keystroke.
const EMPTY_FIELD_ERRORS: Record<string, string> = {};

export function Field({
  label,
  htmlFor,
  hint,
  info,
  action,
  error,
  eager,
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
  // shows below the field in place of `hint`. One prop turns any Field into a validated field. Held back
  // until the field has been left once (or a submit was attempted) - see ArmCtx.
  error?: string;
  // Show `error` the moment it's set, skipping the blur wait. For messages that aren't about what the reader
  // is typing - a value that became invalid because a DIFFERENT field changed, a server-derived conflict.
  eager?: boolean;
  // Like `hint`, but tucked behind an "i" tooltip next to the label instead of rendered below the input.
  // Use it to keep dense forms short. `hint` and `info` can coexist.
  info?: string;
  // A control for the field itself - a view switch, a clear - parked at the right end of the label row. It
  // belongs there rather than under the input: it acts on the whole field, so it reads as part of the field's
  // heading. Keep it small (an icon or icon+word ghost button); the label still has to win the row.
  action?: React.ReactNode;
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
  const armedAll = React.useContext(ArmCtx);
  const [blurred, setBlurred] = React.useState(false);
  // Re-arming on every submit attempt is what makes a second failed Save re-surface the same messages.
  const armed = eager || blurred || armedAll > 0;
  // The server's own verdict on this field, from the last failed submit. It wins over the local rule: the local
  // one is a guess at what the API will accept, this IS what it said, and it shows immediately (the reader has
  // already pressed Save - there is nothing left to wait for).
  const fromServer = field ? React.useContext(FieldErrorCtx)[field] : undefined;
  const shown = fromServer ?? (armed ? error : undefined);
  return (
    <div
      className={cn("space-y-1.5", grow && "flex min-h-0 flex-1 flex-col", className)}
      // Capture: blur doesn't bubble, and the control is the caller's - anything from a bare <input> to a
      // Combobox - so the wrapper listens rather than the field wiring each one.
      onBlurCapture={() => setBlurred(true)}
    >
      <div className="flex items-center gap-1.5">
        <Label htmlFor={htmlFor} className={cn(shown && "text-destructive")}>{label}</Label>
        {info && <InfoHint text={info} />}
        <FieldAccess field={field} label={label} accessTarget={accessTarget} />
        {action && <div className="ml-auto flex items-center">{action}</div>}
      </div>
      {/* On error, redden the contained control's border so the field reads as invalid without callers
          restyling each input. */}
      <div className={cn(grow && "min-h-0 flex-1", shown && "[&_input]:border-destructive [&_input]:focus-visible:ring-destructive [&_textarea]:border-destructive [&_textarea]:focus-visible:ring-destructive")}>
        {children}
      </div>
      {shown ? (
        <p role="alert" className="text-xs font-medium text-destructive">{shown}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
