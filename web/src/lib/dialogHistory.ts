import { hasUnsavedChanges } from "@/router";

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

// Set once the document has started to go away - a reload, a link out, a closed tab. The drop runs on a timer
// after the layer's exit animation, so a reload pressed in the ~200ms after closing a dialog used to meet our
// own `history.back()` on its way out, and the traversal cancelled the reload outright: the press did nothing.
// Nothing needs dropping from a history the reader is leaving. Not set while an unsaved form is asking "leave
// without saving?" - the reader may stay, and then the entry still has to go.
let leaving = false;
window.addEventListener("beforeunload", () => {
  if (!hasUnsavedChanges()) leaving = true;
});

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
const pendingBacks: ((landed: boolean) => void)[] = [];
let listening = false;
const onPop = () => pendingBacks[0]?.(true);

// How long an announced `back()` may take to land before it is given up on. Long on purpose - see selfBack.
const BACK_DEADLINE_MS = 30_000;

/** `history.back()`, announced - see `isSelfPop`. `onLanded` runs inside the popstate the step produces. */
function selfBack(onLanded?: () => void): void {
  selfPops += 1;
  let settled = false;
  const settle = (landed: boolean) => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    pendingBacks.splice(pendingBacks.indexOf(settle), 1);
    if (landed) onLanded?.();
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
  // A back() with nothing to go back to fires no popstate at all, and without a deadline the flag would stay
  // up until the reader's next press, which it would then swallow. That is not the normal path: every caller
  // steps back off an entry `pushDialogEntry` added, so there is always one below and the pop always comes -
  // but under load it comes LATE, and a deadline that expires first turns the app's own back into the
  // reader's. It was 3s, and a busy browser took longer: the pop of a sprint form closed a moment earlier
  // reached the task dialog opened after it, unflagged, and closed that as though Back had been pressed. So the
  // deadline is sized for the missing pop, which costs one swallowed press at worst, never for the late one.
  const deadline = setTimeout(() => settle(false), BACK_DEADLINE_MS);
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

// A drop that has been decided but not yet run (it waits a task - see dropDialogEntry).
let pendingDrop: { token: number; timer: ReturnType<typeof setTimeout> } | null = null;

export function pushDialogEntry(): number {
  // REUSE an entry that is about to be dropped, rather than push a second one over it. That is the shape of a
  // layer unmounted and mounted again in one go - React's StrictMode runs every effect twice on mount, which
  // is exactly that - and of a dialog closing as another opens with no exit animation between them. Pushing
  // anyway left the first entry buried (the deferred drop sees a newer token and stands down), so every
  // dialog opened cost the reader one extra Back press on an address they were already on.
  if (pendingDrop && pendingDrop.token === lastPush && (window.history.state as { hrmsDialog?: boolean } | null)?.hrmsDialog === true) {
    clearTimeout(pendingDrop.timer);
    const over = pushedOver.get(pendingDrop.token) ?? window.location.href;
    pushedOver.delete(pendingDrop.token);
    pendingDrop = null;
    lastPush += 1;
    pushedOver.set(lastPush, over);
    return lastPush;
  }
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
  const timer = setTimeout(() => {
    if (pendingDrop?.token === token) pendingDrop = null;
    const stale = pushedOver.get(token);
    pushedOver.delete(token);
    if (token !== lastPush || leaving) return;
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
    // Run by `selfBack` on the pop THIS step produced, however late it lands, and never on any other: a
    // listener of its own either waits on whatever popstate comes next (a `back()` with nothing to go back to
    // fires none, and the next one is a navigation the reader asked for) or, on a short timer, misses a slow
    // pop and leaves the reopened record in the address.
    selfBack(stale && stale !== wanted
      ? () => { if (window.location.href === stale) window.history.replaceState(window.history.state, "", wanted); }
      : undefined);
  }, 0);
  // Visible to pushDialogEntry until it runs, so a layer that mounts again first takes this entry over.
  pendingDrop = { token, timer };
}
