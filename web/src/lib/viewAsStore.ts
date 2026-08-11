// App-wide "view as" (access-mode simulation). The store holds the SUBJECT the app is currently answering as;
// api.ts stamps it on every request as `X-View-As` and the server installs that person as the request
// principal (src/lib/viewAs.ts), so the simulation is honest end to end: their nav, their rows, their
// redactions. It used to swap only the capability set in the browser, which gated the chrome but still fetched
// the ADMIN's data - so "view as an employee" showed records that employee can never see.
//
// Two consequences shape this module:
//   - the header must ride the VERY FIRST request of a page load, so the selection is read from localStorage
//     synchronously at import time - never awaited, never fetched;
//   - starting or stopping a simulation changes whose data every cached answer belongs to, so both RELOAD the
//     page. That drops every module cache at once (resource store, GET coalescer, photo cache, page state),
//     which is the only way to be sure none is left holding the other identity's rows.
export type ViewAs = {
  subject: string; // "users/<wire-id>" or "employees/<wire-id>" - the ref the server resolves
  label: string; // what the picker showed (name · email), for the pill
  admin: string; // the email of the admin who started it; a different signed-in user drops the selection
} | null;

const KEY = "hrms:viewAs";

function read(): ViewAs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as ViewAs;
    return v && typeof v.subject === "string" && v.subject.includes("/") ? v : null;
  } catch {
    return null;
  }
}

let current: ViewAs = read();

/** The active simulation, readable from non-React code (api.ts stamps the header off this). */
export function getViewAs(): ViewAs {
  return current;
}

/** Same value for components. It never changes without a page reload, so no subscription is needed. */
export function useViewAs(): ViewAs {
  return current;
}

/** Begin simulating `subject`. Persists the choice and reloads, so the whole app boots as that person. */
export function startViewAs(v: NonNullable<ViewAs>): void {
  current = v;
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* ignore - the simulation still runs for this page life */
  }
  window.location.reload();
}

/** End the simulation (also the escape hatch when the server refuses one) and reload as the real caller. */
export function stopViewAs(): void {
  if (!current) return;
  current = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  window.location.reload();
}
