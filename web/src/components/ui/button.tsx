import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { Loader2 } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        outline: "border border-input bg-card shadow-sm hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        success: "bg-success text-success-foreground shadow-sm hover:bg-success/90",
      },
      // Sizes grow on a coarse pointer, where 36px is a target people miss. Deliberately NOT uniform:
      // `default` and `lg` are the page's real actions (a form's Save, a dialog's Confirm) and get the full
      // 44px; `icon` gets a smaller bump because those sit in table rows and action clusters where 44px per
      // button pushes the row's own content off screen; `sm` is the explicitly dense variant and is left alone
      // so a caller can still opt into density on purpose.
      size: {
        default: "h-9 px-4 py-2 coarse:h-11 coarse:px-5",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-6 coarse:h-12",
        icon: "h-9 w-9 coarse:h-10 coarse:w-10",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

export interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick">,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  // While true, the button is disabled and shows a spinner - so every async action gets a consistent
  // in-flight state without each caller hand-rolling a disabled+"Saving…" pattern. Ignored when `asChild`.
  loading?: boolean;
  // A handler that RETURNS a promise is the action itself: the button holds its loading state until that
  // promise settles, so a click can't be repeated while the request is in flight. Return the promise
  // (`onClick={() => save()}`, or an async handler) rather than dropping it with `void save()`.
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => unknown;
}

// The spinner takes the place of the button's leading icon instead of sitting beside it, so an icon-only
// button stays one glyph wide and a labelled one doesn't grow by an icon while it waits.
const SPINNER_SWAP = "[&>[data-spinner]+svg]:hidden";

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | null)?.then === "function";
}

// Tracks the promise an onClick returns. The ref guards the gap before React re-renders the disabled
// button, so a fast double click can't start the action twice.
function usePendingClick(onClick: ButtonProps["onClick"]) {
  const [pending, setPending] = React.useState(false);
  const inFlight = React.useRef(false);
  const handleClick = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (inFlight.current) {
        event.preventDefault();
        return;
      }
      const result = onClick?.(event);
      if (!isThenable(result)) return;
      inFlight.current = true;
      setPending(true);
      const settle = () => {
        inFlight.current = false;
        setPending(false);
      };
      // Rethrown so a rejection the caller didn't handle still surfaces as an unhandled rejection, exactly
      // as it did before the button watched it.
      void Promise.resolve(result).then(settle, (err: unknown) => {
        settle();
        throw err;
      });
    },
    [onClick],
  );
  return { pending, handleClick };
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, disabled, onClick, children, ...props }, ref) => {
    const { pending, handleClick } = usePendingClick(onClick);
    // Slot does React.Children.only, so the asChild branch must pass the child through ALONE - a second child
    // expression (even one that evaluates to `false`) makes children an array and throws.
    if (asChild) {
      // Slot forwards unknown props straight to the child, so `disabled` still lands on the real element -
      // SlotProps just doesn't model it, hence the cast.
      return (
        <Slot className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...({ disabled } as { disabled?: boolean })} onClick={onClick && handleClick} {...props}>
          {children}
        </Slot>
      );
    }
    const busy = loading || pending;
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }), busy && SPINNER_SWAP)}
        ref={ref}
        disabled={disabled || busy}
        aria-busy={busy || undefined}
        onClick={onClick && handleClick}
        {...props}
      >
        {busy && <Loader2 data-spinner="" className="animate-spin" />}
        {children}
      </button>
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
