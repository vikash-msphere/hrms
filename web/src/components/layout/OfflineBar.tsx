import { useEffect, useState } from "react";
import { CloudOff, RefreshCw } from "lucide-react";
import { refetchMounted } from "@/lib/resourceStore";
import { cn } from "@/lib/utils";

// Connectivity, said out loud. Until now losing signal was silent: every read failed, each page drew its own
// "couldn't load this data" panel, and nothing anywhere said the reason was the network or that it had come
// back. That is a desktop-shaped assumption - on a phone, going through a tunnel is ordinary.
//
// Two states, one bar: OFFLINE stays up for as long as it lasts, and the moment the connection returns it
// flips to a brief "back online" while it re-reads what is on screen, then leaves. The re-read is the point:
// without it the user is looking at a page of failed panels over a working connection.
//
// `navigator.onLine` is only ever trustworthy in the negative - false means definitely no network, true means
// only that an interface is up. So the bar is raised on `false` and cleared by the `online` event, and every
// request keeps its own error handling (api.ts) for the case where the browser thinks it is connected and the
// server is unreachable anyway.
export function OfflineBar() {
  const [offline, setOffline] = useState(() => typeof navigator !== "undefined" && navigator.onLine === false);
  const [recovering, setRecovering] = useState(false);

  useEffect(() => {
    const goOffline = () => { setOffline(true); setRecovering(false); };
    const goOnline = () => {
      setOffline(false);
      setRecovering(true);
      // Catch the failures rather than let them reject: whatever cannot be re-read still renders its own
      // error, and the bar's job is only to stop showing "reconnecting" once the attempt is over.
      void refetchMounted().catch(() => {}).then(() => setRecovering(false));
    };
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
    };
  }, []);

  if (!offline && !recovering) return null;

  return (
    // Docked to the top, under the app bar rather than over it, so it never covers the way back. `role=status`
    // announces it once without stealing focus - a connectivity change is information, not an interruption.
    <div
      role="status"
      aria-live="polite"
      className={cn(
        // Sticks directly beneath the app bar, which is `h-14` and grows by the status-bar inset when the app
        // is installed - so the offset has to grow with it, or the bar slides under the clock.
        // Same z band as the app bar, not the page's: a page's own pinned bar clears 4rem, which overlaps this
        // one's 28px by a sliver, and of the two "you are offline" is the one that must not be covered.
        "sticky top-14 z-30 flex items-center justify-center gap-2 px-4 py-1.5 text-xs font-medium standalone:top-[calc(3.5rem+env(safe-area-inset-top))]",
        offline ? "bg-warning/15 text-warning" : "bg-success/15 text-success"
      )}
    >
      {offline ? (
        <>
          <CloudOff className="h-3.5 w-3.5 shrink-0" />
          <span>You're offline - showing what was already loaded</span>
        </>
      ) : (
        <>
          <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin" />
          <span>Back online - refreshing</span>
        </>
      )}
    </div>
  );
}
