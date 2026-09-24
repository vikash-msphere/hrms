// Lightweight toast store adapted from shadcn/ui.
import * as React from "react";
import type { ToastProps } from "./toast";

const TOAST_LIMIT = 4;
// Long enough to read a two-line description and reach its action button. Radix pauses the countdown while
// the pointer or focus is on the toast and while the window is in the background, so this is reading time,
// not wall-clock time.
const TOAST_DURATION = 8000;

type ToasterToast = ToastProps & {
  id: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Inline action button (e.g. Undo). Clicking it also dismisses the toast. */
  action?: { label: string; onClick: () => void };
  /** How long the toast stays up (ms). Defaults to TOAST_DURATION. */
  duration?: number;
};

let count = 0;
function genId() {
  count = (count + 1) % Number.MAX_SAFE_INTEGER;
  return count.toString();
}

type State = { toasts: ToasterToast[] };
const listeners: Array<(state: State) => void> = [];
let memoryState: State = { toasts: [] };

function dispatch(state: State) {
  memoryState = state;
  listeners.forEach((l) => l(memoryState));
}

type ToastInput = Omit<ToasterToast, "id">;

// The close timer is Radix's alone (toaster.tsx hands it `duration`). When it runs out, or the toast is swiped
// or dismissed, Radix calls onOpenChange(false) and the toast leaves state here. A second timer in this store
// would not pause on hover, so it pulled toasts out from under the pointer of somebody reading them.
function toast(props: ToastInput) {
  const id = genId();
  const newToast: ToasterToast = {
    ...props,
    id,
    duration: props.duration ?? TOAST_DURATION,
    open: true,
    onOpenChange: (open) => {
      if (open) return;
      dispatch({ toasts: memoryState.toasts.filter((x) => x.id !== id) });
    },
  };
  dispatch({ toasts: [newToast, ...memoryState.toasts].slice(0, TOAST_LIMIT) });
  return id;
}

function useToast() {
  const [state, setState] = React.useState<State>(memoryState);
  React.useEffect(() => {
    listeners.push(setState);
    return () => {
      const i = listeners.indexOf(setState);
      if (i > -1) listeners.splice(i, 1);
    };
  }, []);
  return { ...state, toast };
}

export { useToast, toast };
