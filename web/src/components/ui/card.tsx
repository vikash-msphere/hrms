import * as React from "react";
import { cn } from "@/lib/utils";

const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        // Themeable elevation (see --shadow-card in index.css): a real lift off the page in light mode,
        // border + a deeper shadow in dark. The transition lets interactive cards animate on hover.
        "rounded-xl border bg-card text-card-foreground shadow-card transition-shadow",
        className,
      )}
      {...props}
    />
  )
);
Card.displayName = "Card";

// 16px of padding on a phone, 24px from `sm` up. A 360px screen gives the page 328px, and a card that spends
// 48 of them on its own margins is spending 15% of the screen on nothing - which is felt hardest exactly
// where the content is widest (a stacked table row, a name beside a status). The desktop figure is unchanged.
//
// A caller that states its own padding must state BOTH steps (`p-0 sm:p-0`, `pt-4 sm:pt-6`): tailwind-merge
// drops the conflicting base class per breakpoint, so an unprefixed override alone would leave the `sm:` half
// of the default in place.
const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex flex-col space-y-1.5 p-4 sm:p-6", className)} {...props} />
  )
);
CardHeader.displayName = "CardHeader";

// data-sentry-unmask on the title and description: both are <div>s, so no heading rule reaches them, and both
// hold the section's NAME rather than its contents - masking them left panels titled `***` describing `***`.
const CardTitle = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div data-sentry-unmask ref={ref} className={cn("text-base font-semibold leading-none tracking-tight", className)} {...props} />
  )
);
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div data-sentry-unmask ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
  )
);
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("p-4 pt-0 sm:p-6 sm:pt-0", className)} {...props} />
);
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex items-center p-4 pt-0 sm:p-6 sm:pt-0", className)} {...props} />
  )
);
CardFooter.displayName = "CardFooter";

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
