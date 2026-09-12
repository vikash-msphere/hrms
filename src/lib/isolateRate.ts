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
  /**
   * Seconds to advertise in `Retry-After`: what is LEFT of the window that refused the call, not the window's
   * length. These are FIXED windows, so a caller throttled at second 59 is clear a second later - telling them
   * 60 parks a legitimate client (a provider's delivery worker, an SDK honouring the header) for a whole extra
   * window over a burst that has already passed. Read after `throttled` returns true; with no window open it
   * answers the full length, which is the only honest answer before anything has been counted.
   */
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
  /**
   * True when THIS key has spent its allowance for the current window. Counts the call.
   *
   * `cost` is how many units of the budget the call spends, for the surfaces whose unit is not "one request".
   * The batch transport is the one that needs it: an envelope carrying twenty sub-reads is twenty reads of
   * work, and charging it as one made the budget a count of envelopes rather than of the work they do (see
   * middleware/rateLimit.ts). Defaults to 1, which is every other caller.
   *
   * A cost ABOVE the remaining allowance refuses the call and still spends it: the work is what is being
   * bounded, so an oversized request must not slip through under a budget it cannot fit in.
   */
  throttled(key: string, nowMs: number, cost?: number): boolean;
  /** Seconds left in the window that refused the most recent `throttled` call - see IsolateRate. */
  retryAfterSeconds: number;
};

export function keyedCounter(maxPerWindow: number, windowMs = 60_000, maxKeys = 5_000): KeyedIsolateRate {
  const windows = new Map<string, { startedAt: number; count: number }>();
  // What `throttled` last looked at, so `retryAfterSeconds` can report the remainder of the window that
  // actually refused the call. A getter rather than a value for the same reason.
  //
  // ONE slot, not one per key: read `retryAfterSeconds` in the same synchronous stretch as the `throttled`
  // call it belongs to (which every caller does - there is no await between the two), and it is that key's
  // window. Await in between and it is whichever key was asked about most recently, because an isolate serves
  // many requests off one event loop.
  // NULL, not 0: a window can legitimately open at epoch 0 (every test clock does), and a falsy sentinel read
  // that as "no window yet" and reported the full length.
  let lastAt: number | null = null;
  let lastStartedAt: number | null = null;
  return {
    throttled(key: string, nowMs: number, cost = 1): boolean {
      let w = windows.get(key);
      if (!w || nowMs - w.startedAt >= windowMs) {
        if (!w && windows.size >= maxKeys) {
          for (const [k, v] of windows) if (nowMs - v.startedAt >= windowMs) windows.delete(k);
          if (windows.size >= maxKeys) windows.clear();
        }
        windows.set(key, (w = { startedAt: nowMs, count: 0 }));
      }
      // At least one, and integral: a caller must never buy a free call by declaring a cost of zero (or a
      // fractional one that never accumulates), whatever shape the request that produced the number had.
      w.count += Math.max(1, Math.floor(cost));
      lastAt = nowMs;
      lastStartedAt = w.startedAt;
      return w.count > maxPerWindow;
    },
    get retryAfterSeconds() {
      return lastAt === null || lastStartedAt === null ? Math.ceil(windowMs / 1000) : remainingSeconds(lastStartedAt, lastAt, windowMs);
    },
  };
}

export function counter(maxPerWindow: number, windowMs = 60_000): IsolateRate {
  let windowStartedAt = 0;
  let count = 0;
  let lastAt: number | null = null;
  return {
    throttled(nowMs: number): boolean {
      if (nowMs - windowStartedAt >= windowMs) {
        windowStartedAt = nowMs;
        count = 0;
      }
      count++;
      lastAt = nowMs;
      return count > maxPerWindow;
    },
    get retryAfterSeconds() {
      return lastAt === null ? Math.ceil(windowMs / 1000) : remainingSeconds(windowStartedAt, lastAt, windowMs);
    },
  };
}

/** Whole seconds left in a fixed window, at least 1 (a `Retry-After: 0` invites an immediate retry that the
 *  same window would refuse again). Callers answer the full length when no window has opened yet. */
function remainingSeconds(startedAt: number, nowMs: number, windowMs: number): number {
  return Math.max(1, Math.ceil((startedAt + windowMs - nowMs) / 1000));
}
