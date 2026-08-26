import { cn } from "@/lib/utils";
import { DOW, coverOf, gridCells, monthLabelOf, weekdayOrder, ymdUtc, COVER_BAR } from "@/lib/leaveCalendar";
import { DayCard, Tip, type ViewProps } from "./shared";

// Three months at once, as a heat map rather than a bar chart: at this zoom the question is no longer "who is
// out" but "when is this team actually available", and a shaded day answers that in one glance across a
// planning window a single month is too narrow to show.

export function QuarterGrid({
  cursor, months = 3, byDay, awayOn, holidayOn, celebrationsOn, workDays, weekStart, total, today, selected, onSelect,
}: ViewProps & { cursor: Date; months?: number }) {
  return (
    <div className="grid gap-4 p-3 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: months }, (_, k) => new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + k, 1))).map((m) => {
        const cells = gridCells(m, weekStart);
        return (
          <div key={ymdUtc(m)} data-print-keep>
            <p className="mb-1.5 text-sm font-semibold">{monthLabelOf(m)}</p>
            <div className="grid grid-cols-7 text-center text-[10px] uppercase text-muted-foreground">
              {weekdayOrder(weekStart).map((wd) => <div key={wd} className={cn("pb-1", !workDays.includes(wd) && "text-muted-foreground/60")}>{DOW[wd][0]}</div>)}
            </div>
            <div className="grid grid-cols-7 gap-px">
              {cells.map((d) => {
                const ymd = ymdUtc(d);
                const inMonth = d.getUTCMonth() === m.getUTCMonth();
                const away = awayOn(ymd);
                const cover = coverOf(away, total);
                const hol = holidayOn(ymd);
                const nonWorking = !workDays.includes(d.getUTCDay());
                return (
                  <Tip key={ymd} content={<DayCard ymd={ymd} entries={byDay.get(ymd) ?? []} away={away} total={total} holiday={hol} celebrations={celebrationsOn(ymd)} />}>
                    <button
                      type="button"
                      onClick={() => onSelect(selected === ymd ? null : ymd)}
                      aria-label={`${ymd}, ${away} of ${total} away`}
                      className={cn(
                        "relative flex h-7 items-center justify-center rounded-[3px] text-[11px] tabular-nums transition-colors",
                        !inMonth && "opacity-25",
                        hol ? "bg-violet-100 dark:bg-violet-950/40" : nonWorking ? "bg-brand-neutral-100/70 dark:bg-brand-neutral-800/40" : "bg-muted/40",
                        ymd === today && "font-semibold ring-1 ring-primary",
                        selected === ymd && "ring-2 ring-primary",
                      )}
                    >
                      {/* Cover as a fill from the bottom: the fuller the day, the taller the shade. */}
                      {cover !== "none" && (
                        <span
                          className={cn("absolute inset-x-0 bottom-0 rounded-[3px] opacity-60", COVER_BAR[cover])}
                          style={{ height: `${Math.min(100, Math.round((away / Math.max(1, total)) * 100))}%` }}
                          aria-hidden
                        />
                      )}
                      <span className="relative">{d.getUTCDate()}</span>
                    </button>
                  </Tip>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
