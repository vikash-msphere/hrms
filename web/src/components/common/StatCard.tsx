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
        "p-5",
        accentClass,
        (onPin || onHide) && "group", // hover-reveal for the pin/hide affordances even on non-clickable cards
        onClick &&
          "group cursor-pointer transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-card-hover active:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      )}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
          <p className="mt-2 text-3xl font-bold tracking-tight text-foreground tabular-nums">{value}</p>
          {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
        </div>
        <div className="flex items-center gap-2">
          {/* Personal pin/hide: quiet icon buttons that appear on hover (pin stays visible while active).
              stopPropagation keeps them from triggering the card's drill-through. */}
          {(onPin || onHide) && (
            <span className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
              {onPin && (
                <button
                  type="button"
                  onClick={onPin}
                  aria-pressed={pinned}
                  aria-label={pinned ? `Unpin ${label}` : `Pin ${label}`}
                  title={pinned ? "Unpin" : "Pin to front"}
                  className={cn(
                    "rounded p-1 text-muted-foreground transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100",
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
                  className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <EyeOff className="h-3.5 w-3.5" />
                </button>
              )}
            </span>
          )}
          {target && <span onClick={(e) => e.stopPropagation()}><AccessTarget target={target} /></span>}
          <div className={cn("flex h-10 w-10 items-center justify-center rounded-lg ring-1 ring-inset ring-foreground/[0.06] transition-transform group-hover:scale-105", tones[tone])}>
            <Icon className="h-5 w-5" />
          </div>
        </div>
      </div>
    </Card>
  );
}
