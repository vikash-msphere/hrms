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
// dispatching Escape at its own content node rather than by reaching for the caller's setState - which means
// each one closes through the path it already owns, including any unsaved-changes guard hanging off
// onOpenChange.
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
      popping.current = true;
      nodeRef.current?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
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
