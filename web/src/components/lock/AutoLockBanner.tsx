import * as React from "react";
import { Lock } from "lucide-react";
import { useAppLock, markActive, lockNow } from "@/lib/appLock";
import { Button } from "@/components/ui/button";

// The last 30 seconds before an auto-lock (lib/appLock.ts): says so, with a way to stay and a way to go now.
// Any keypress or click anywhere also counts as staying.
export function AutoLockBanner() {
  const { warnAt } = useAppLock();
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!warnAt) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [warnAt]);
  if (!warnAt) return null;
  const secs = Math.max(0, Math.ceil((warnAt - now) / 1000));
  return (
    <div
      role="alert"
      className="fixed inset-x-0 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-[60] mx-auto flex w-[calc(100%-2rem)] max-w-md items-center gap-3 rounded-xl border bg-card px-4 py-3 shadow-xl"
    >
      <Lock className="h-5 w-5 shrink-0 text-warning" />
      <p className="min-w-0 flex-1 text-sm">
        Locking in <span className="font-semibold tabular-nums">{secs}s</span>
      </p>
      <Button size="sm" variant="outline" onClick={() => markActive(true)}>
        Stay unlocked
      </Button>
      <Button size="sm" onClick={() => void lockNow()}>
        Lock now
      </Button>
    </div>
  );
}
