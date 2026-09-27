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
 * Is the popstate being delivered right now one the APP asked for?
 *
 * A confirm raised over a form is a dialog over a dialog, and when the confirm closes from the UI it drops its
 * own entry with `history.back()`. The popstate that produces reaches the form's listener too, which cannot
 * tell it from the reader pressing back - so the form replayed it as an Esc and asked "discard your changes?"
 * all over again, unprompted, the instant the reader chose "keep editing". Worse, the second ask arrives after
 * the reader has moved on, so the next Esc dismisses THAT instead of the form.
 *
 * The dialogs underneath consult this and sit out a back we caused. Their own entries are untouched by it.
 */
let selfPops = 0;
export const isSelfPop = (): boolean => selfPops > 0;

// One settle per outstanding `back()`, oldest first: each popstate answers exactly one of them.
const pendingBacks: (() => void)[] = [];
let listening = false;
const onPop = () => pendingBacks[0]?.();

/** `history.back()`, announced - see `isSelfPop`. */
function selfBack(): void {
  selfPops += 1;
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    pendingBacks.splice(pendingBacks.indexOf(settle), 1);
    // Lowered AFTER the whole dispatch, not inside it. Listeners run in the order they were added, and a
    // dialog that opened while the traversal was in flight - the rotated key's secret, minted by the press
    // that closed the confirm - added its listener after this one. Lowering the flag here handed that dialog
    // an unflagged pop, which it read as the reader pressing back: the new secret dismissed itself behind
    // "Close without copying the key?". A task runs after every listener has; a microtask would not.
    setTimeout(() => { selfPops -= 1; }, 0);
  };
  pendingBacks.push(settle);
  if (!listening) {
    window.addEventListener("popstate", onPop);
    listening = true;
  }
  // A back() with nothing to go back to fires no popstate at all; without this the flag would stay up and a
  // real back press would stop closing dialogs for the rest of the session. Generous, because it is not the
  // normal path: every caller steps back off an entry `pushDialogEntry` added, so there is always one below
  // and the pop always comes - but under load it can come late, and a deadline that expires first turns the
  // app's own back into the reader's.
  const deadline = setTimeout(settle, 3000);
  window.history.back();
}

/**
 * Add this dialog's history entry and return the token identifying it. Same URL, so the router (and its
 * unsaved-changes guard) is untouched - it skips a pop that lands on the address it was already showing.
 */
// The address each dialog entry was pushed OVER, by token. The entry underneath keeps that address forever,
// while the app may replace the current one while the dialog is open (closing a record dialog clears the
// record id with `setRouteRecord`) - so stepping back can resurrect an address the app has moved on from.
const pushedOver = new Map<number, string>();

export function pushDialogEntry(): number {
  const over = window.location.href;
  window.history.pushState({ ...(window.history.state ?? {}), hrmsDialog: true }, "");
  lastPush += 1;
  pushedOver.set(lastPush, over);
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
  // Forgotten either way. A dialog that is BURIED when it closes (one that opened another, and every dialog
  // closed while a newer one is up) returned here without ever dropping its address, so `pushedOver` kept one
  // href per such opening for the life of the tab, under a token that only ever counts up.
  if (token !== lastPush) {
    pushedOver.delete(token);
    return;
  }
  setTimeout(() => {
    const stale = pushedOver.get(token);
    pushedOver.delete(token);
    if (token !== lastPush) return;
    const ours = (window.history.state as { hrmsDialog?: boolean } | null)?.hrmsDialog === true;
    if (!ours) return;
    // Roll the token back so a dialog UNDER this one (a confirm over a form: the confirm drops first) still
    // recognises its own entry as the newest when its turn comes.
    lastPush = token - 1;
    // What we want from `back()` is the history STEP, not the address the older entry happens to carry. Those
    // differ when the app replaced the address while the dialog was open - closing a record dialog clears the
    // record id with `setRouteRecord`, which rewrites the CURRENT entry only, so the entry underneath still
    // names the record. Landing back on it puts the id in the URL again and the page reopens the dialog that
    // was just closed: a dialog that cannot be closed. So the address is corrected on the way through -
    // the router defers its own popstate handling to a microtask, so every correction made here has landed
    // before the route is parsed.
    //
    // Narrow on purpose. Only a landing on EXACTLY the address this entry was pushed over is corrected, and
    // only when the app has moved off it; anything else - the reader navigated while the dialog was open, a
    // later popstate this listener happens to catch - is a real destination and is left alone.
    const wanted = window.location.href;
    if (stale && stale !== wanted) {
      // Detached on a deadline as well as on the pop, for the reason `selfBack` keeps its own timer: a
      // `back()` with nothing to go back to fires no popstate at all. A `{ once: true }` listener then never
      // runs and never unregisters - it simply waits, and rewrites the address on whatever popstate comes
      // next, which by then is a navigation the reader asked for.
      const correct = () => {
        clearTimeout(deadline);
        window.removeEventListener("popstate", correct);
        if (window.location.href === stale) window.history.replaceState(window.history.state, "", wanted);
      };
      const deadline = setTimeout(() => window.removeEventListener("popstate", correct), 500);
      window.addEventListener("popstate", correct);
    }
    selfBack();
  }, 0);
}
