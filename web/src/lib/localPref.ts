// Per-device presentation preferences in localStorage, with the try/catch that every one of them needs.
//
// WHY THIS EXISTS. `localStorage` is not a plain object: reading or writing it THROWS a SecurityError when the
// browser is set to block site data (Safari's "Block All Cookies", an enterprise policy, several embedded
// webviews), and in a few of those cases touching the `localStorage` property at all throws before you reach a
// method. Most call sites in this app already wrapped their write - and then read unwrapped, in a `useState`
// initializer, which is the worst place for it: a throw during render takes out the page, and the reader gets
// the crash boundary instead of a table.
//
// So the guard is not optional and it is not per-site judgement. It belongs to the accessor. Every value here
// is a per-device presentation choice (a view mode, a zoom, a fold, a remembered filter); the correct answer
// when storage is unavailable is always "use the default and carry on", which is exactly what these return.
//
// NOT for anything that must actually persist, be shared between devices, or be read back by the server -
// those go through lib/prefs.ts (a server preferences row) or lib/clientStore.ts (IndexedDB). See
// client-storage.md.

/** The stored string for `key`, or null when there is none - or when storage is unreadable. Never throws. */
export function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Store `value` under `key`. A no-op when storage is unavailable. Never throws. */
export function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked: the choice just does not survive this page */
  }
}

/** Forget `key`. A no-op when storage is unavailable. Never throws. */
export function removeLocal(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* storage blocked: there was nothing to forget anyway */
  }
}

/**
 * A stored JSON value, or `fallback` when the key is absent, unreadable or malformed.
 *
 * Malformed is a real case, not a defensive flourish: these keys outlive the shape that wrote them, so a build
 * that changes a saved filter's fields will read the old one back. Callers still have to validate the SHAPE of
 * what comes out - this only promises it parsed.
 */
export function readLocalJson<T>(key: string, fallback: T): T {
  const raw = readLocal(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Store `value` as JSON under `key`, or forget the key when `value` is null/undefined. Never throws. */
export function writeLocalJson(key: string, value: unknown): void {
  if (value === null || value === undefined) return removeLocal(key);
  try {
    writeLocal(key, JSON.stringify(value));
  } catch {
    /* unserialisable value: nothing useful to store */
  }
}
