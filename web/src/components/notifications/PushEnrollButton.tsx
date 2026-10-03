import { useEffect, useRef, useState } from "react";
import { BellPlus, Loader2 } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import { cn } from "@/lib/utils";
import { pushSupported, getPushState, enablePush } from "@/lib/webPush";

// Compact "turn on browser notifications" affordance for the bell dropdown, next to the All/Unread/Snoozed
// filters. Same enrolment as the banner on the Notifications page and the Settings row - this exists because
// the bell is where someone is already thinking about notifications, so it is the cheapest place to discover
// that they can arrive with no tab open.
//
// Rendered only in the one actionable state: supported by this browser, configured in this build, and
// currently OFF. Already-on needs nothing; blocked-at-the-browser-level cannot be fixed from here (that fix
// lives in the browser's site settings, and the Settings row explains it) - so both render nothing rather
// than a button that can only disappoint. No dismissal: it is one icon, and it removes itself once used.
export function PushEnrollButton() {
  const { toast } = useToast();
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    if (!pushSupported()) return;
    getPushState()
      .then((s) => { if (alive.current) setShow(s === "off"); })
      // A rejected state read is indistinguishable from "already on" once it silently hides the button.
      .catch((e) => console.error("[push] could not read the subscription state", e));
    return () => { alive.current = false; };
  }, []);

  if (!show) return null;

  async function enable() {
    setBusy(true);
    try {
      await enablePush();
      if (alive.current) setShow(false);
      toast({ title: "Browser notifications on", description: "This device now gets notified even with the app closed.", variant: "success" });
    } catch (e) {
      // Includes the user dismissing or blocking the browser's own permission prompt. Keep offering it after a
      // transient failure, but stop once they have actively blocked it.
      const state = await getPushState();
      if (alive.current && state !== "off") setShow(false);
      toast({ variant: "destructive", title: "Couldn't turn on browser notifications", description: (e as Error).message });
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  // Icon-only: the header already carries three filters and "Mark all read" inside a 22rem dropdown, and a
  // fourth text label is what tips that row into wrapping.
  return (
    <button
      onClick={() => void enable()}
      disabled={busy}
      aria-busy={busy || undefined}
      title="Turn on browser notifications for this device"
      aria-label="Turn on browser notifications for this device"
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
        busy && "pointer-events-none opacity-60",
      )}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <BellPlus className="h-4 w-4" />}
    </button>
  );
}
