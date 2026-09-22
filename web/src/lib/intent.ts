import { useEffect, useRef } from "react";

// A tiny named-intent bus so a global action (command palette, top-bar "+" menu) can ask a page to do
// something the moment it lands there - e.g. "request-leave" navigates to the Leaves page and opens its
// request dialog, with no extra click. If the target page is already mounted the handler runs immediately;
// otherwise the intent stays pending until the page mounts and registers via useIntent (consumed on mount).
// An intent may carry an optional argument (e.g. "open-post" carries the post path to scroll to).
type Handler = (arg?: unknown) => void;
const handlers = new Map<string, Set<Handler>>();
let pending: { name: string; arg?: unknown; at: number; page: string } | null = null;

// A pending intent is FOR THE PAGE IT WAS FIRED ON. `runQuickAction` fires the intent synchronously right
// after `navigate(route)` - before the target route has re-rendered, and long before its lazily-loaded chunk
// has resolved - so a pending intent routinely outlives the action that created it: ⌘K -> "Set a goal", then
// Back before Goals mounts, and `{ name: "new-goal" }` sat there for the rest of the session. Ten minutes
// later, opening Goals from the sidebar ran `useIntent("new-goal")` on mount, found it, and opened the New
// goal dialog with nothing having asked for it.
//
// Leaving the page is what says the intent is spent, so that is what drops it. It used to be a stopwatch
// alone, which is not the same question and cannot be sized: the window has to cover a chunk download plus
// the page's own first reads, and anything short enough to make a forgotten intent rare is short enough to
// lose a real one on a loaded machine - the quick-action walk lost "Create a task" and "Set a goal" that way,
// on a page that was still loading when the clock ran out. The clock stays as a backstop for an intent nobody
// ever navigates away from, at a length that is about a slow page rather than about a fast one.
const INTENT_TTL_MS = 120_000;

/** The page an address is on - the first path segment, which is what a quick action navigates to. The rest
 *  (a record id, a sub-tab) is the page's own business and moves while it is being looked at. */
const pageOf = (path: string) => path.replace(/^\/+/, "").split("/")[0] ?? "";

function live(): { name: string; arg?: unknown } | null {
  if (!pending) return null;
  if (Date.now() - pending.at > INTENT_TTL_MS || pageOf(window.location.pathname) !== pending.page) {
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
  // The page recorded here is the DESTINATION: `navigate` has already pushed it by the time a quick action
  // fires its intent, and an intent fired without navigating is for the page the reader is on. Either way it
  // is the page this intent belongs to, and leaving it drops the intent (see `live`).
  pending = { name, arg, at: Date.now(), page: pageOf(window.location.pathname) };
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
