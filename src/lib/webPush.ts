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
        const res = await fetch(sub.endpoint, init as RequestInit);
        if (res.status === 404 || res.status === 410) return "gone";
        return res.ok ? "ok" : "error";
      } catch {
        return "error";
      }
    },
  };
}
