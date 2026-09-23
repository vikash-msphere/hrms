// Drafts that are meant to outlive the browsing session: the announcement composer's post, a review write-up.
// Both hold real writing that took real time, and both are one stray click from gone, so they are offered back
// the next time that same form opens - days later if that is when the person comes back.
//
// They used to be written straight to localStorage, under a key that named only the row being edited. Two
// consequences, neither intended: a shared machine offered one person's draft to whoever signed in next (a
// manager's assessment of a named colleague, in the review case), and nothing ever removed one, so an
// abandoned draft sat there for the life of the browser profile.
//
// Here they are records in the shared store (lib/clientStore.ts), which namespaces them to the caller, expires
// them with the rest of the `draft` class, and drops them on sign-out. For a draft that only needs to survive
// a reload - the long dialogs - `useDialogDraft` in components/common/dialogGuard.ts is the session-scoped one.
import { registerHydrator, put, del } from "@/lib/clientStore";

type Held = { at: number; value: unknown };

const held = new Map<string, Held>();

registerHydrator("draft", {
  onRecords: (records) => {
    for (const r of records) {
      try {
        held.set(r.key, { at: r.ts, value: JSON.parse(r.value) });
      } catch {
        /* unparseable: the form opens empty, which is what it did before there were drafts at all */
      }
    }
  },
  onEvict: (keys) => {
    for (const k of keys) held.delete(k);
  },
  onReset: () => held.clear(),
});

/** The stored draft for `key`, with when it was written (the composer shows "written 20 minutes ago"). */
export function readDraft<T>(key: string): { at: number; value: T } | null {
  const h = held.get(key);
  return h ? { at: h.at, value: h.value as T } : null;
}

export function writeDraft(key: string, value: unknown): void {
  held.set(key, { at: Date.now(), value });
  put("draft", key, JSON.stringify(value));
}

export function clearDraft(key: string): void {
  held.delete(key);
  del("draft", key);
}
