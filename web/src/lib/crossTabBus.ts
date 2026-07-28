// Generic same-origin cross-tab message bus over a single BroadcastChannel, multiplexed by topic so every
// feature shares ONE underlying connection. BroadcastChannel never delivers a message back to the tab that
// sent it, so handlers can apply remote messages without looping. Best-effort: when BroadcastChannel is
// absent (old browsers, some webviews) publish/subscribe become no-ops and callers fall back to their
// existing focus-refetch / TTL behaviour.
//
// Why this exists: notifications proved the pattern (a write applied locally + broadcast so sibling tabs of
// the same user mirror it with no extra network read). This generalises it - the resource cache adopts fresh
// rows fetched by any sibling, and auth broadcasts a lapsed session so every tab bounces to login at once.
type Handler<T> = (msg: T) => void;

const CHANNEL = "hrms";
let channel: BroadcastChannel | null = null;
const topics = new Map<string, Set<Handler<unknown>>>();

export const crossTabAvailable = typeof BroadcastChannel !== "undefined";

function ensureChannel(): BroadcastChannel | null {
  if (channel || !crossTabAvailable) return channel;
  channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (e) => {
    const env = e.data as { topic?: string; data?: unknown } | null;
    if (!env?.topic) return;
    topics.get(env.topic)?.forEach((h) => h(env.data));
  };
  return channel;
}

/** Post `data` to every OTHER tab subscribed to `topic` (never echoes to this tab). */
export function publish<T>(topic: string, data: T): void {
  ensureChannel()?.postMessage({ topic, data });
}

/** Subscribe to a topic. Returns an unsubscribe fn. Safe when BroadcastChannel is absent (never fires). */
export function subscribeTopic<T>(topic: string, handler: Handler<T>): () => void {
  ensureChannel();
  let hs = topics.get(topic);
  if (!hs) {
    hs = new Set();
    topics.set(topic, hs);
  }
  hs.add(handler as Handler<unknown>);
  return () => {
    hs!.delete(handler as Handler<unknown>);
  };
}
