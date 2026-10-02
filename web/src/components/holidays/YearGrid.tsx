import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { DOW, dmy, parseYmd, weekdayOrder } from "@/lib/leaveCalendar";
import type { Break } from "@/lib/holidayBreaks";
import { Tip } from "@/components/calendar/shared";
import type { Holiday } from "@/types";

// The whole year on one screen: twelve small month grids, holidays tinted, weekends greyed, and every stretch
// of 3+ days off underlined so a long weekend is something you SEE rather than something you work out. This is
// the "plan my year" surface the list view can't be - so it stays read-mostly: click a day to open it, nothing
// else.

export type YearDay = {
  ymd: string;
  holiday?: Holiday;
  /** A day off for this viewer (weekend, or a holiday that is theirs). */
  off: boolean;
  weekend: boolean;
  /** The stretch of days off this day belongs to, when that stretch is 3+ days. */
  brk?: Break;
  /** Approved leave of the viewer's own, so a planned break reads as already-taken. */
  leave?: boolean;
};

const monthsOf = (year: number) =>
  Array.from({ length: 12 }, (_, m) => ({
    m,
    label: new Date(Date.UTC(year, m, 1)).toLocaleDateString(undefined, { month: "long", timeZone: "UTC" }),
    days: Array.from({ length: new Date(Date.UTC(year, m + 1, 0)).getUTCDate() }, (_, i) =>
      new Date(Date.UTC(year, m, i + 1)).toISOString().slice(0, 10),
    ),
  }));

export function YearGrid({ year, dayOf, today, weekStart = 0, onSelect }: {
  year: string;
  dayOf: (ymd: string) => YearDay;
  today: string;
  weekStart?: number;
  onSelect: (ymd: string) => void;
}) {
  const y = Number(year);
  const months = useMemo(() => monthsOf(y), [y]);
  const cols = weekdayOrder(weekStart);
  return (
    // Twelve months always, so the wide step is a divisor rather than "as many as fit": two rows of six from
    // `3xl` (auto-fill would draw 5 + 5 + 2), about 250px a month on a 1920 screen.
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 3xl:grid-cols-6">
      {months.map(({ m, label, days }) => {
        // Leading blanks so the 1st sits under its weekday column.
        const lead = (new Date(Date.parse(days[0]! + "T00:00:00Z")).getUTCDay() - weekStart + 7) % 7;
        const holidayCount = days.filter((d) => dayOf(d).holiday).length;
        return (
          <section key={m} className="rounded-xl border bg-card p-2.5 shadow-card" data-print-keep>
            <header className="mb-1.5 flex items-baseline justify-between gap-2 px-0.5">
              <h3 className="text-sm font-semibold">{label}</h3>
              {holidayCount > 0 && (
                <span className="text-[11px] font-medium text-muted-foreground">
                  {holidayCount} holiday{holidayCount === 1 ? "" : "s"}
                </span>
              )}
            </header>
            <div className="grid grid-cols-7 gap-px text-center">
              {cols.map((d) => (
                <span key={d} className="pb-0.5 text-[10px] font-medium uppercase text-muted-foreground">{DOW[d]![0]}</span>
              ))}
              {Array.from({ length: lead }, (_, i) => <span key={`lead-${i}`} />)}
              {days.map((ymd) => {
                const day = dayOf(ymd);
                const isToday = ymd === today;
                // Underline runs of 3+ days off: rounded at the ends, square in the middle, so a long weekend
                // reads as one bar across the row rather than three separate marks.
                const brk = day.brk;
                const col = (new Date(parseYmd(ymd)).getUTCDay() - weekStart + 7) % 7;
                const first = !!brk && (brk.from === ymd || col === 0);
                const last = !!brk && (brk.to === ymd || col === 6);
                const cell = (
                  <button
                    type="button"
                    onClick={() => onSelect(ymd)}
                    aria-label={`${dmy(ymd)}${day.holiday ? ` - ${day.holiday.display_name}` : ""}`}
                    className={cn(
                      "relative flex h-7 items-center justify-center rounded text-[11px] tabular-nums transition-colors",
                      day.holiday
                        ? "bg-primary/15 font-semibold text-primary hover:bg-primary/25"
                        : day.leave
                          ? "bg-emerald-100 font-medium text-emerald-800 hover:bg-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300"
                          : day.weekend
                            ? "text-muted-foreground/60 hover:bg-accent"
                            : "hover:bg-accent",
                      isToday && "ring-1 ring-inset ring-primary",
                    )}
                  >
                    {Number(ymd.slice(8, 10))}
                    {brk && (
                      <span
                        aria-hidden
                        className={cn(
                          "pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-success",
                          first && "rounded-l-full",
                          last && "rounded-r-full",
                        )}
                      />
                    )}
                  </button>
                );
                if (!day.holiday && !brk) return <span key={ymd}>{cell}</span>;
                return (
                  <Tip
                    key={ymd}
                    content={
                      <div className="min-w-[11rem] px-2.5 py-2 text-xs">
                        <p className="text-[13px] font-semibold">{dmy(ymd)}</p>
                        {day.holiday && (
                          <p className="mt-0.5 text-primary">
                            {day.holiday.display_name}
                            {day.holiday.half_day ? " (half day)" : ""}
                            {day.holiday.kind === "optional" ? (day.holiday.selected ? " · picked" : " · optional") : ""}
                          </p>
                        )}
                        {brk && <p className="mt-0.5 text-muted-foreground">{brk.days} days off · {dmy(brk.from)} - {dmy(brk.to)}</p>}
                        {day.leave && <p className="mt-0.5 text-muted-foreground">Your approved leave</p>}
                      </div>
                    }
                  >
                    {cell}
                  </Tip>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
