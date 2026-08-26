import { useEffect, useState } from "react";
import { BellRing, X } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import { Button } from "@/components/ui/button";
import { pushSupported, getPushState, enablePush } from "@/lib/webPush";

// An invitation to turn on browser push, shown on the Notifications page itself. The toggle in
// Settings -> Notifications remains the place to manage it; this exists purely because nobody discovers a
// setting they have no reason to open. Offering it where the notifications live is the moment the value of
// "tell me even when the app is closed" is obvious.
//
// Shown only in the one state where it is actionable - supported by this browser, configured in this build,
// and currently OFF. Not shown when the user has already blocked notifications at the browser level: that is
// a decision they made, the fix lives in Chrome's site settings rather than in the app, and a banner that
// cannot do anything about it is just nagging. The Settings row explains that case.
//
// DISMISSAL IS PER-BROWSER, in localStorage, deliberately not in the synced preferences row. A push
// subscription belongs to one browser on one device, so someone who enables it on their laptop is still
// un-enrolled on their phone and should still be asked there. Syncing the dismissal would hide the prompt
// exactly where it still applies.
const DISMISS_KEY = "push-enroll-dismissed";

const readDismissed = (): boolean => {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false; // private mode / blocked storage: show the banner rather than crash
  }
};

export function PushEnrollBanner() {
  const { toast } = useToast();
  // Start hidden and reveal once the async permission/subscription check settles, so the banner never
  // flashes in front of someone who already enabled push.
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Why the prompt is not offered is worth being able to answer, because every reason looks identical from
    // the outside - an empty page. Browser support, build configuration and a previous dismissal are three
    // very different problems, and in dev it should take one glance rather than a bisect to tell them apart.
    const dev = import.meta.env.DEV;
    if (!pushSupported()) {
      if (dev) {
        console.info(
          "[push] prompt hidden - not supported here:",
          !import.meta.env.VITE_VAPID_PUBLIC_KEY
            ? "VITE_VAPID_PUBLIC_KEY is missing from this BUILD (set it in web/.env and restart the dev server; a cached bundle from before it was set looks the same)"
            : {
                serviceWorker: "serviceWorker" in navigator,
                PushManager: "PushManager" in window,
                Notification: "Notification" in window,
              }
        );
      }
      return;
    }
    if (readDismissed()) {
      if (dev) console.info(`[push] prompt hidden - dismissed on this browser. localStorage.removeItem("${DISMISS_KEY}") to bring it back.`);
      return;
    }
    let cancelled = false;
    getPushState()
      .then((s) => {
        if (cancelled) return;
        setShow(s === "off");
        if (dev && s !== "off") console.info(`[push] prompt hidden - already ${s}.`);
      })
      // Without this the promise rejects into nothing and the banner just never appears, which reads exactly
      // like "the feature is off" - the failure has to be visible to be fixable.
      .catch((e) => {
        if (!cancelled) console.error("[push] could not read the subscription state", e);
      });
    return () => { cancelled = true; };
  }, []);

  if (!show) return null;

  function dismiss() {
    setShow(false);
    try { localStorage.setItem(DISMISS_KEY, "1"); } catch { /* nothing to persist to; hidden for this session */ }
  }

  async function enable() {
    setBusy(true);
    try {
      await enablePush();
      setShow(false);
      toast({ title: "Browser notifications on", description: "This device now gets notified even with the app closed.", variant: "success" });
    } catch (e) {
      // Includes the user dismissing or blocking the browser's own permission prompt. Keep the banner up on a
      // transient failure, but stop asking once they have actively blocked it.
      const state = await getPushState();
      if (state !== "off") setShow(false);
      toast({ variant: "destructive", title: "Couldn't turn on browser notifications", description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-4 flex items-start gap-3 rounded-lg border bg-card px-3 py-2.5">
      <BellRing className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">Get notified when the app is closed</p>
        <p className="text-xs text-muted-foreground">
          Turn on browser notifications for this device. You can change it any time in Settings.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button size="sm" loading={busy} onClick={() => void enable()}>Turn on</Button>
        <Button size="sm" variant="ghost" className="h-8 w-8 p-0" aria-label="Dismiss" onClick={dismiss}>
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
