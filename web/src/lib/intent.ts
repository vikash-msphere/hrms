import { useEffect, useRef } from "react";

// A tiny named-intent bus so a global action (command palette, top-bar "+" menu) can ask a page to do
// something the moment it lands there - e.g. "request-leave" navigates to the Leaves page and opens its
// request dialog, with no extra click. If the target page is already mounted the handler runs immediately;
// otherwise the intent stays pending until the page mounts and registers via useIntent (consumed on mount).
// An intent may carry an optional argument (e.g. "open-post" carries the post path to scroll to).
type Handler = (arg?: unknown) => void;
const handlers = new Map<string, Set<Handler>>();
let pending: { name: string; arg?: unknown } | null = null;

function dispatch() {
  if (!pending) return;
  const hs = handlers.get(pending.name);
  if (hs && hs.size) {
    const { arg } = pending;
    pending = null;
    hs.forEach((h) => h(arg));
  }
}

export function fireIntent(name: string, arg?: unknown) {
  pending = { name, arg };
  dispatch();
}

export function useIntent(name: string, handler: Handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const h = (arg?: unknown) => ref.current(arg);
    let set = handlers.get(name);
    if (!set) handlers.set(name, (set = new Set()));
    set.add(h);
    if (pending?.name === name) {
      const { arg } = pending;
      pending = null;
      h(arg);
    }
    return () => {
      set!.delete(h);
    };
  }, [name]);
}
