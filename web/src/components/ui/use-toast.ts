// Lightweight toast store adapted from shadcn/ui.
import * as React from "react";
import type { ToastProps } from "./toast";

const TOAST_LIMIT = 4;
const TOAST_REMOVE_DELAY = 5000;

type ToasterToast = ToastProps & {
  id: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Inline action button (e.g. Undo). Clicking it also dismisses the toast. */
  action?: { label: string; onClick: () => void };
  /** How long the toast stays up (ms). Defaults to TOAST_REMOVE_DELAY; undo toasts pass a longer window. */
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
const timeouts = new Map<string, ReturnType<typeof setTimeout>>();

function dispatch(state: State) {
  memoryState = state;
  listeners.forEach((l) => l(memoryState));
}

function scheduleRemove(id: string, delay = TOAST_REMOVE_DELAY) {
  if (timeouts.has(id)) return;
  const t = setTimeout(() => {
    timeouts.delete(id);
    dispatch({ toasts: memoryState.toasts.filter((x) => x.id !== id) });
  }, delay);
  timeouts.set(id, t);
}

// A toast that leaves state before its timer fires - swiped away, dismissed with ToastClose, or pushed out by
// TOAST_LIMIT - has nothing left to remove, but its timer still ran and still dispatched a whole new `toasts`
// array, re-rendering every `useToast()` consumer for a toast that was already gone.
function cancelRemove(id: string) {
  const t = timeouts.get(id);
  if (t === undefined) return;
  clearTimeout(t);
  timeouts.delete(id);
}

type ToastInput = Omit<ToasterToast, "id">;

function toast(props: ToastInput) {
  const id = genId();
  const newToast: ToasterToast = {
    ...props,
    id,
    open: true,
    onOpenChange: (open) => {
      if (open) return;
      cancelRemove(id);
      dispatch({ toasts: memoryState.toasts.filter((x) => x.id !== id) });
    },
  };
  const next = [newToast, ...memoryState.toasts];
  // Whatever the limit pushes out is gone from state, so its timer is cancelled with it.
  for (const evicted of next.slice(TOAST_LIMIT)) cancelRemove(evicted.id);
  dispatch({ toasts: next.slice(0, TOAST_LIMIT) });
  scheduleRemove(id, props.duration);
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
