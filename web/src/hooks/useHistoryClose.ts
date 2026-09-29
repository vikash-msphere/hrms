import * as React from "react";
import { dropDialogEntry, isSelfPop, pushDialogEntry } from "@/lib/dialogHistory";

// Back closes the topmost overlay - for every dialog AND every sheet in the app, not only the ones built on
// WriteDialog. On a phone a modal is a screen, so the back gesture has to dismiss it rather than unmount the
// page behind it; a right-docked sheet on a desktop is the same layer with different geometry, and the reader
// who presses Back over one means "close this", not "leave this page".
//
// Radix renders the content element's subtree only while the layer is open, so a component mounted INSIDE it
// is mounted exactly for one opening: pushing a history entry on mount and consuming it on unmount needs no
// open prop threaded from the caller. On a back press the entry we pushed is popped, and we close the layer by
// pressing its own Close button (`data-history-close`, or Escape at its content node when it has none) rather
// than by reaching for the caller's setState - which means each one closes through the path it already owns,
// including any unsaved-changes guard hanging off onOpenChange.
//
// "Inside it" is the whole contract, and getting it wrong is invisible until someone presses Back. The wrapper
// components in components/ui are NOT that place: a page writes `<Dialog open={false}><DialogContent/></Dialog>`
// and React mounts the wrapper straight away, closed or not. Called from there, every dialog a page declares -
// ten on a busy one - pushed an entry as the page loaded, and the reader then had to press Back ten times, on
// entries that pointed at the address they were already on, before the button appeared to do anything at all.
//
// `enabled` is false for a layer whose open state already lives in the URL (the inline settings sheet, keyed
// on `?setting=`): that opening pushed a route entry of its own, and a second entry would cost the reader two
// back presses to close one panel.
function useHistoryClose(node: HTMLElement | null, enabled: boolean) {
  const pushed = React.useRef(false);
  const popping = React.useRef(false);
  // Which entry is ours, taken at push time. Radix keeps a closing layer mounted through its exit animation,
  // so by cleanup another one may already own the top of the stack - see lib/dialogHistory.ts.
  const token = React.useRef(0);
  const nodeRef = React.useRef(node);
  nodeRef.current = node;

  React.useEffect(() => {
    if (!enabled) return;
    token.current = pushDialogEntry();
    pushed.current = true;

    const onPop = () => {
      if (!pushed.current) return;
      // A back() the APP asked for - a layer above this one dropping its entry as it closes - is not the
      // reader pressing back, and replaying it as Esc closes something nobody asked to close (or, on a guarded
      // form, re-raises the discard prompt they just dismissed). See lib/dialogHistory.ts#isSelfPop.
      if (isSelfPop()) return;
      pushed.current = false;
      // Already closing: closed from the UI and still mounted through its exit animation, with its entry not
      // yet dropped (that happens at unmount). The reader's Back is not for this layer - it is on its way out -
      // so it is for the page, and the entry it landed on is merely ours, left over. Carry the press on one more
      // step rather than swallow it: swallowed, a Back pressed straight after confirming a decision left the
      // reader on the same page, and pressing it again was the only way off.
      if (nodeRef.current?.getAttribute("data-state") === "closed") {
        window.history.back();
        return;
      }
      popping.current = true;
      // The layer's own Close button when it has one, and Escape only when it does not. Both reach the same
      // onOpenChange(false), guards included - but Escape goes to whichever dismissable layer is TOPMOST, and
      // a toast that appeared after this dialog opened is one: the back press dismissed "3 new notifications"
      // and left the dialog exactly where it was. A press on the button belongs to this layer alone.
      const close = nodeRef.current?.querySelector<HTMLElement>("[data-history-close]");
      if (close) close.click();
      else nodeRef.current?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      setTimeout(() => { popping.current = false; }, 0);
    };
    window.addEventListener("popstate", onPop);

    return () => {
      window.removeEventListener("popstate", onPop);
      // Closed from the UI instead: drop our entry, so the next back press goes to the previous page rather
      // than replaying this layer. `dropDialogEntry` decides when that is safe - notably NOT when this layer
      // closed by opening another one (see lib/dialogHistory.ts).
      if (pushed.current && !popping.current) dropDialogEntry(token.current);
      pushed.current = false;
    };
    // `enabled` is a fixed property of the call site (a routed sheet is always routed), so the effect is
    // mount/unmount-scoped either way.
  }, [enabled]);
}

/**
 * The back-to-close behaviour as a component, so it can be mounted where it belongs: inside the layer's own
 * content element, which exists only while that layer is open. Renders nothing.
 */
export function HistoryClose({ node, enabled = true }: { node: HTMLElement | null; enabled?: boolean }): null {
  useHistoryClose(node, enabled);
  return null;
}
