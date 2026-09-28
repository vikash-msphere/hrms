import * as React from "react";
import { Clock, EyeOff, KeyRound, Lock, LockKeyhole, MonitorSmartphone, ShieldCheck, ShieldOff, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { APP_NAME } from "@/lib/brand";
import { useAppLock, setPin, removePin, setIdleMinutes, lockNow, lockEverywhere, fetchLockStatus, type LockCallError } from "@/lib/appLock";
import { PinPad } from "@/components/lock/PinPad";
import { Badge } from "@/components/ui/badge";
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

// `page` (the profile's Privacy tab) names the panel "App lock" and, on a computer screen, lays the header and
// every setting out as one two-column form. `sheet` is for a host that already titles it and is too narrow for
// that form, so its text wraps and each control sits under or beside its own label.
export function AppLockSettings({ onDone, startSetup, variant = "page" }: { onDone?: () => void; startSetup?: boolean; variant?: "page" | "sheet" }) {
  return (
    <WideContext.Provider value={variant === "page"}>
      <AppLockPanel onDone={onDone} startSetup={startSetup} />
    </WideContext.Provider>
  );
}

const WideContext = React.createContext(false);

function AppLockPanel({ onDone, startSetup }: { onDone?: () => void; startSetup?: boolean }) {
  const wide = React.useContext(WideContext);
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

  // The status header sits above every mode, so the on/off state stays in view through a PIN flow; its
  // action (turn on / turn off) only shows on the overview, in the same column as the settings' controls.
  const header = (
    <StatusHeader
      enabled={enabled}
      action={
        mode.kind !== "view" ? null : enabled ? (
          <Button variant="outline" className={cn("text-destructive hover:bg-destructive/10 hover:text-destructive", wide && WIDE_CONTROL)} onClick={() => go({ kind: "off-current" })}>
            <ShieldOff className="h-4 w-4" /> Turn off
          </Button>
        ) : (
          <Button className={cn(wide && WIDE_CONTROL)} onClick={() => go({ kind: "setup-length" })}>
            <LockKeyhole className="h-4 w-4" /> Turn on
          </Button>
        )
      }
    />
  );

  if (step) {
    const length = mode.kind === "change-new" || mode.kind === "change-confirm" ? changeLength : pinLength;
    const progress = STEP_OF[mode.kind];
    return (
      <div>
        {header}
        <div className="mt-6 flex flex-col items-center gap-2 text-center">
          {progress && <StepDots at={progress} />}
          <h4 className="text-base font-semibold">{step.title}</h4>
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
      </div>
    );
  }

  if (mode.kind === "setup-length") {
    return (
      <div>
        {header}
        <div className="mt-6 flex flex-col items-center gap-2 text-center">
          <StepDots at={1} />
          <h4 className="text-base font-semibold">How long should your PIN be?</h4>
          <p className="max-w-xs text-sm text-muted-foreground">If you ever forget it, an admin can reset it.</p>
          <div className="mt-3 grid w-full max-w-sm grid-cols-2 gap-2">
            {([6, 4] as const).map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => go({ kind: "setup-enter", length: n })}
                className="flex flex-col items-center gap-2 rounded-lg border bg-card px-3 py-4 transition-colors hover:border-primary hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span aria-hidden className="flex gap-1">
                  {Array.from({ length: n }, (_, i) => <span key={i} className="h-2 w-2 rounded-full bg-foreground/70" />)}
                </span>
                <span className="text-sm font-semibold">{n} digits</span>
                <span className="text-xs text-muted-foreground">{n === 6 ? "Recommended" : "Quicker to type"}</span>
              </button>
            ))}
          </div>
          <Button variant="ghost" size="sm" className="mt-2" onClick={() => go({ kind: "view" })}>
            Not now
          </Button>
        </div>
      </div>
    );
  }

  if (mode.kind === "setup-idle") {
    return (
      <div>
        {header}
        <div className="mt-5">
          <p className="text-sm font-medium text-success">Your PIN is set.</p>
          <p className="text-sm text-muted-foreground">One last choice: when should {APP_NAME} lock by itself?</p>
        </div>
        <Form className="mt-2">
          <SettingRow label="Lock automatically" hint={IDLE_HINT}>
            <IdleSelect />
          </SettingRow>
        </Form>
        <div className="flex flex-wrap gap-2 pt-4">
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
      <div>
        <Form>{header}</Form>
        <ul className="mt-4">
          <Fact icon={Clock} title="Locks when you step away">After the idle time you choose, or whenever you lock it yourself.</Fact>
          <Fact icon={EyeOff} title="Nothing to read while locked">This browser keeps nothing readable, and the server refuses every request until the PIN is entered.</Fact>
          <Fact icon={KeyRound} title="Yours alone">You'll also enter it after signing in. Nobody can see your PIN; if you forget it, an admin can reset it.</Fact>
        </ul>
      </div>
    );
  }
  const pinLengthLabel = `${config?.pinLength ?? 6}-digit PIN.`;
  return (
    <Form>
      {header}
      <div className={cn("mt-3", wide && "lg:contents")}>
        <SettingRow label="Lock automatically" hint={IDLE_HINT}>
          <IdleSelect />
        </SettingRow>
        <SettingRow
          label="PIN"
          hint={
            lastFailed ? (
              <>
                {pinLengthLabel}{" "}
                <span className="inline-flex items-center gap-1 text-warning">
                  <TriangleAlert className="h-3 w-3" /> Wrong PIN entered {new Date(lastFailed).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}.
                </span>
              </>
            ) : (
              `${pinLengthLabel} No wrong PINs entered.`
            )
          }
        >
          <Button variant="outline" className={CONTROL} onClick={() => { setChangeLength((config?.pinLength as 4 | 6) ?? 6); go({ kind: "change-current" }); }}>
            Change PIN
          </Button>
        </SettingRow>
        <SettingRow label="Lock all my devices" hint={`Every browser signed in to ${APP_NAME} as you locks, this one included.`}>
          <Button
            variant="outline"
            className={CONTROL}
            onClick={async () => {
              const ok = await confirm({
                title: "Lock all your devices?",
                description: `Every browser signed in to ${APP_NAME} as you locks, this one included, and needs your PIN to open again.`,
                confirmLabel: "Lock all devices",
              });
              if (ok) await lockEverywhere();
            }}
          >
            <MonitorSmartphone className="h-4 w-4" /> Lock everywhere
          </Button>
        </SettingRow>
      </div>
    </Form>
  );
}

