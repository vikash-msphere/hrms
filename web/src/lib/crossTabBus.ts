// Generic same-origin cross-tab message bus over a single BroadcastChannel, multiplexed by topic so every
// feature shares ONE underlying connection. BroadcastChannel never delivers a message back to the tab that
// sent it, so handlers can apply remote messages without looping. Best-effort: when BroadcastChannel is
// absent (old browsers, some webviews) publish/subscribe become no-ops and callers fall back to their
// existing focus-refetch / TTL behaviour.
//
// Why this exists: notifications proved the pattern (a write applied locally + broadcast so sibling tabs of
// the same user mirror it with no extra network read). This generalises it - the resource cache adopts fresh
// rows fetched by any sibling, and auth broadcasts a lapsed session so every tab bounces to login at once.
//
// EVERY MESSAGE IS STAMPED WITH THE IDENTITY THAT SENT IT, and a tab applies only its own identity's.
//
// A BroadcastChannel is per ORIGIN, and this one is a single channel for the whole app - so "sibling tabs of
// the same user" was an assumption, not a fact. It is false during a "view as" simulation: that tab answers
// as the SUBJECT, every row it fetches carries the subject's redactions and access hints, and the payload
// topics here hand rows and preferences straight into whatever the receiving tab holds (the row cache even
// persists what it receives). That is precisely what the disk namespace - `<email>~<subject>`, see App.tsx -
// exists to keep apart, and the bus went around it. Both directions are wrong: the admin's table quietly
// showing the subject's narrowed rows, and the simulation showing rows the subject cannot see.
//
// Identity is known a beat after boot, so a message is dropped rather than guessed at whenever EITHER side
// does not know one yet; the receiving tab then reads what it needs itself, which is the pre-bus behaviour.
import { storedIdentity } from "@/lib/clientStore";

type Handler<T> = (msg: T) => void;
type Envelope = { topic?: string; data?: unknown; who?: string | null };

const CHANNEL = "hrms";
/** `who` for a message every tab must hear whoever it is answering as - a dead session, and nothing else. */
const EVERYONE = "*";
let channel: BroadcastChannel | null = null;
const topics = new Map<string, Set<Handler<unknown>>>();

export const crossTabAvailable = typeof BroadcastChannel !== "undefined";

/**
 * May a message stamped `who` be applied by a tab answering as `me`?
 *
 * AN UNKNOWN IDENTITY MATCHES NOTHING, on either side. This was `(env.who ?? null) !== storedIdentity()`,
 * which let a message through whenever BOTH were null - two tabs that each boot before `/users/me` lands are
 * both "null", so they delivered to each other, and one of them may be about to resolve as a "view as"
 * simulation. A narrow window, and a pre-identity tab has little to corrupt; but it was the one comparison
 * here that was not fail-closed, and "unknown equals unknown" is not what the identity stamp means. A dropped
 * message costs a refetch - the receiving tab reads what it needs itself, which is the pre-bus behaviour.
 *
 * Exported so the rule is testable without a BroadcastChannel, which the test runtime does not have.
 */
export function deliverable(who: string | null, me: string | null): boolean {
  if (who === EVERYONE) return true; // a dead session, and nothing else - see publishToAll
  return !!me && !!who && who === me;
}

function ensureChannel(): BroadcastChannel | null {
  if (channel || !crossTabAvailable) return channel;
  channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (e) => {
    const env = e.data as Envelope | null;
    if (!env?.topic) return;
    if (!deliverable(env.who ?? null, storedIdentity())) return;
    topics.get(env.topic)?.forEach((h) => h(env.data));
  };
  return channel;
}

/** Post `data` to every OTHER tab answering as the SAME identity (never echoes to this tab). */
export function publish<T>(topic: string, data: T): void {
  ensureChannel()?.postMessage({ topic, data, who: storedIdentity() } satisfies Envelope);
}

/**
 * Post `data` to every other tab REGARDLESS of who it is answering as.
 *
 * For facts about the browser rather than about a caller's data: the session behind all of them has died, so
 * an admin's own tab and the simulation running beside it both have to bounce to the login screen.
 */
export function publishToAll<T>(topic: string, data: T): void {
  ensureChannel()?.postMessage({ topic, data, who: EVERYONE } satisfies Envelope);
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
