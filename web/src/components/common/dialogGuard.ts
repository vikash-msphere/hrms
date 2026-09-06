import * as React from "react";
import { useConfirm } from "@/components/common/confirm";
import { storedIdentity } from "@/lib/clientStore";

/**
 * The storage key for an in-progress form, namespaced to the caller.
 *
 * Exported because three dialogs kept their own draft plumbing before this - the announcement composer, the
 * leave request and the review write-up - and two of them wrote to local storage under an un-namespaced key,
 * with no expiry. So a performance review's free text about a named person stayed on a shared machine
 * indefinitely and was offered back to the next person who signed in.
 */
export const draftKey = (key: string) => `draft:${storedIdentity() ?? "anon"}:${key}`;

/**
 * Stops a half-filled dialog from evaporating on a stray click.
 *
 * Radix funnels Esc, an outside click and the X button through one `onOpenChange(false)`, so a single
 * interception covers every way out. When the form is untouched it closes silently - a guard that fires on an
 * empty form is just a second click - and when it holds edits it asks first.
 *
 * Dirtiness is a snapshot: the baseline is whatever the value was when the dialog opened, so a dialog opened
 * for editing (state set, then opened) starts clean and turns dirty on the first real change.
 *
 *   const guard = useDialogGuard(open, form, () => setOpen(false));
 *   <Dialog open={open} onOpenChange={guard.onOpenChange}>
 */
export function useDialogGuard(open: boolean, value: unknown, close: () => void, opts?: { label?: string }) {
  const confirm = useConfirm();
  const snap = React.useMemo(() => JSON.stringify(value) ?? "", [value]);
  const baseline = React.useRef<string | null>(null);
  const latest = React.useRef(snap);
  latest.current = snap;

  // Deliberately keyed on `open` alone: this must capture the value AS THE DIALOG OPENS and then stop looking,
  // which is exactly what an effect that ignores later `snap` changes does.
  React.useEffect(() => {
    baseline.current = open ? latest.current : null;
  }, [open]);

  const dirty = open && baseline.current != null && snap !== baseline.current;

  const onOpenChange = React.useCallback(
    (next: boolean) => {
      if (next) return;
      if (!dirty) {
        close();
        return;
      }
      void (async () => {
        const ok = await confirm({
          title: "Discard your changes?",
          description: opts?.label ? `Your ${opts.label} hasn't been saved yet.` : "What you've filled in hasn't been saved yet.",
          destructive: true,
          confirmLabel: "Discard",
          cancelLabel: "Keep editing",
        });
        if (ok) close();
      })();
    },
    [dirty, close, confirm, opts?.label],
  );

  // Call after a successful save so the now-persisted value counts as the baseline (a save that also normalizes
  // the draft - trimming, rounding - then settles clean instead of looking edited).
  //
  // Pass the value explicitly when the save is followed by a reset in the same handler ("save & add another"):
  // state hasn't re-rendered yet at that point, so the no-argument form would re-baseline to the value being
  // replaced and the emptied form would read as dirty.
  const markSaved = React.useCallback((value?: unknown) => {
    baseline.current = value === undefined ? latest.current : JSON.stringify(value) ?? "";
  }, []);

  return { dirty, onOpenChange, markSaved };
}

/**
 * Survives more than a stray click: keeps a long form's in-progress values, so a reload, a crash, or a phone
 * switching apps mid-claim doesn't cost the work.
 *
 * The caller owns the shape; this only stores and returns it, plus a `restored` flag to show the "picked up
 * where you left off" strip and a `clear` for a successful submit or an explicit start-over.
 *
 * Two properties that are not incidental. The key is namespaced to the SIGNED-IN CALLER: an un-namespaced
 * draft on a shared machine is offered back to whoever opens the same dialog next, which for a review write-up
 * or a leave reason means handing one person another's words. And it is session-scoped, so a draft is "I'll
 * finish this in a minute" rather than something that sits on the disk indefinitely; `lib/clientStore.ts` `gc`
 * sweeps whatever an older build left behind in local storage.
 */
export function useDialogDraft<T>(key: string, open: boolean, value: T, apply: (draft: T) => void, enabled = true) {
  const storageKey = draftKey(key);
  const [restored, setRestored] = React.useState(false);
  // Restoring must happen once per opening, and only when there is something worth restoring.
  const applyRef = React.useRef(apply);
  applyRef.current = apply;

  React.useEffect(() => {
    if (!open || !enabled) {
      setRestored(false);
      return;
    }
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (!raw) return;
      applyRef.current(JSON.parse(raw) as T);
      setRestored(true);
    } catch {
      /* a corrupt or unreadable draft is not worth a message - the form simply opens empty */
    }
  }, [open, enabled, storageKey]);

  // Written on every change while open. sessionStorage writes are synchronous but tiny here (a form's worth of
  // strings), and the alternative - saving on close - is exactly the case that fails when the tab dies.
  React.useEffect(() => {
    if (!open || !enabled) return;
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(value));
    } catch {
      /* storage full or blocked: drafts are a convenience, never a requirement */
    }
  }, [open, enabled, storageKey, value]);

  const clear = React.useCallback(() => {
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      /* nothing to clean up */
    }
    setRestored(false);
  }, [storageKey]);

  return { restored, clear };
}
