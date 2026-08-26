import { CalendarDays, Users, Plus, X, PartyPopper, Laptop } from "lucide-react";
import { cn } from "@/lib/utils";
import { coverOf, dmy, halfLabel, longDate, type CalEntry } from "@/lib/leaveCalendar";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { Celebration, Event, Holiday } from "@/types";

// The selected day in full: holiday, availability, who's out (with their half-day edge), who's remote, what
// else lands on it, and the one action a day view owes you - book this date.

export function DayPanel({ ymd, holiday, entries, events, celebrations, away, total, canRequest, onRequest, onClose }: {
  ymd: string;
  holiday?: Holiday;
  entries: CalEntry[];
  events: Event[];
  celebrations: Celebration[];
  away: number;
  total: number;
  canRequest: boolean;
  onRequest: () => void;
  onClose: () => void;
}) {
  // Leave first, then remote work: one is absence, the other is presence somewhere else.
  const sorted = [...entries].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  const available = Math.max(0, total - away);
  const cover = coverOf(away, total);
  return (
    <Card>
      <CardContent className="space-y-4 p-4 sm:p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <CalendarDays className="h-4 w-4 shrink-0 text-primary" />
              <span className="truncate">{longDate(ymd)}</span>
            </p>
            {holiday && (
              <Badge variant="secondary" className="mt-1.5 bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300">{holiday.display_name}</Badge>
            )}
          </div>
          <button type="button" onClick={onClose} aria-label="Close the day panel" className="rounded p-1 text-muted-foreground hover:bg-accent" data-print-hide>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className={cn("flex items-center gap-1.5 text-sm", cover === "critical" ? "font-medium text-destructive" : cover === "heavy" ? "font-medium text-warning" : "text-muted-foreground")}>
            <Users className="h-4 w-4" /> {available} of {total} available
          </span>
          {canRequest && <Button size="sm" variant="outline" onClick={onRequest} data-print-hide><Plus className="h-4 w-4" /> Request</Button>}
        </div>

        {sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground">No one on leave{holiday ? " (company holiday)" : ""}.</p>
        ) : (
          <div className="space-y-2">
            {sorted.map((en) => (
              <div key={en.key} className={cn("flex items-center gap-2 rounded-lg border p-2", en.pending && "border-dashed opacity-80")}>
                <PhotoAvatar employeeId={en.empId} name={en.name} photo={en.photo} className="h-8 w-8" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{en.name}</p>
                  <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                    {en.kind === "remote"
                      ? <Laptop className="h-3 w-3 shrink-0" />
                      : <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: en.color }} />}
                    {en.kind === "remote" ? "Working remotely" : en.type}
                    {halfLabel(en) === "AM" ? " · morning" : halfLabel(en) === "PM" ? " · afternoon" : ""}
                    <span className="truncate text-muted-foreground/70">· {dmy(en.start)}–{dmy(en.end)}</span>
                  </p>
                </div>
                {en.pending && <Badge variant="warning" className="h-4 shrink-0 px-1 text-[10px]">pending</Badge>}
              </div>
            ))}
          </div>
        )}

        {celebrations.length > 0 && (
          <div className="space-y-1.5 border-t pt-3">
            {celebrations.map((c) => (
              <p key={`${c.employee}-${c.kind}`} className="flex items-center gap-2 text-sm">
                <PartyPopper className="h-4 w-4 shrink-0 text-warning" />
                <span className="truncate">{c.name}</span>
                <span className="truncate text-xs text-muted-foreground">{c.kind === "birthday" ? "birthday" : `${c.years ?? ""} year${c.years === 1 ? "" : "s"}`}</span>
              </p>
            ))}
          </div>
        )}

        {events.length > 0 && (
          <div className="space-y-1.5 border-t pt-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Events</p>
            {events.map((ev) => (
              <div key={ev.path} className="flex items-center gap-2 text-sm">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: ev.color || "#6366f1" }} />
                <span className="truncate font-medium">{ev.title}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
