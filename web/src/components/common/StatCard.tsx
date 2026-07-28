import * as React from "react";
import { type LucideIcon } from "lucide-react";
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
}: {
  label: string;
  value: React.ReactNode;
  icon: LucideIcon;
  hint?: React.ReactNode;
  tone?: "primary" | "success" | "warning" | "muted";
  target?: AccessTargetRef;
  onClick?: () => void; // makes the card a drill-through button
  accentClass?: string; // optional left-border accent (e.g. category color): "border-l-4 border-l-warning"
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
        onClick && "group cursor-pointer hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-card-hover transition-all",
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
          {target && <span onClick={(e) => e.stopPropagation()}><AccessTarget target={target} /></span>}
          <div className={cn("flex h-10 w-10 items-center justify-center rounded-lg ring-1 ring-inset ring-foreground/[0.06] transition-transform group-hover:scale-105", tones[tone])}>
            <Icon className="h-5 w-5" />
          </div>
        </div>
      </div>
    </Card>
  );
}
