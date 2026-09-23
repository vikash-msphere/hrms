import { useConfirm } from "@/components/common/confirm";

// Closing a half-filled create/edit dialog throws the draft away, and the two easiest ways to close one - a
// stray click on the backdrop and Esc - are both accidents. This wraps a dialog's `onOpenChange` so a dirty
// form asks before it disappears and a clean one still closes instantly (a guard that fires on an untouched
// form is just a second click on every cancel).
//
//   const guard = useDiscardGuard();
//   <Dialog open={open} onOpenChange={guard(dirty, () => setOpen(false))}>
//
// The dialog must be controlled: when the caller declines, nothing sets state, so it simply stays open.
export function useDiscardGuard() {
  const confirm = useConfirm();
  return (dirty: boolean, close: () => void) => (open: boolean) => {
    if (open) return;
    if (!dirty) {
      close();
      return;
    }
    void (async () => {
      const ok = await confirm({
        title: "Discard this draft?",
        description: "What you've filled in here hasn't been submitted yet.",
        confirmLabel: "Discard",
        cancelLabel: "Keep editing",
        destructive: true,
      });
      if (ok) close();
    })();
  };
}
