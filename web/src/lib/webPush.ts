// Browser-push enrolment for this device. The server half (VAPID keys + delivery) is optional per
// deployment; the SPA half is gated on VITE_VAPID_PUBLIC_KEY being baked into the build. Subscriptions are
// stored server-side in the caller's own preferences row (key "push_subscriptions"), so the worker can reach
// this user's browsers when a notification lands while no tab is open.
import { updatePref } from "@/lib/prefs";

const VAPID_PUBLIC = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
const PREF_KEY = "push_subscriptions";
const MAX_DEVICES = 5;

type StoredSub = { endpoint: string; keys?: { p256dh: string; auth: string } };

export function pushSupported(): boolean {
  return !!VAPID_PUBLIC && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export type PushState = "unsupported" | "denied" | "off" | "on";

export async function getPushState(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await pushRegistration();
  const sub = reg && (await reg.pushManager.getSubscription());
  return sub ? "on" : "off";
}

/**
 * The push worker's own registration.
 *
 * `getRegistration(url)` takes a CLIENT URL and answers with whatever registration CONTROLS it - not the
 * registration whose script is at that path. `getRegistration("/push-sw.js")` therefore resolves to whatever
 * is registered at scope `/`, which happens to be the push worker today and would silently become a different
 * worker the moment another one is registered at the root. Match on the script URL instead.
 */
async function pushRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  const regs = await navigator.serviceWorker.getRegistrations();
  return regs.find((r) => (r.active ?? r.installing ?? r.waiting)?.scriptURL.endsWith("/push-sw.js"));
}

// applicationServerKey wants raw P-256 bytes; VAPID keys travel base64url.
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// The row is a LIST several devices append to, so it is changed through `updatePref`: a fresh read rather than
// the page-life snapshot, and a write guarded on that read's version. A stale or failed read written back here
// deregistered every other device, which then stopped receiving pushes with nothing anywhere saying so.
type SubsPref = { subs?: StoredSub[] };
const subsOf = (v: SubsPref | undefined): StoredSub[] => (Array.isArray(v?.subs) ? v.subs : []); // absent: nothing registered yet

/** Ask permission, subscribe this browser, and register the subscription server-side. Throws with a
 *  user-showable message when permission is refused. */
export async function enablePush(): Promise<void> {
  if (!pushSupported()) throw new Error("This browser doesn't support push notifications");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notifications are blocked for this site in your browser settings");
  const reg = await navigator.serviceWorker.register("/push-sw.js");
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC!) as BufferSource,
    }));
  const json = sub.toJSON() as StoredSub;
  // Newest device last; cap total so one user can't accumulate unbounded dead endpoints.
  await updatePref<SubsPref>(PREF_KEY, (v) => ({ subs: [...subsOf(v).filter((s) => s.endpoint !== json.endpoint), json].slice(-MAX_DEVICES) }));
}

/** Unsubscribe this browser and drop it from the server-side registry. */
export async function disablePush(): Promise<void> {
  const reg = await pushRegistration();
  const sub = reg && (await reg.pushManager.getSubscription());
  const endpoint = sub?.endpoint;
  if (sub) await sub.unsubscribe();
  if (endpoint) await updatePref<SubsPref>(PREF_KEY, (v) => ({ subs: subsOf(v).filter((s) => s.endpoint !== endpoint) }));
}
