import { useEffect, useState } from "react";
import { api, ApiError } from "./api";
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
function fetchMe(): Promise<Me | null> {
  return fetchMeRaw().then((u) =>
    u ? { email: u.email, role: u.role, employee_id: u.employee ? idOf(u.employee) : null, capabilities: u.access?.capabilities ?? [] } : null,
  );
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
