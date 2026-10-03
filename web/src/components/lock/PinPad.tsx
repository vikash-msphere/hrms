import * as React from "react";
import { Delete } from "lucide-react";
import { cn } from "@/lib/utils";

// The PIN entry used by the lock screen and the app lock settings: one dot per digit over a REAL input, so a
// screen reader, a physical keyboard and paste all work, plus an on-screen pad for touch. With the pad shown the
// phone's own keyboard stays shut; without it, the phone opens its number keyboard. The digits are never shown -
// the input is invisible and the dots only say how many are in.
//
// `usePinPad` hands back the two halves - `field` (the input and the dots) and `keypad` - for a layout that
// places them apart, as the lock screen does on a phone, with the pad down where the thumb is. `PinPad` is the
// two stacked.
//
// `shake` is a counter: bump it to shake the dots (a wrong PIN). Submitting is the caller's, on the last digit.

type Props = {
  length: number;
  value: string;
  onChange: (next: string) => void;
  onComplete?: (pin: string) => void;
  label: string;
  disabled?: boolean;
  shake?: number;
  /** Show the on-screen number pad (the lock screen always; settings on touch screens). */
  keypad?: boolean;
  /** How big the pad's keys are: `phone` fills a phone's width and scales with its height, `landscape` fits a
   *  phone held sideways, `default` is the pad as it sits in a centred column. */
  size?: "default" | "phone" | "landscape";
  autoFocus?: boolean;
  /** Hold focus on the input for as long as it is enabled (the lock screen, where it is the only thing to type into). */
  keepFocus?: boolean;
  tone?: "default" | "success" | "error";
};

const GRID: Record<NonNullable<Props["size"]>, string> = {
  default: "gap-3 sm:gap-4",
  phone: "gap-x-[clamp(1.25rem,7vw,2rem)] gap-y-[clamp(0.75rem,2dvh,1.25rem)]",
  landscape: "gap-x-5 gap-y-2.5",
};
const KEY: Record<NonNullable<Props["size"]>, string> = {
  default: "h-16 w-16 text-2xl font-medium sm:h-[4.5rem] sm:w-[4.5rem]",
  phone: "size-[clamp(3.5rem,9.5dvh,5rem)] text-[1.75rem] font-normal",
  landscape: "size-14 text-xl font-medium",
};

