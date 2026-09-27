import * as React from "react";
import { Lock, LockKeyhole, MonitorSmartphone, ShieldCheck, ShieldOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { APP_NAME } from "@/lib/brand";
import { useAppLock, setPin, removePin, setIdleMinutes, lockNow, lockEverywhere, fetchLockStatus, type LockCallError } from "@/lib/appLock";
import { PinPad } from "@/components/lock/PinPad";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";
import { useMedia } from "@/hooks/useMedia";

// The person's own app lock settings (app-lock-plan.md): turn it on, change the PIN, choose when it locks by
// itself, lock every device, turn it off. Everything here is theirs alone - an admin can only RESET a PIN
// (Settings, Users), never see or set one.

export const IDLE_OPTIONS: { value: number; label: string }[] = [
  { value: 5, label: "After 5 minutes" },
  { value: 15, label: "After 15 minutes" },
  { value: 30, label: "After 30 minutes" },
  { value: 60, label: "After 1 hour" },
  { value: 0, label: "Only when I lock it" },
];

type Mode =
  | { kind: "view" }
  | { kind: "setup-length" }
  | { kind: "setup-enter"; length: 4 | 6 }
  | { kind: "setup-confirm"; length: 4 | 6; first: string }
  | { kind: "setup-idle" }
  | { kind: "change-current" }
  | { kind: "change-new"; current: string }
  | { kind: "change-confirm"; current: string; first: string }
  | { kind: "off-current" };

export function AppLockSettings({ onDone, startSetup }: { onDone?: () => void; startSetup?: boolean }) {
  const { config } = useAppLock();
  const enabled = !!config?.enabled;
  const [mode, setMode] = React.useState<Mode>(() => (startSetup && !enabled ? { kind: "setup-length" } : { kind: "view" }));
  const [pin, setPinValue] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [shake, setShake] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [lastFailed, setLastFailed] = React.useState<string | null>(null);
  // The new PIN's length during a change, which may differ from the current one.
  const [changeLength, setChangeLength] = React.useState<4 | 6>(6);
  const confirm = useConfirm();
  const { toast } = useToast();
  const touch = useMedia("(pointer: coarse)");

  React.useEffect(() => {
    if (!enabled) return;
    void fetchLockStatus().then((s) => {
      if (s && s !== "signed-out") setLastFailed(s.last_failed_at);
    });
  }, [enabled]);

  const go = (m: Mode) => {
    setMode(m);
    setPinValue("");
    setError(null);
  };
  const fail = (e: unknown) => {
    setError((e as LockCallError).message ?? "Something went wrong. Try again.");
    setShake((n) => n + 1);
    setPinValue("");
  };

  async function run(fn: () => Promise<void>, after: () => void) {
    setBusy(true);
    try {
      await fn();
      after();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  // ---- The PIN steps ----
  const pinLength = mode.kind === "setup-enter" || mode.kind === "setup-confirm" ? mode.length : (config?.pinLength ?? 6);
  const step = (() => {
    switch (mode.kind) {
      case "setup-enter":
        return { title: `Choose a ${mode.length}-digit PIN`, hint: "Avoid birthdays, repeated digits and runs like 1234.", complete: (v: string) => go({ kind: "setup-confirm", length: mode.length, first: v }) };
      case "setup-confirm":
        return {
          title: "Enter it again",
          hint: "To make sure it's the one you meant.",
          complete: (v: string) => {
            if (v !== mode.first) {
              setError("Those didn't match. Choose your PIN again.");
              setShake((n) => n + 1);
              setMode({ kind: "setup-enter", length: mode.length });
              setPinValue("");
              return;
            }
            void run(() => setPin(v), () => go({ kind: "setup-idle" }));
          },
        };
      case "change-current":
        return { title: "Enter your current PIN", hint: "", complete: (v: string) => go({ kind: "change-new", current: v }) };
      case "change-new":
        return { title: "Choose a new PIN", hint: "The same length as before, or change it below.", complete: (v: string) => go({ kind: "change-confirm", current: mode.current, first: v }) };
      case "change-confirm":
        return {
          title: "Enter the new PIN again",
          hint: "Your other devices will need the new PIN.",
          complete: (v: string) => {
            if (v !== mode.first) {
              setError("Those didn't match. Start again.");
              setShake((n) => n + 1);
              go({ kind: "change-current" });
              return;
            }
            void run(
              () => setPin(v, mode.current),
              () => {
                toast({ title: "PIN changed", description: "Your other devices are locked until the new PIN is entered.", variant: "success" });
                go({ kind: "view" });
              },
            );
          },
        };
      case "off-current":
        return {
          title: "Enter your PIN to turn the lock off",
          hint: "",
          complete: (v: string) =>
            void run(
              () => removePin(v),
              () => {
                toast({ title: "App lock turned off" });
                go({ kind: "view" });
              },
            ),
        };
      default:
        return null;
    }
  })();

  if (step) {
    const length = mode.kind === "change-new" || mode.kind === "change-confirm" ? changeLength : pinLength;
    return (
      <div className="flex flex-col items-center gap-2 py-4 text-center">
        <LockKeyhole className="mb-1 h-8 w-8 text-primary" />
        <h3 className="text-base font-semibold">{step.title}</h3>
        {step.hint && <p className="max-w-xs text-sm text-muted-foreground">{step.hint}</p>}
        <div className="mt-4">
          <PinPad key={mode.kind} length={length} value={pin} onChange={(v) => { setPinValue(v); setError(null); }} onComplete={step.complete} label={step.title} disabled={busy} shake={shake} keypad={touch} autoFocus />
        </div>
        <p role="status" aria-live="polite" className="min-h-[1.25rem] text-sm text-destructive">{error}</p>
        {mode.kind === "change-new" && (
          <button type="button" className="text-xs text-muted-foreground underline-offset-4 hover:underline" onClick={() => setChangeLength((l) => (l === 6 ? 4 : 6))}>
            Use {changeLength === 6 ? "4" : "6"} digits instead
          </button>
        )}
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => go({ kind: "view" })} disabled={busy}>
          Cancel
        </Button>
      </div>
    );
  }

  if (mode.kind === "setup-length") {
    return (
      <div className="space-y-5 py-2">
        <Intro />
        <div>
          <p className="mb-2 text-sm font-medium">PIN length</p>
          <div className="grid grid-cols-2 gap-2">
            {([6, 4] as const).map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => go({ kind: "setup-enter", length: n })}
                className="rounded-lg border bg-card p-3 text-left transition-colors hover:border-primary hover:bg-accent"
              >
                <span className="block text-sm font-semibold">{n} digits</span>
                <span className="block text-xs text-muted-foreground">{n === 6 ? "Recommended" : "Quicker to type"}</span>
              </button>
            ))}
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={() => go({ kind: "view" })}>
          Not now
        </Button>
      </div>
    );
  }

  if (mode.kind === "setup-idle") {
    return (
      <div className="space-y-5 py-2">
        <div className="flex items-start gap-3 rounded-lg border border-success/40 bg-success/10 p-3 text-sm">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-success" />
          <span>App lock is on. You'll enter this PIN when you come back and after signing in.</span>
        </div>
        <IdleChoice />
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void lockNow()}>
            <Lock className="h-4 w-4" /> Lock now
          </Button>
          <Button variant="outline" onClick={() => { go({ kind: "view" }); onDone?.(); }}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  // ---- The overview ----
  if (!enabled) {
    return (
      <div className="space-y-4 py-2">
        <Intro />
        <Button onClick={() => go({ kind: "setup-length" })}>
          <LockKeyhole className="h-4 w-4" /> Turn on app lock
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-5 py-2">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-success/15 text-success">
          <ShieldCheck className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold">App lock is on</p>
          <p className="text-sm text-muted-foreground">
            {config?.pinLength}-digit PIN.{" "}
            {lastFailed ? `Last wrong PIN ${new Date(lastFailed).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}.` : "No wrong PINs entered."}
          </p>
        </div>
      </div>
      <IdleChoice />
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => { setChangeLength((config?.pinLength as 4 | 6) ?? 6); go({ kind: "change-current" }); }}>
          Change PIN
        </Button>
        <Button
          variant="outline"
          onClick={async () => {
            const ok = await confirm({
              title: "Lock all your devices?",
              description: `Every browser signed in to ${APP_NAME} as you locks, this one included, and needs your PIN to open again.`,
              confirmLabel: "Lock all devices",
            });
            if (ok) await lockEverywhere();
          }}
        >
          <MonitorSmartphone className="h-4 w-4" /> Lock all my devices
        </Button>
        <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => go({ kind: "off-current" })}>
          <ShieldOff className="h-4 w-4" /> Turn off
        </Button>
      </div>
    </div>
  );
}

