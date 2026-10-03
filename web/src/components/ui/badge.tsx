import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-hidden",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary/10 text-primary",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "text-foreground",
        success: "border-transparent bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
        // "info" is the one status that IS the brand, so it runs on the Brand Blue ramp rather than
        // Tailwind's stock blue - it should read as the same blue as primary, just quieter.
        info: "border-transparent bg-brand-blue-100 text-brand-blue-700 dark:bg-brand-blue-950/60 dark:text-brand-blue-300",
        warning: "border-transparent bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
        destructive: "border-transparent bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
        muted: "border-transparent bg-muted text-muted-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

// A SPAN, not a div. A badge is inline content - it trails a heading, a row label, a sentence - and half its
// call sites put it inside a <p>. A <div> there is invalid nesting: the browser closes the paragraph before
// the badge and reopens one after, which silently splits the row it was part of. `inline-flex` above already
// does the layout, so the element itself may as well be one that is legal wherever a badge reads naturally.
// The ref is forwarded so a badge can be a tooltip or popover trigger itself (`asChild`), with no wrapper.
const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(({ className, variant, ...props }, ref) => (
  <span ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />
));
Badge.displayName = "Badge";

export { Badge, badgeVariants };
