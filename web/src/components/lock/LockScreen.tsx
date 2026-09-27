import * as React from "react";
import { Lock, LockOpen, LogOut, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { APP_NAME } from "@/lib/brand";
import { loginUrl } from "@/api";
import { useAppLock, settleLockScreen, unlock, enterApp, fmtWait } from "@/lib/appLock";
import { PinPad } from "@/components/lock/PinPad";
import { Button } from "@/components/ui/button";

// The whole page while this browser is locked (lib/appLock.ts). It is rendered INSTEAD of the app - no shell,
// no providers, no data - and it shows nothing of the app either: a picture of the app, even blurred, would be
// the app. What it has is the time, the person's first name, and a way in.

function useNow(stepMs: number) {
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const t = setInterval(() => setNow(new Date()), stepMs);
    return () => clearInterval(t);
  }, [stepMs]);
  return now;
}

type Phase =
  | { kind: "ready" }
  | { kind: "checking" }
  | { kind: "wrong"; attemptsLeft: number }
  | { kind: "wait"; until: number }
  | { kind: "opening" }
  | { kind: "signed-out" }
  | { kind: "offline" }
  | { kind: "failed" };

export function LockScreen() {
  const { hint } = useAppLock();
  const [pin, setPin] = React.useState("");
  const [phase, setPhase] = React.useState<Phase>({ kind: "ready" });
  const [shake, setShake] = React.useState(0);
  const [helpOpen, setHelpOpen] = React.useState(false);
  const now = useNow(1_000);
  const length = hint?.pinLength ?? 6;

  React.useEffect(() => {
    document.title = `Locked · ${APP_NAME}`;
    void settleLockScreen().then((s) => {
      if (s === "signed-out") setPhase({ kind: "signed-out" });
      else if (s?.retry_after) setPhase({ kind: "wait", until: Date.now() + s.retry_after * 1000 });
    });
  }, []);

  // The wait counts down on its own, and hands the pad back when it is over.
  const waitLeft = phase.kind === "wait" ? Math.max(0, Math.ceil((phase.until - now.getTime()) / 1000)) : 0;
  React.useEffect(() => {
    if (phase.kind === "wait" && waitLeft === 0) setPhase({ kind: "ready" });
  }, [phase.kind, waitLeft]);

  async function submit(value: string) {
    setPhase({ kind: "checking" });
    const r = await unlock(value);
    if (r.ok) {
      setPhase({ kind: "opening" });
      setTimeout(enterApp, 350);
      return;
    }
    setPin("");
    if (r.kind === "wrong") {
      setShake((n) => n + 1);
      navigator.vibrate?.([60, 40, 60]);
      setPhase(r.retryAfter ? { kind: "wait", until: Date.now() + r.retryAfter * 1000 } : { kind: "wrong", attemptsLeft: r.attemptsLeft });
    } else if (r.kind === "wait") setPhase({ kind: "wait", until: Date.now() + r.retryAfter * 1000 });
    else setPhase({ kind: r.kind });
  }

  async function signOut() {
    try {
      const res = await fetch("/auth/logout", { method: "POST", headers: { "X-Requested-By": "hrms-spa" } });
      const { signin_url } = (await res.json()) as { signin_url?: string };
      window.location.href = signin_url || "/";
    } catch {
      window.location.href = "/";
    }
  }

  const busy = phase.kind === "checking" || phase.kind === "opening" || phase.kind === "wait" || phase.kind === "signed-out";
  const initials = (hint?.firstName ?? "").trim().slice(0, 1).toUpperCase();
  const message =
    phase.kind === "wrong"
      ? phase.attemptsLeft > 0
        ? `Wrong PIN. ${phase.attemptsLeft} ${phase.attemptsLeft === 1 ? "try" : "tries"} left before a wait.`
        : "Wrong PIN."
      : phase.kind === "wait"
        ? `Too many wrong PINs. Try again in ${fmtWait(waitLeft)}.`
        : phase.kind === "offline"
          ? "You're offline. Unlocking needs a connection."
          : phase.kind === "failed"
            ? "Couldn't check your PIN. Try again."
            : phase.kind === "signed-out"
              ? "Your session has ended. Sign in again, then enter your PIN."
              : "";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="lock-title"
      className="relative flex min-h-[100dvh] flex-col items-center justify-between overflow-hidden bg-background px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-[calc(2.5rem+env(safe-area-inset-top))] text-foreground"
    >
      {/* Brand light, not a picture of the app. */}
      <div aria-hidden className="lock-aurora pointer-events-none absolute inset-0" />

      <div className="relative flex flex-col items-center text-center">
        <p className="text-6xl font-semibold tabular-nums tracking-tight sm:text-7xl">
          {now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
        </p>
        <p className="mt-1 text-sm text-muted-foreground sm:text-base">{now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}</p>
      </div>

      <div className="relative flex w-full max-w-sm flex-col items-center">
        <div className={cn("mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary text-2xl font-semibold text-primary-foreground shadow-lg transition-transform", phase.kind === "opening" && "scale-110")}>
          {phase.kind === "opening" ? <LockOpen className="h-7 w-7" /> : initials || <Lock className="h-7 w-7" />}
        </div>
        <h1 id="lock-title" className="text-lg font-semibold">
          {phase.kind === "opening" ? "Unlocked" : hint?.firstName ? `Welcome back, ${hint.firstName}` : `${APP_NAME} is locked`}
        </h1>
        <p className="mb-7 mt-1 text-sm text-muted-foreground">
          {phase.kind === "opening" ? "Opening…" : `Enter your ${length}-digit PIN to unlock`}
        </p>

        <PinPad
          length={length}
          value={pin}
          onChange={(v) => {
            setPin(v);
            if (phase.kind === "wrong" || phase.kind === "failed" || phase.kind === "offline") setPhase({ kind: "ready" });
          }}
          onComplete={(v) => void submit(v)}
          label={`Enter your ${length}-digit PIN`}
          disabled={busy}
          shake={shake}
          keypad
          autoFocus
          tone={phase.kind === "opening" ? "success" : phase.kind === "wrong" ? "error" : "default"}
        />

        <p role="status" aria-live="polite" className={cn("mt-5 min-h-[1.25rem] text-sm", phase.kind === "offline" ? "text-muted-foreground" : "text-destructive")}>
          {phase.kind === "offline" && <WifiOff className="mr-1 inline h-4 w-4" />}
          {message}
        </p>
        {phase.kind === "signed-out" && (
          <Button className="mt-2" onClick={() => (window.location.href = loginUrl())}>
            Sign in
          </Button>
        )}
      </div>

      <div className="relative flex w-full max-w-sm flex-col items-center gap-2 text-sm">
        {helpOpen && (
          <p className="rounded-lg border bg-card px-4 py-3 text-center text-muted-foreground shadow-sm">
            An HR or IT admin can reset your PIN from Settings, Users. You'll be signed out everywhere and can set a new one after you sign in.
          </p>
        )}
        <div className="flex items-center gap-4">
          <button type="button" className="rounded px-2 py-1 text-muted-foreground hover:text-foreground" onClick={() => setHelpOpen((o) => !o)}>
            Forgot PIN?
          </button>
          <span aria-hidden className="text-muted-foreground/40">·</span>
          <button type="button" className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-muted-foreground hover:text-foreground" onClick={() => void signOut()}>
            <LogOut className="h-3.5 w-3.5" /> Not you? Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