export function usePinPad({ length, value, onChange, onComplete, label, disabled, shake = 0, keypad, size = "default", autoFocus, keepFocus, tone = "default" }: Props) {
  // The element itself, not a ref: a layout that moves the field (the lock screen turning sideways) mounts a
  // new input, and the focus handlers below have to follow it there.
  const [input, setInput] = React.useState<HTMLInputElement | null>(null);
  const id = React.useId();

  const set = (next: string) => {
    const digits = next.replace(/\D/g, "").slice(0, length);
    if (digits === value) return;
    onChange(digits);
    if (digits.length === length) onComplete?.(digits);
  };

  // A tap on the pad must not steal focus from the input on desktop, or typing stops working after a click.
  const press = (d: string) => (e: React.PointerEvent) => {
    e.preventDefault();
    if (disabled) return;
    navigator.vibrate?.(8);
    set(d === "back" ? value.slice(0, -1) : value + d);
    input?.focus({ preventScroll: true });
  };

  React.useEffect(() => {
    if (autoFocus && !disabled) input?.focus({ preventScroll: true });
  }, [autoFocus, disabled, input]);

  // With `keepFocus`, a click anywhere on the page leaves the focus on the input (buttons still get their
  // click), and focus that falls to nothing comes back: a blur to the page body, the window or tab coming back
  // to the front, or a dialog of the unmounted app handing focus back to a trigger that is gone. Focus that
  // moves to a real control (Tab to "Forgot PIN?") is left there.
  React.useEffect(() => {
    if (!keepFocus || disabled || !input) return;
    const grab = () => {
      if (document.visibilityState === "visible" && document.activeElement !== input) input.focus({ preventScroll: true });
    };
    const onMouseDown = (e: MouseEvent) => {
      if (e.target === input) return;
      e.preventDefault();
      grab();
    };
    const onFocusOut = (e: FocusEvent) => {
      if (!e.relatedTarget) requestAnimationFrame(grab);
    };
    const onVisible = () => grab();
    grab();
    document.addEventListener("mousedown", onMouseDown);
    input.addEventListener("focusout", onFocusOut);
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      input.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [keepFocus, disabled, input]);

  const field = (
    <>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input
        ref={setInput}
        id={id}
        type="text"
        // With the on-screen pad, the pad IS the keyboard: the phone's own must never open, or the first tap
        // (a user gesture, so the focus it hands the input raises it) covers the pad mid-entry. A physical
        // keyboard and paste still type into the focused input.
        inputMode={keypad ? "none" : "numeric"}
        pattern="[0-9]*"
        autoComplete="off"
        // Password managers must not offer to save a PIN, or fill one.
        data-1p-ignore=""
        data-lpignore="true"
        maxLength={length}
        value={value}
        disabled={disabled}
        onChange={(e) => set(e.target.value)}
        className="absolute h-px w-px opacity-0"
      />
      {/* A label for the input, so a click on the dots focuses it natively; it has no text of its own, so the
          input's name stays the one above. Keyboard users are on the input already. */}
      <label
        key={shake}
        htmlFor={id}
        aria-hidden
        className={cn("flex cursor-text", size === "phone" ? "gap-4" : "gap-3.5", shake > 0 && "lock-shake")}
      >
        {Array.from({ length }, (_, i) => (
          <span
            key={i}
            className={cn(
              "rounded-full border-2 transition-all duration-150",
              size === "phone" ? "h-4 w-4" : "h-3.5 w-3.5",
              i < value.length ? "scale-110 border-transparent" : "border-muted-foreground/40",
              i < value.length && (tone === "success" ? "bg-success" : tone === "error" ? "bg-destructive" : "bg-foreground"),
              i === value.length && !disabled && "border-primary",
            )}
          />
        ))}
      </label>
    </>
  );

  const key = KEY[size];
  const pad = keypad ? (
    <div className={cn("grid grid-cols-3 justify-items-center", GRID[size])} role="group" aria-label="Number pad">
      {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
        <PadKey key={d} onPointerDown={press(d)} disabled={disabled} label={d} className={key} />
      ))}
      <span aria-hidden />
      <PadKey onPointerDown={press("0")} disabled={disabled} label="0" className={key} />
      {/* Nothing to delete, nothing to show - the slot stays, so the 0 does not move. */}
      <PadKey onPointerDown={press("back")} disabled={disabled || !value} label={<Delete className="h-5 w-5" />} aria="Delete last digit" quiet className={cn(key, !value && "invisible")} />
    </div>
  ) : null;

  return { field, keypad: pad };
}

export function PinPad(props: Props) {
  const { field, keypad } = usePinPad(props);
  return (
    <div className="flex flex-col items-center gap-6">
      {field}
      {keypad}
    </div>
  );
}

// The key shows its own press: `:active` is unreliable on touch (iOS paints it only with a touch listener in
// place, and a press that preventDefaults its pointerdown may not get it at all), and a tap with no visible
// answer reads as a missed one.
function PadKey({ label, aria, quiet, className, onPointerDown, disabled }: { label: React.ReactNode; aria?: string; quiet?: boolean; className: string; disabled?: boolean; onPointerDown: (e: React.PointerEvent) => void }) {
  const [pressed, setPressed] = React.useState(false);
  const release = () => setPressed(false);
  // A key disabled mid-press (delete taking the last digit, the pad going busy on the last one) gets no
  // pointerup, so the press is dropped with it rather than left showing when the key comes back.
  if (disabled && pressed) setPressed(false);
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={aria}
      disabled={disabled}
      data-pressed={pressed || undefined}
      onPointerDown={(e) => {
        onPointerDown(e);
        setPressed(true);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onPointerLeave={release}
      className={cn(
        "flex select-none items-center justify-center rounded-full tabular-nums transition-[transform,background-color,opacity] duration-100 disabled:opacity-40 data-[pressed]:scale-95 data-[pressed]:bg-accent",
        quiet ? "text-muted-foreground hover:bg-accent" : "bg-card text-foreground shadow-sm ring-1 ring-border hover:bg-accent",
        className,
      )}
    >
      {label}
    </button>
  );
}
