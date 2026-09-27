import { Lock } from "lucide-react";
import { useAppLock, lockNow } from "@/lib/appLock";
import { openAppLockSettings } from "@/components/lock/AppLockSheet";

// The top bar's lock. With a PIN set it locks at once; without one it opens setup, which ends in "Lock now".
export function LockButton({ mac }: { mac: boolean }) {
  const { config } = useAppLock();
  const enabled = !!config?.enabled;
  const shortcut = mac ? "⇧⌘L" : "Ctrl+Shift+L";
  const label = enabled ? `Lock (${shortcut})` : "Set up app lock";
  return (
    <button
      type="button"
      onClick={() => (enabled ? void lockNow() : openAppLockSettings({ setup: true }))}
      aria-label={enabled ? "Lock" : "Set up app lock"}
      title={label}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-card text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
    >
      <Lock className="h-4 w-4" />
    </button>
  );
}
