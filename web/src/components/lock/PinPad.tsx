import * as React from "react";
import { Delete } from "lucide-react";
import { cn } from "@/lib/utils";

// The PIN entry used by the lock screen and the app lock settings: one dot per digit over a REAL input, so a
// screen reader, a phone's number keyboard, a physical keyboard and paste all work, plus an on-screen pad for
// touch. The digits are never shown - the input is invisible and the dots only say how many are in.
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
  autoFocus?: boolean;
  /** Hold focus on the input for as long as it is enabled (the lock screen, where it is the only thing to type into). */
  keepFocus?: boolean;
  tone?: "default" | "success" | "error";
};

export function PinPad({ length, value, onChange, onComplete, label, disabled, shake = 0, keypad, autoFocus, keepFocus, tone = "default" }: Props) {
  const inputRef = React.useRef<HTMLInputElement>(null);
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
    inputRef.current?.focus({ preventScroll: true });
  };

  React.useEffect(() => {
    if (autoFocus && !disabled) inputRef.current?.focus({ preventScroll: true });
  }, [autoFocus, disabled]);

  // With `keepFocus`, a click anywhere on the page leaves the focus on the input (buttons still get their
  // click), and focus that falls to nothing comes back: a blur to the page body, the window or tab coming back
  // to the front, or a dialog of the unmounted app handing focus back to a trigger that is gone. Focus that
  // moves to a real control (Tab to "Forgot PIN?") is left there.
  React.useEffect(() => {
    if (!keepFocus || disabled) return;
    const input = inputRef.current;
    if (!input) return;
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
  }, [keepFocus, disabled]);

  return (
    <div className="flex flex-col items-center gap-6">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input
        ref={inputRef}
        id={id}
        type="text"
        inputMode="numeric"
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
        className={cn("flex cursor-text gap-3.5", shake > 0 && "lock-shake")}
      >
        {Array.from({ length }, (_, i) => (
          <span
            key={i}
            className={cn(
              "h-3.5 w-3.5 rounded-full border-2 transition-all duration-150",
              i < value.length ? "scale-110 border-transparent" : "border-muted-foreground/40",
              i < value.length && (tone === "success" ? "bg-success" : tone === "error" ? "bg-destructive" : "bg-foreground"),
              i === value.length && !disabled && "border-primary",
            )}
          />
        ))}
      </label>
      {keypad && (
        <div className="grid grid-cols-3 gap-3 sm:gap-4" role="group" aria-label="Number pad">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
            <PadKey key={d} onPointerDown={press(d)} disabled={disabled} label={d} />
          ))}
          <span aria-hidden />
          <PadKey onPointerDown={press("0")} disabled={disabled} label="0" />
          <PadKey onPointerDown={press("back")} disabled={disabled || !value} label={<Delete className="h-5 w-5" />} aria="Delete last digit" quiet />
        </div>
      )}
    </div>
  );
}

function PadKey({ label, aria, quiet, ...rest }: { label: React.ReactNode; aria?: string; quiet?: boolean; disabled?: boolean; onPointerDown: (e: React.PointerEvent) => void }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={aria}
      {...rest}
      className={cn(
        "flex h-16 w-16 select-none items-center justify-center rounded-full text-2xl font-medium tabular-nums transition-colors disabled:opacity-40 sm:h-[4.5rem] sm:w-[4.5rem]",
        quiet ? "text-muted-foreground hover:bg-accent" : "bg-card text-foreground shadow-sm ring-1 ring-border hover:bg-accent active:scale-95",
      )}
    >
      {label}
    </button>
  );
}
