// Web Push sender (RFC 8030/8291/8292) over VAPID, built on WebCrypto so it runs on Workers. The heavy
// lifting (aes128gcm payload encryption + the ES256 VAPID JWT) lives in @block65/webcrypto-web-push; this
// wrapper pins the app's delivery semantics: best-effort, one result per device, dead endpoints reported as
// "gone" so the caller can prune them.
//
// The library is loaded with a DYNAMIC import, deliberately. Its isomorphic-crypto module has a top-level
// `await import("node:crypto")` fallback; a static import makes that await part of the Worker's module
// evaluation, and workerd refuses to start ("Top-level await in module is unsettled"). Importing it inside
// send() keeps the async module init on the request path, where awaiting is legal.
import type { PushSubscription } from "@block65/webcrypto-web-push";
import type { PushSender } from "../ports";

export function makePushSender(publicKey: string, privateKey: string, subject: string): PushSender {
  const vapid = { subject, publicKey, privateKey };
  return {
    async send(subscription, payload) {
      try {
        const sub = subscription as PushSubscription;
        if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys.auth) return "error";
        const { buildPushPayload } = await import("@block65/webcrypto-web-push");
        const init = await buildPushPayload(
          // A day of TTL: enough to survive a phone being offline overnight without replaying week-old noise.
          { data: payload, options: { ttl: 24 * 60 * 60 } },
          sub,
          vapid
        );
        // `redirect: "manual"`, because the endpoint is CALLER-SUPPLIED: it arrives from the browser at
        // subscription time, and any signed-in employee can register one (services/webPush.ts, which is why
        // it runs the endpoint through assertPublicHttpsUrl first). That guard judges ONE url and says so -
        // it cannot see where a 302 leads, so following redirects automatically would let a registered
        // endpoint point the Worker at a host the guard would have refused. A real push service answers
        // 201/404/410 and never redirects, so nothing legitimate is lost; an unexpected 3xx now falls through
        // to the misconfiguration branch below and is logged rather than followed.
        const res = await fetch(sub.endpoint, { ...(init as RequestInit), redirect: "manual" });
        if (res.status === 404 || res.status === 410) return "gone"; // dead subscription: expected, pruned by the caller
        if (res.ok) return "ok";
        // Anything else is a MISCONFIGURATION, not a fact about this device, and it is otherwise invisible:
        // delivery is best-effort, so nothing upstream surfaces a failure. The overwhelmingly likely cause is
        // the two halves of the VAPID keypair disagreeing - the browser subscribed against the SPA's
        // VITE_VAPID_PUBLIC_KEY while the Worker signs with a different VAPID_PUBLIC_KEY/PRIVATE_KEY - which
        // every push service rejects with 401/403 for every device on every send. Log the status so
        // `wrangler tail` can tell that apart from "nobody has enabled notifications".
        // Only the endpoint's ORIGIN is logged: the full URL is a bearer capability to push to that device.
        console.error(`[push] ${res.status} from ${new URL(sub.endpoint).origin}${res.status === 401 || res.status === 403 ? " - VAPID key mismatch? the SPA's VITE_VAPID_PUBLIC_KEY must equal the Worker's VAPID_PUBLIC_KEY secret" : ""}`);
        return "error";
      } catch (e) {
        console.error("[push] send threw", e);
        return "error";
      }
    },
  };
}
