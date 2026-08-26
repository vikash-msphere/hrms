// The session-history entry an open dialog owns.
//
// On a phone a modal IS a screen, so the back gesture has to dismiss it rather than unmount the page behind
// it. `useHistoryClose` (in the dialog primitive, so every dialog in the app gets it) pushes one entry per
// opening and drops it again when the dialog is closed from the UI - otherwise the reader would owe one back
// press for every dialog they already dismissed by hand.
//
// Dropping it is the subtle half, and it has TWO orderings to survive, because a dialog that opens another
// dialog as it closes (create an API key, then show the secret exactly once) has both dialogs alive at the
// same moment:
//
//   - Radix keeps a closing dialog mounted through its exit animation, so the closing dialog's cleanup runs
//     ~200ms AFTER the new dialog has pushed its entry. By then the top of the stack belongs to the new
//     dialog, and "is the top entry a dialog entry?" answers yes about somebody else's. Hence the token: it
//     is taken when we push, so it can only match while nothing has pushed after us.
//   - When there is no exit animation, the cleanup runs BEFORE the new dialog pushes. `history.back()` does
//     not pop synchronously - the popstate lands on a later task - so the pop would arrive after the new
//     dialog had pushed and registered its listener. Hence the deferred re-check.
//
// Either way the mistake is the same and it is not subtle to the reader: the pop lands on the NEW dialog,
// whose handler reads it as a back press and closes the dialog that just opened. That is how a freshly minted
// key dismissed itself, uncopied, behind a confirm nobody asked for.
//
// When we do skip, the closing dialog's entry is left buried rather than popped - one dead entry that costs
// an extra back press, which is the cheap side of this trade.
let lastPush = 0;

/**
 * Add this dialog's history entry and return the token identifying it. Same URL, so the hash router (and its
 * unsaved-changes guard) is untouched.
 */
export function pushDialogEntry(): number {
  window.history.pushState({ ...(window.history.state ?? {}), hrmsDialog: true }, "");
  lastPush += 1;
  return lastPush;
}

/**
 * Drop the entry `token` identifies, if it is still the newest one and still on top.
 *
 * Skipped when another dialog has pushed since (ours is buried, and popping would close theirs), and when the
 * current entry is not a dialog entry at all - a link inside the dialog pushes its own, and going back from
 * there would drag the reader off the page they just opened.
 */
export function dropDialogEntry(token: number): void {
  if (token !== lastPush) return;
  setTimeout(() => {
    if (token !== lastPush) return;
    const ours = (window.history.state as { hrmsDialog?: boolean } | null)?.hrmsDialog === true;
    if (!ours) return;
    // Roll the token back so a dialog UNDER this one (a confirm over a form: the confirm drops first) still
    // recognises its own entry as the newest when its turn comes.
    lastPush = token - 1;
    window.history.back();
  }, 0);
}
