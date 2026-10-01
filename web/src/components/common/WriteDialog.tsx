import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AccessScope } from "@/components/access/AccessScope";
import { FormArm } from "@/components/common/Field";
import { FormError } from "@/components/common/FormError";
import { DraftNotice } from "@/components/common/DraftNotice";
import { useDialogDraft, useDialogGuard } from "@/components/common/dialogGuard";
import { describeError, fieldErrors } from "@/lib/formError";

// The shape every write modal has.
//
// Roughly eighty dialogs in this app create or update something, and each one needs the same seven things:
// a discard guard, a draft for long forms, the failure pinned in the form, an access scope so fields carry
// their affordance, a scrolling body so Save stays on screen, a footer that says why it's disabled, and a
// history entry so the back gesture closes it. Wiring those by hand is how the People & org modals ended up
// with none of them while the Money ones had all seven - convention doesn't hold across eighty call sites.
//
// So the pieces live here and a modal declares what it IS, not how it behaves:
//
//   <WriteDialog
//     open={open} onClose={() => setOpen(false)}
//     title={editing ? "Edit vendor" : "New vendor"}
//     description="Vendors are who an expense is paid to."
//     collection="vendors" objectPath={editing?.path}
//     form={form}
//     submitLabel={editing ? "Save changes" : "Create"}
//     canSubmit={!!form.name.trim()} whyNot="Give the vendor a name."
//     onSubmit={async () => { await create("vendors", form); reload(); }}
//   >
//     …fields…
//   </WriteDialog>
//
// `onSubmit` owning the write is the important part: busy state, error capture and message, re-baselining the
// guard, clearing the draft and closing all happen in ONE place, so no dialog can get any of them subtly
// wrong. It throws to fail - the thrown error becomes the message in the form, and the dialog stays open with
// everything the reader typed still in it.
export function WriteDialog<T>({
  open,
  onClose,
  title,
  description,
  collection,
  objectPath,
  form,
  draftKey,
  applyDraft,
  onStartOver,
  submitLabel,
  canSubmit = true,
  whyNot,
  onSubmit,
  onSaved,
  addAnother,
  addAnotherLabel = "Save & add another",
  cancelLabel = "Cancel",
  footerStart,
  submitAccess,
  guardLabel,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  /** One line on what happens after Save: who approves it, which run pays it, what it locks. */
  description?: React.ReactNode;
  /** Collection the fields inside belong to - gives every Field its manage-access affordance for free. */
  collection: string;
  /** The object being edited, when there is one, so a field rule pins to THIS record. */
  objectPath?: string;
  /** Current form value. Drives the discard guard and, with `draftKey`, what gets stashed. */
  form: T;
  /** Enables draft recovery for long forms. Omit on edit dialogs - a restored draft would silently overwrite
   *  values seeded from the record. */
  draftKey?: string;
  applyDraft?: (draft: T) => void;
  /** Resets the form to empty; also the "Start over" action on the restored-draft notice. */
  onStartOver?: () => void;
  submitLabel: string;
  canSubmit?: boolean;
  /** Why the submit is disabled, in one short sentence - or one per blocker. Shown next to the button and
   *  announced with it, so a greyed-out Save is never a dead end. Pass an array when a form can be short of
   *  more than one thing at once: naming only the first turns finishing it into a guessing game, one press at
   *  a time. Falsy entries are dropped, so `[!title && "Give it a title", …]` reads naturally at the call site. */
  whyNot?: string | (string | false | null | undefined)[];
  /** Performs the write. Throw to fail: the message lands in the form and the dialog stays open. */
  onSubmit: () => Promise<void> | void;
  onSaved?: () => void;
  /** Save and reopen empty, for the runs of records that get entered in one sitting. */
  addAnother?: () => void;
  addAnotherLabel?: string;
  cancelLabel?: string;
  /** Left-hand footer slot: a delete, a secondary action, a note. */
  footerStart?: React.ReactNode;
  /** Wrap the submit button, for the access affordance that belongs on the write itself:
   *  `submitAccess={(b) => <AccessAction create label="Create a task">{b}</AccessAction>}`. Fields get theirs
   *  from the AccessScope above; the create/update grant has no field to hang off, so it hangs off Save. */
  submitAccess?: (button: React.ReactNode) => React.ReactNode;
  /** What the discard prompt calls this ("your claim hasn't been saved yet"). */
  guardLabel?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // What the server blamed individual fields for, on the last failed submit. Handed to every Field through
  // FormArm, so a 400 lands on the field it is about instead of only above the form.
  const [fieldMsgs, setFieldMsgs] = React.useState<Record<string, string>>({});
  // Bumped on every blocked or failed submit: arms every Field's message at once, so pressing Save shows
  // everything standing in the way rather than only the fields that happen to have been visited.
  const [armed, setArmed] = React.useState(0);

  const guard = useDialogGuard(open, form, onClose, { label: guardLabel });
  const draft = useDialogDraft(draftKey ?? "unused", open, form, (d) => applyDraft?.(d), !!draftKey && !!applyDraft);
  // Back-to-close is NOT wired here: DialogContent owns one history entry per open dialog (see
  // ui/dialog.tsx), and it closes by dispatching Escape at its own content node - which arrives as
  // onOpenChange(false), i.e. through the same discard guard below. A second entry for the same dialog only
  // ever meant two entries pushed and one popped.

  // A dialog reopened after a failure starts clean rather than showing the last attempt's message.
  React.useEffect(() => {
    if (open) setError(null);
    if (open) setArmed(0);
    if (open) setFieldMsgs({});
  }, [open]);

  // Set by "save & add another": the emptied form becomes the new baseline once it has rendered, so the fresh
  // dialog is clean and closing it doesn't ask about changes nobody made. No dep array on purpose - it has to
  // run on the render that carries the reset.
  const rebaseline = React.useRef(false);
  React.useEffect(() => {
    if (!rebaseline.current) return;
    rebaseline.current = false;
    guard.markSaved();
  });

  async function run(after: "close" | "again") {
    if (busy) return;
    if (!canSubmit) {
      setArmed((n) => n + 1);
      return;
    }
    setBusy(true);
    setError(null);
    setFieldMsgs({});
    try {
      await onSubmit();
      onSaved?.();
      if (after === "again" && addAnother) {
        addAnother();
        // The reset lands in the NEXT render, so the baseline can only be taken after it: re-baselining here
        // would pin the values being cleared, and the emptied form would immediately read as dirty.
        rebaseline.current = true;
        draft.clear();
        setArmed(0);
      } else {
        guard.markSaved();
        draft.clear();
        onClose();
      }
    } catch (e) {
      const perField = fieldErrors(e);
      setFieldMsgs(perField);
      // With every field named, the sentence above the form would only repeat them. Kept for anything the
      // server did NOT pin to a field, which is where the useful prose lives ("leave overlaps an existing
      // request").
      setError(Object.keys(perField).length ? null : describeError(e));
      setArmed((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  const reasonId = React.useId();
  const blockers = (Array.isArray(whyNot) ? whyNot : [whyNot]).filter((r): r is string => !!r);
  return (
    <Dialog open={open} onOpenChange={guard.onOpenChange}>
      <DialogContent scrollBody className={className} onEnterSubmit={() => void run("close")}>
        <AccessScope collection={collection} objectPath={objectPath}>
          <FormArm armed={armed} fieldErrors={fieldMsgs}>
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              {description && <DialogDescription>{description}</DialogDescription>}
            </DialogHeader>
            <DialogBody>
              <FormError error={error} />
              {draft.restored && onStartOver && <DraftNotice onStartOver={() => { draft.clear(); onStartOver(); }} />}
              {children}
            </DialogBody>
            <DialogFooter className="sm:items-center sm:justify-between">
              {/* order-last on a phone. The footer is a reversed column there (see ui/dialog.tsx), which would
                  otherwise put this slot - typically Delete - at the very bottom of the sheet, the single most
                  thumb-reachable spot in the dialog, below even Cancel. A destructive action does not belong
                  there; it goes to the far end instead. Unchanged in the `sm` row. */}
              <div className="order-last flex min-w-0 items-center gap-2 sm:order-none">{footerStart}</div>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
                {/* Read out with the button rather than shown as an error: nothing has gone wrong yet, the
                    form simply isn't finished. */}
                {!canSubmit && blockers.length > 0 && (
                  <p
                    id={reasonId}
                    aria-live="polite"
                    className="text-xs text-muted-foreground sm:mr-1 sm:max-w-[22rem] sm:text-right"
                  >
                    {/* Every blocker, not the first: a form short of three things says all three, so finishing it
                        isn't three failed presses. */}
                    {blockers.map((r, i) => (
                      <span key={r} className="block">{blockers.length > 1 ? `${i + 1}. ${r}` : r}</span>
                    ))}
                  </p>
                )}
                <Button type="button" variant="outline" onClick={() => guard.onOpenChange(false)}>{cancelLabel}</Button>
                {addAnother && (
                  <Button type="button" variant="secondary" onClick={() => run("again")} disabled={busy || !canSubmit}>
                    {addAnotherLabel}
                  </Button>
                )}
                {((button: React.ReactNode) => (submitAccess ? submitAccess(button) : button))(
                  <Button
                    type="button"
                    onClick={() => run("close")}
                    loading={busy}
                    disabled={!canSubmit}
                    aria-describedby={!canSubmit && blockers.length > 0 ? reasonId : undefined}
                  >
                    {submitLabel}
                  </Button>,
                )}
              </div>
            </DialogFooter>
          </FormArm>
        </AccessScope>
      </DialogContent>
    </Dialog>
  );
}
