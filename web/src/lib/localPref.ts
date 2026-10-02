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

// The PERSON these keys belong to (email, plus any "view as" subject), set by the shell once `/me` lands. Not
// the record store's identity (lib/clientStore.ts `storedIdentity`): that one folds in the session, so the
// cached rows live exactly as long as the sign-in that fetched them. A preference has to outlive the session -
// "reopen the board I was last on" means the board from yesterday's sign-in too - and under the session-scoped
// key every one of these was written once and never read back after the next sign-in.
let prefUser: string | null = null;

/** Namespace every `userKey` to `key` (the signed-in person, or undefined when nobody is). */
export function setLocalPrefUser(key: string | undefined): void {
  prefUser = key || null;
}

/**
 * `key` namespaced to the signed-in caller, or null before the identity is known.
 *
 * WHY EVERY PER-PERSON KEY NEEDS IT. localStorage is per BROWSER, not per person, and an ordinary session end
 * does not clear it (`clientStore.purgeCachedData` deliberately leaves localStorage alone; only the sign-out
 * menu's `purgeAll` calls `localStorage.clear()`). So a key holding one person's choices is handed to whoever
 * signs in next on a shared machine - which for a board filter pinned to a named colleague, a remembered letter
 * template or a dismissed enrolment prompt is somebody else's state presented as yours. `tab_seen:`, `dt:`,
 * `draft:`, `nav:collapsed:` and `palette:frecent:` already do this, and three separate modules document the
 * shared-machine failure that made them.
 *
 * Returns null rather than an "anon" fallback: a record written before identity lands is never read back under
 * the real key, so it would be silently lost - and worse, adopted by the next caller.
 *
 * Not for a genuinely per-DEVICE choice (the theme, the scanner's camera): those are correct as bare keys.
 */
export function userKey(key: string): string | null {
  return prefUser ? `${key}:${prefUser}` : null;
}

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