// Which step of three each PIN flow screen is; turning the lock off is a single step and shows none.
const STEP_OF: Partial<Record<Mode["kind"], 1 | 2 | 3>> = {
  "setup-enter": 2,
  "setup-confirm": 3,
  "change-current": 1,
  "change-new": 2,
  "change-confirm": 3,
};

const IDLE_HINT = `Counted from your last keypress, click or tap in any ${APP_NAME} tab.`;

// One width for every control in the right-hand column, so the rows line up like a form.
const CONTROL = "w-full sm:w-52";
const WIDE_CONTROL = "lg:w-52";

// On a computer screen the wide layout is ONE grid: the header and each setting row dissolve into it
// (`lg:contents`), so every label shares the first column - as wide as its longest line, which never wraps -
// and every control, the header's turn on / turn off included, starts on the same line in the second.
function Form({ className, children }: { className?: string; children: React.ReactNode }) {
  const wide = React.useContext(WideContext);
  return <div className={cn(wide && "lg:grid lg:grid-cols-[max-content_auto] lg:items-center lg:justify-start lg:gap-x-16 lg:gap-y-5", className)}>{children}</div>;
}

function StatusHeader({ enabled, action }: { enabled: boolean; action: React.ReactNode }) {
  const wide = React.useContext(WideContext);
  return (
    <div className={cn("flex items-start gap-3", wide && "lg:contents")}>
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg", enabled ? "bg-success/15 text-success" : "bg-muted text-muted-foreground")}>
          {enabled ? <ShieldCheck className="h-5 w-5" /> : <ShieldOff className="h-5 w-5" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {wide && <h3 className="text-sm font-semibold">App lock</h3>}
            <Badge variant={enabled ? "success" : "muted"}>
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
              {enabled ? "On" : "Off"}
            </Badge>
          </div>
          <p className={cn("mt-0.5 text-sm text-muted-foreground", wide && "lg:whitespace-nowrap")}>
            {enabled ? `Your PIN is needed to reopen ${APP_NAME} after you've been away.` : `Lock ${APP_NAME} with a PIN when you step away.`}
          </p>
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

// Below the wide layout the label column is capped rather than stretched, so each control sits beside its own
// label instead of across the card from it.
function SettingRow({ label, hint, children }: { label: string; hint: React.ReactNode; children: React.ReactNode }) {
  const wide = React.useContext(WideContext);
  return (
    <div className={cn("flex flex-col gap-3 py-3 last:pb-0 sm:grid sm:grid-cols-[minmax(0,20rem)_auto] sm:items-center sm:justify-start sm:gap-8", wide && "lg:contents")}>
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium">{label}</p>
        <p className={cn("text-pretty text-xs text-muted-foreground", wide && "lg:whitespace-nowrap")}>{hint}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Fact({ icon: Icon, title, children }: { icon: React.ComponentType<{ className?: string }>; title: string; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3 py-2 last:pb-0">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-pretty text-xs text-muted-foreground">{children}</p>
      </div>
    </li>
  );
}

function StepDots({ at }: { at: 1 | 2 | 3 }) {
  return (
    <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
      <span aria-hidden className="flex gap-1">
        {[1, 2, 3].map((n) => <span key={n} className={cn("h-1.5 rounded-full transition-all", n === at ? "w-4 bg-primary" : n < at ? "w-1.5 bg-primary/60" : "w-1.5 bg-muted-foreground/30")} />)}
      </span>
      Step {at} of 3
    </div>
  );
}

function IdleSelect() {
  const { config } = useAppLock();
  const { toast } = useToast();
  const [saving, setSaving] = React.useState(false);
  return (
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
      <SelectTrigger className={CONTROL} aria-label="Lock automatically">
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
  );
}
