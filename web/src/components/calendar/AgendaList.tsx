import { CalendarOff, Users, PartyPopper } from "lucide-react";
import { cn } from "@/lib/utils";
import { DOW, halfLabel, parseYmd, wash } from "@/lib/leaveCalendar";
import { EmptyState } from "@/components/common/EmptyState";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { CoverStrip, type ViewProps } from "./shared";
import type { Event } from "@/types";

// The month as an agenda: only the days that carry something, each one a tap target. This is what a phone gets
// by default - a seven-column grid at 360px is a puzzle, a list is a list.

export function AgendaList({
  monthDays, byDay, awayOn, holidayOn, closedOn, celebrationsOn, eventsOn, total, today, selected, onSelect, monthLabel,
}: ViewProps & { monthDays: string[]; eventsOn: (ymd: string) => Event[]; monthLabel: string }) {
  // A closed day earns a row on its own, even with nothing booked on it. This list exists to answer "what is
  // happening this month", and a fortnight the org is shut is exactly that - filtering it out because nobody
  // has booked leave in it would hide the reason nobody has.
  const days = monthDays
    .map((ymd) => ({ ymd, leaves: byDay.get(ymd) ?? [], hol: holidayOn(ymd), closed: closedOn(ymd), celebs: celebrationsOn(ymd), events: eventsOn(ymd) }))
    .filter((d) => d.leaves.length > 0 || d.hol || d.closed || d.celebs.length > 0 || d.events.length > 0);

  if (days.length === 0) {
    return (
      <div className="p-4">
        <EmptyState icon={CalendarOff} title={`Nothing booked in ${monthLabel}`} description="No leave, holidays or events fall in this month for the current filters." />
      </div>
    );
  }

  return (
    <div className="divide-y">
      {days.map(({ ymd, leaves, hol, closed, celebs, events }) => {
        const d = new Date(parseYmd(ymd));
        const away = awayOn(ymd);
        return (
          <button
            key={ymd}
            type="button"
            onClick={() => onSelect(selected === ymd ? null : ymd)}
            aria-pressed={selected === ymd}
            className={cn("relative block w-full p-3 text-left transition-colors hover:bg-accent/40", selected === ymd && "bg-accent/50")}
            data-print-keep
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn("flex h-9 w-9 shrink-0 flex-col items-center justify-center rounded-lg border text-center leading-none", ymd === today && "border-primary bg-primary text-primary-foreground")}>
                <span className="text-[9px] uppercase opacity-80">{DOW[d.getUTCDay()]}</span>
                <span className="text-sm font-semibold tabular-nums">{d.getUTCDate()}</span>
              </span>
              {hol && <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700 dark:bg-violet-950/40 dark:text-violet-300">{hol.display_name}</span>}
              {closed && <span className="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning-foreground dark:text-warning">Closed · {closed}</span>}
              {away > 0 && (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Users className="h-3.5 w-3.5" /> {Math.max(0, total - away)} of {total} available
                </span>
              )}
              {celebs.map((c) => (
                <span key={`${c.employee}-${c.kind}`} className="flex items-center gap-1 text-xs text-muted-foreground">
                  <PartyPopper className="h-3.5 w-3.5 text-warning" /> {c.name}
                </span>
              ))}
              {events.length > 0 && <span className="text-xs text-muted-foreground">· {events.length} event{events.length === 1 ? "" : "s"}</span>}
            </div>
            {leaves.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5 pl-11">
                {leaves.map((en) => (
                  <span
                    key={en.key}
                    className={cn("inline-flex items-center gap-1.5 rounded-full border-l-[3px] py-0.5 pl-1.5 pr-2 text-xs", en.pending && "border border-dashed opacity-80", en.mine && "ring-1 ring-inset ring-primary")}
                    style={{ backgroundColor: wash(en.color), borderColor: en.color }}
                  >
                    <PhotoAvatar employeeId={en.empId} name={en.name} photo={en.photo} className="h-4 w-4 text-[8px]" />
                    <span className="font-medium">{en.name}</span>
                    <span className="text-muted-foreground">
                      {en.kind === "remote" ? "Remote" : en.type}{halfLabel(en) ? ` · ${halfLabel(en)}` : ""}
                    </span>
                  </span>
                ))}
              </div>
            )}
            <CoverStrip away={away} total={total} />
          </button>
        );
      })}
    </div>
  );
}
