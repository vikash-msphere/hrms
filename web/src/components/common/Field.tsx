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

// Which controls a Field may point its `<label for>` at.
//
// A label has to name the control, and `for` only means anything when it resolves to a LABELABLE element -
// an input, a textarea, a select, a button. Callers were expected to pass `htmlFor` and hand the same id to
// the control themselves; across ~126 fields almost nobody did, so most labels in the app named nothing and
// were invisible to a screen reader (and to `getByLabel` in a test). Threading ids through every call site
// would just be the same opportunity to forget, so Field mints one and binds it here.
//
// The list is deliberately a list rather than "clone whatever the child is". Cloning blindly would put the id
// on a `<div>` wrapper or a Radix `<Select>` root that drops unknown props, and a `for` pointing at a
// non-labelable element - or at nothing at all - is worse than no `for`: it claims an association the browser
// will not honour. Anything not named here keeps the old behaviour (no association) until it is taught to
// accept an id, which is a visible gap rather than a silent lie.
//
// A field whose control is wrapped in a layout `<div>` (a stepper on each side, a row of chips underneath)
// still needs `htmlFor` from the caller: the control is not a child of the Field then, and this cannot see
// past the wrapper without cloning blindly, which is the thing above.
//
// Matched on displayName because a minified build mangles Function.name - hence the explicit assignments in
// ui/combobox.tsx and friends.
const LABELABLE = new Set(["input", "textarea", "select", "button", "Input", "Textarea", "Combobox", "MoneyInput", "Select"]);

/** Is this child a control a `<label for>` may point at? */
function labelable(child: React.ReactNode): child is React.ReactElement<{ id?: string }> {
  if (!React.isValidElement(child)) return false;
  const type = child.type as string | { displayName?: string };
  const name = typeof type === "string" ? type : type.displayName;
  return !!name && LABELABLE.has(name);
}

function useLabelledControl(children: React.ReactNode, htmlFor?: string): [React.ReactNode, string | undefined] {
  const generated = React.useId();
  if (htmlFor) return [children, htmlFor]; // the caller wired it up itself
  // The FIRST labelable child, not "the only child". A field very often holds more than one thing - an input
  // plus its datalist, a stepper either side of it, a row of quick-set chips under it - and requiring a lone
  // child meant every one of those fields had a label that named nothing, silently. The first labelable
  // child is the field's control by construction: the extras are its helpers, and they come after it.
  const kids = React.Children.toArray(children);
  const control = kids.find(labelable);
  if (!control) return [children, undefined];
  const existing = control.props.id;
  if (existing) return [children, existing]; // the control already has an identity; name that one
  return [kids.map((k) => (k === control ? React.cloneElement(control, { id: generated }) : k)), generated];
}

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
  const [control, controlId] = useLabelledControl(children, htmlFor);
  // Re-arming on every submit attempt is what makes a second failed Save re-surface the same messages.
  const armed = eager || blurred || armedAll > 0;
  // The server's own verdict on this field, from the last failed submit. It wins over the local rule: the local
  // one is a guess at what the API will accept, this IS what it said, and it shows immediately (the reader has
  // already pressed Save - there is nothing left to wait for).
  // The context is read unconditionally and INDEXED conditionally. Reading it inside the ternary made the
  // hook depend on the `field` prop, so a caller that renders the same <Field> with and without one changes
  // this component's hook count between renders.
  const serverErrors = React.useContext(FieldErrorCtx);
  const fromServer = field ? serverErrors[field] : undefined;
  const shown = fromServer ?? (armed ? error : undefined);
  return (
    <div
      className={cn("space-y-1.5", grow && "flex min-h-0 flex-1 flex-col", className)}
      // Capture: blur doesn't bubble, and the control is the caller's - anything from a bare <input> to a
      // Combobox - so the wrapper listens rather than the field wiring each one.
      onBlurCapture={() => setBlurred(true)}
    >
      <div className="flex items-center gap-1.5">
        <Label htmlFor={controlId} className={cn(shown && "text-destructive")}>{label}</Label>
        {info && <InfoHint text={info} />}
        <FieldAccess field={field} label={label} accessTarget={accessTarget} />
        {action && <div className="ml-auto flex items-center">{action}</div>}
      </div>
      {/* On error, redden the contained control's border so the field reads as invalid without callers
          restyling each input. */}
      <div className={cn(grow && "min-h-0 flex-1", shown && "[&_input]:border-destructive [&_input]:focus-visible:ring-destructive [&_textarea]:border-destructive [&_textarea]:focus-visible:ring-destructive")}>
        {control}
      </div>
      {shown ? (
        <p role="alert" className="text-xs font-medium text-destructive">{shown}</p>
      ) : hint ? (
        // data-sentry-unmask: a hint is copy we wrote, never the reader's data, and masking it left the
        // control it explains standing on its own inside a masked panel.
        <p data-sentry-unmask className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
