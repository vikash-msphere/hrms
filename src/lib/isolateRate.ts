/**
 * A per-isolate request floor for the UNAUTHENTICATED routes.
 *
 * WHAT THIS IS NOT: the rate limit. The control is the Cloudflare WAF rule (docs/deploy-security.md §1), and
 * `npm run preflight` refuses a production deploy until an operator confirms it is configured. A Worker cannot
 * see traffic an edge rule blocks, and a counter living in one isolate's memory is not a limit across a fleet
 * of them - a caller spread over enough colos gets one allowance per isolate.
 *
 * WHY IT IS HERE ANYWAY: the routes outside /v1 take no credential, by nature - a login, a provider webhook, a
 * telemetry envelope from a page that may not be signed in. Each of them does real work per request (a JWKS
 * fetch and an OAuth round trip; an HMAC verify and a vendor poll; a megabyte forwarded to the tracker), so
 * "unlimited until the WAF is configured" is the wrong default for the window between deploying and
 * configuring it. One isolate serves a lot of requests from one colo, so this turns unlimited into bounded
 * per isolate per minute for the cost of two integers and no storage.
 *
 * Each caller gets its OWN counter (`counter()` per route), because the budgets are not comparable: a login
 * burst is a person retrying, a webhook burst is a vendor redelivering.
 */
export type IsolateRate = {
  /** True when this isolate has already spent its allowance for the current window. Counts the call. */
  throttled(nowMs: number): boolean;
  /** Seconds to advertise in `Retry-After`. */
  retryAfterSeconds: number;
};

/**
 * The same fixed window, counted PER CALLER instead of per route.
 *
 * `counter()` above is the right shape for the unauthenticated lanes, where there is no caller to name and
 * the whole route is the thing being protected. Inside /v1 there is a principal on every request, so the
 * budget belongs to them: one busy integration must not spend the allowance of everyone else on the isolate,
 * which is exactly what a single shared counter would do the moment it started refusing anything.
 *
 * Same caveat as the whole file - this is a FLOOR, not the limit (the WAF rule is), and a caller spread over
 * enough isolates gets one allowance per isolate. What it buys is that no single credential can drive an
 * unbounded number of the expensive requests through one isolate for free.
 *
 * `maxKeys` bounds the memory: an isolate is long-lived and serves many principals, so the map is swept when
 * it grows past the cap. The sweep drops whole EXPIRED windows first (they are dead weight by definition);
 * only if that is not enough does it clear everything, which costs some callers a reset window and never
 * grants anyone more than their budget.
 */
export type KeyedIsolateRate = {
  /** True when THIS key has spent its allowance for the current window. Counts the call. */
  throttled(key: string, nowMs: number): boolean;
  retryAfterSeconds: number;
};

export function keyedCounter(maxPerWindow: number, windowMs = 60_000, maxKeys = 5_000): KeyedIsolateRate {
  const windows = new Map<string, { startedAt: number; count: number }>();
  return {
    throttled(key: string, nowMs: number): boolean {
      let w = windows.get(key);
      if (!w || nowMs - w.startedAt >= windowMs) {
        if (!w && windows.size >= maxKeys) {
          for (const [k, v] of windows) if (nowMs - v.startedAt >= windowMs) windows.delete(k);
          if (windows.size >= maxKeys) windows.clear();
        }
        windows.set(key, (w = { startedAt: nowMs, count: 0 }));
      }
      w.count++;
      return w.count > maxPerWindow;
    },
    retryAfterSeconds: Math.ceil(windowMs / 1000),
  };
}

export function counter(maxPerWindow: number, windowMs = 60_000): IsolateRate {
  let windowStartedAt = 0;
  let count = 0;
  return {
    throttled(nowMs: number): boolean {
      if (nowMs - windowStartedAt >= windowMs) {
        windowStartedAt = nowMs;
        count = 0;
      }
      count++;
      return count > maxPerWindow;
    },
    retryAfterSeconds: Math.ceil(windowMs / 1000),
  };
}
