import * as React from "react";
import { cn } from "@/lib/utils";

// Auto-growing textarea: expands to fit its content (down to the min-height floor) so long entries don't
// hide behind a tiny scroll area. Resizes on input and whenever a controlled `value` changes.
const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, onInput, value, ...props }, ref) => {
    const innerRef = React.useRef<HTMLTextAreaElement | null>(null);
    const setRef = React.useCallback(
      (el: HTMLTextAreaElement | null) => {
        innerRef.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
      },
      [ref],
    );
    const resize = React.useCallback(() => {
      const el = innerRef.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }, []);
    // Re-fit on mount and on controlled value changes (e.g. a form reset or edit prefill).
    React.useLayoutEffect(() => {
      resize();
    }, [resize, value]);
    return (
      <textarea
        ref={setRef}
        value={value}
        onInput={(e) => {
          resize();
          onInput?.(e);
        }}
        className={cn(
          // min-w-0: a <textarea>'s intrinsic width comes from its `cols` attribute (20 by default), and
          // that becomes its automatic minimum size as a flex item. See ui/input.tsx.
          "flex min-h-[80px] w-full min-w-0 resize-none overflow-hidden rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      />
    );
  }
);
Textarea.displayName = "Textarea";

export { Textarea };
