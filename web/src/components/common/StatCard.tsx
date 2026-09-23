import * as React from "react";
import { type LucideIcon, Pin, EyeOff } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { AccessTarget } from "@/components/access/AccessTarget";
import { type AccessTargetRef } from "@/components/access/AccessModeProvider";

export function StatCard({
  label,
  value,
  icon: Icon,
  hint,
  tone = "primary",
  target,
  onClick,
  accentClass,
  pinned,
  onPin,
  onHide,
  style,
}: {
  label: string;
  value: React.ReactNode;
  icon: LucideIcon;
  hint?: React.ReactNode;
  tone?: "primary" | "success" | "warning" | "muted";
  target?: AccessTargetRef;
  onClick?: () => void; // makes the card a drill-through button
  accentClass?: string; // optional left-border accent (e.g. category color): "border-l-4 border-l-warning"
  pinned?: boolean; // personal pin state; shown always when pinned, on hover otherwise
  onPin?: () => void; // toggle personal pin (renders the pin affordance)
  onHide?: () => void; // personal hide (renders the hide affordance on hover)
  style?: React.CSSProperties; // how wide this card's row is, when it sits in a StatRow
}) {
  const tones: Record<string, string> = {
    primary: "bg-primary/10 text-primary",
    success: "bg-success/12 text-success",
    warning: "bg-warning/15 text-warning",
    muted: "bg-muted text-muted-foreground",
  };
  return (
    <Card
      className={cn(
        // Tighter on a phone, where these sit two across: 20px of padding on each side of a ~170px cell is
        // most of the room the number needs.
        "p-4 sm:p-5",
        accentClass,
        (onPin || onHide) && "group", // hover-reveal for the pin/hide affordances even on non-clickable cards
        onClick &&
          "group cursor-pointer transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-card-hover active:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      )}
      style={style}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
          {/* A formatted money figure is the widest thing that lands here, and at two cards across a phone
              it has ~140px. Smaller there, and truncating rather than wrapping - a number that breaks over
              two lines is harder to read than one that ends in an ellipsis and says so on tap. */}
          <p className="mt-1.5 truncate text-2xl font-bold tracking-tight text-foreground tabular-nums sm:mt-2 sm:text-3xl" title={typeof value === "string" || typeof value === "number" ? String(value) : undefined}>{value}</p>
          {/* One line, always: hints are written short enough to fit, and truncate is the backstop so a long one
              can never push the card taller than its neighbours in the row. */}
          {hint && <p className="mt-1 truncate text-xs text-muted-foreground" title={typeof hint === "string" ? hint : undefined}>{hint}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* Personal pin/hide: quiet icon buttons that appear on hover (pin stays visible while active).
              stopPropagation keeps them from triggering the card's drill-through. */}
          {/* Pin and hide are personal curation, and on a phone they are two 44px targets competing with the
              number for a 170px cell - so they are a `sm`-and-up affordance. Nothing is lost on the phone:
              preferences sync per user, so pins made on a laptop are already in force here, and the band's own
              category filter and "hide all-clear" - both present at every width - are the curation that
              actually matters on a small screen. */}
          {(onPin || onHide) && (
            <span className="hidden items-center gap-0.5 sm:flex" onClick={(e) => e.stopPropagation()}>
              {onPin && (
                <button
                  type="button"
                  onClick={onPin}
                  aria-pressed={pinned}
                  aria-label={pinned ? `Unpin ${label}` : `Pin ${label}`}
                  title={pinned ? "Unpin" : "Pin to front"}
                  className={cn(
                    // Pin/hide are hover-revealed on a desktop and always shown on touch (index.css); the
                    // target grows there too, since a 22px box next to another 22px box is a coin flip.
                    "rounded p-1 text-muted-foreground transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 coarse:flex coarse:h-9 coarse:w-9 coarse:items-center coarse:justify-center coarse:p-0",
                    pinned ? "text-primary opacity-100" : "opacity-0 group-hover:opacity-100",
                  )}
                >
                  <Pin className={cn("h-3.5 w-3.5", pinned && "fill-current")} />
                </button>
              )}
              {onHide && (
                <button
                  type="button"
                  onClick={onHide}
                  aria-label={`Hide ${label}`}
                  title="Hide for me"
                  className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 coarse:flex coarse:h-9 coarse:w-9 coarse:items-center coarse:justify-center coarse:p-0"
                >
                  <EyeOff className="h-3.5 w-3.5" />
                </button>
              )}
            </span>
          )}
          {target && <span onClick={(e) => e.stopPropagation()}><AccessTarget target={target} /></span>}
          <div className={cn("flex h-9 w-9 items-center justify-center rounded-lg ring-1 ring-inset ring-foreground/[0.06] transition-transform group-hover:scale-105 sm:h-10 sm:w-10", tones[tone])}>
            <Icon className="h-4 w-4 sm:h-5 sm:w-5" />
          </div>
        </div>
      </div>
    </Card>
  );
}
