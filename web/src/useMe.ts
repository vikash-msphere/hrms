import { useEffect, useState } from "react";
import { api, ApiError } from "./api";
import { getViewAs } from "./lib/viewAsStore";
import { idOf } from "./lib/utils";
import type { Me, User } from "./types";

export type { Me };

// GET /v1/users/me is fetched ONCE per session and shared by every consumer (useMe AND the ACL scope-caps
// loader), so identity never fires more than once - including under StrictMode's double-mount. Memoize the RAW
// User promise so callers that need different slices (capabilities vs access.scopes) reuse the same request.
let mePromise: Promise<User | null> | null = null;
export function fetchMeRaw(): Promise<User | null> {
  return (mePromise ??= api<User>("/users/me").catch((e) => {
    // A genuine 401 means "not signed in" -> resolve null so the app shows the sign-in screen. Any OTHER
    // failure (500, network, CORS) is NOT an auth state: rethrow so the caller can show a distinct
    // "couldn't reach server" screen, and drop the memo so a retry re-fires instead of caching the failure.
    if (e instanceof ApiError && e.status === 401) return null;
    mePromise = null;
    throw e;
  }));
}
const toMe = (u: User | null): Me | null =>
  u
    ? {
        email: u.email,
        role: u.role,
        employee_id: u.employee ? idOf(u.employee) : null,
        capabilities: u.caller_access?.capabilities ?? [],
        // Absent on an old/partial response means "own or nothing" for every collection, which is the
        // fail-closed direction: no per-record affordance renders until the server says how far the grant reaches.
        scopes: {
          read: (u.caller_access?.read_scopes ?? {}) as Me["scopes"]["read"],
          write: (u.caller_access?.write_scopes ?? {}) as Me["scopes"]["write"],
        },
        holiday_feed_token: u.holiday_feed_token ?? null,
        session_id: u.session_id ?? null,
      }
    : null;

function fetchMe(): Promise<Me | null> {
  return fetchMeRaw().then(toMe);
}

// While a "view as" simulation is open, EVERY request answers as the subject - including /users/me, which is
// what makes the whole shell theirs. The access-mode chrome must still judge by the REAL admin (a simulated
// user without access-rules.write would otherwise hide the pill that ends the simulation), so identity is
// fetched a second time with the simulation suppressed. No extra request when nothing is being simulated.
let realMePromise: Promise<User | null> | null = null;
function fetchRealMe(): Promise<Me | null> {
  if (!getViewAs()) return fetchMe();
  return (realMePromise ??= api<User>("/users/me", { asRealCaller: true }).catch((e) => {
    realMePromise = null;
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  })).then(toMe);
}

/**
 * The signed-in admin behind the shell: the same person as `useMe()` unless a simulation is running.
 *
 * Read ONCE, on mount, and that is load-bearing rather than an oversight: `getViewAs()` is sampled inside
 * `fetchRealMe`, so this answers for whichever simulation state the page booted in. It stays correct because
 * starting or stopping one RELOADS the page (lib/viewAsStore.ts) - the whole module graph, this memo with it.
 * If that ever stops being true, this hook has to subscribe rather than run on an empty dependency list.
 */
export function useRealMe(): Me | null {
  const [real, setReal] = useState<Me | null>(null);
  useEffect(() => {
    let active = true;
    fetchRealMe().then(
      (m) => active && setReal(m),
      () => active && setReal(null),
    );
    return () => {
      active = false;
    };
  }, []);
  return real;
}

export function useMe() {
  const [me, setMe] = useState<Me | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let active = true;
    fetchMe().then(
      (m) => {
        if (!active) return;
        setMe(m);
        setError(null);
        setLoaded(true);
      },
      (e) => {
        if (!active) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoaded(true);
      },
    );
    return () => {
      active = false;
    };
  }, [nonce]);
  // Retry after a server/network error: clears the memo (dropped above) and re-runs the effect.
  const retry = () => {
    setLoaded(false);
    setError(null);
    setNonce((n) => n + 1);
  };
  return { me, loaded, error, retry };
}
