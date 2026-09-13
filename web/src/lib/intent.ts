import { useEffect, useRef } from "react";

// A tiny named-intent bus so a global action (command palette, top-bar "+" menu) can ask a page to do
// something the moment it lands there - e.g. "request-leave" navigates to the Leaves page and opens its
// request dialog, with no extra click. If the target page is already mounted the handler runs immediately;
// otherwise the intent stays pending until the page mounts and registers via useIntent (consumed on mount).
// An intent may carry an optional argument (e.g. "open-post" carries the post path to scroll to).
type Handler = (arg?: unknown) => void;
const handlers = new Map<string, Set<Handler>>();
let pending: { name: string; arg?: unknown; at: number } | null = null;

// A pending intent EXPIRES. `runQuickAction` fires the intent synchronously right after `navigate(route)` -
// before the target route has re-rendered, and long before its lazily-loaded chunk has resolved - so a pending
// intent routinely outlives the action that created it: ⌘K -> "Set a goal", then Back before Goals mounts, and
// `{ name: "new-goal" }` sat there for the rest of the session. Ten minutes later, opening Goals from the
// sidebar ran `useIntent("new-goal")` on mount, found it, and opened the New goal dialog with nothing having
// asked for it. The window only has to cover a route change plus a chunk download.
const INTENT_TTL_MS = 15_000;

function live(): { name: string; arg?: unknown } | null {
  if (!pending) return null;
  if (Date.now() - pending.at > INTENT_TTL_MS) {
    pending = null;
    return null;
  }
  return pending;
}

function dispatch() {
  const p = live();
  if (!p) return;
  const hs = handlers.get(p.name);
  if (hs && hs.size) {
    const { arg } = p;
    pending = null;
    hs.forEach((h) => h(arg));
  }
}

export function fireIntent(name: string, arg?: unknown) {
  pending = { name, arg, at: Date.now() };
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
    const p = live();
    if (p?.name === name) {
      const { arg } = p;
      pending = null;
      h(arg);
    }
    return () => {
      set!.delete(h);
    };
  }, [name]);
}
