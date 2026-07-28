import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary/10 text-primary",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "text-foreground",
        success: "border-transparent bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
        info: "border-transparent bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300",
        warning: "border-transparent bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
        destructive: "border-transparent bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
        muted: "border-transparent bg-muted text-muted-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