function Intro() {
  return (
    <div className="space-y-2 text-sm text-muted-foreground">
      <p>
        Lock {APP_NAME} with a PIN when you step away. While it's locked, this browser keeps nothing you could read,
        and the server refuses every request until the PIN is entered.
      </p>
      <p>You'll also enter it after signing in. If you forget it, an admin can reset it.</p>
    </div>
  );
}

function IdleChoice() {
  const { config } = useAppLock();
  const { toast } = useToast();
  const [saving, setSaving] = React.useState(false);
  return (
    <div>
      <p className="mb-1.5 text-sm font-medium">Lock automatically</p>
      <Select
        value={String(config?.idleMinutes ?? 15)}
        disabled={saving}
        onValueChange={async (v) => {
          setSaving(true);
          try {
            await setIdleMinutes(Number(v));
          } catch (e) {
            toast({ title: "Couldn't save that", description: (e as LockCallError).message, variant: "destructive" });
          } finally {
            setSaving(false);
          }
        }}
      >
        <SelectTrigger className={cn("w-full sm:w-64")} aria-label="Lock automatically">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {IDLE_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={String(o.value)}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="mt-1.5 text-xs text-muted-foreground">Counted from your last keypress, click or tap in any {APP_NAME} tab.</p>
    </div>
  );
}
