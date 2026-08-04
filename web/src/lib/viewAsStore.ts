import { useSyncExternalStore } from "react";

// App-wide "view as" (access-mode simulation): the selected user's server-computed capability set. A tiny
// external store rather than context because the WRITER (the access-mode pill, deep in the tree) and the
// READER (App, at the very top, which swaps the capabilities on the `me` object it prop-drills through the
// whole shell) sit on opposite sides of the tree. Data identity is untouched - only capabilities swap.
export type ViewAs = { subject: string; email: string; role: string; capabilities: string[] } | null;

let current: ViewAs = null;
const subscribers = new Set<() => void>();

export function setViewAs(v: ViewAs): void {
  current = v;
  for (const fn of subscribers) fn();
}

export function useViewAs(): ViewAs {
  return useSyncExternalStore(
    (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    () => current,
  );
}
