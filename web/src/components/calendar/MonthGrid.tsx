import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { CalendarPlus, Plane, PartyPopper, Laptop } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DOW, addDays, hiddenPerDay, layoutStrip, longDate, rangeDays, weekdayOrder, workingDaysIn, ymdUtc, type CalEntry,
} from "@/lib/leaveCalendar";
import { Bar, CoverStrip, DayCard, Tip, type ViewProps } from "./shared";

// The month, drawn the way a calendar has to be: a leave is one continuous bar across the days it covers, and
// the day cells underneath own every interaction (click, drag-to-request, arrows). That division is deliberate
// - bars are inert so a drag started anywhere lands on a day, and the hover card hangs off the DAY, which is
// also the more useful answer ("who is out on the 12th") than any single bar could give.

const MAX_LANES = 3; // bars per week row before the rest roll up into a per-day "+N more"
const LANE_H = 20;
const LANES_TOP = 26; // px below the date header where lane 0 starts

export function MonthGrid({
  cells, month, byDay, awayOn, holidayOn, closedOn, celebrationsOn, workDays, weekStart, total, today, selected, onSelect,
  canRequest, onRange, onMonth, holidaySet,
}: ViewProps & {
  cells: Date[];
  month: number;
  canRequest: boolean;
  onRange: (from: string, to: string) => void;
  onMonth: (delta: number) => void;
  holidaySet: Set<string>;
}) {
  const [drag, setDrag] = useState<{ a: string; b: string } | null>(null);
  // A range drag ends in a mouseup the browser also reports as a click; that click must not re-select.
  const suppressClick = useRef(false);
  const dayRefs = useRef(new Map<string, HTMLButtonElement>());
  const wantFocus = useRef(false);

  // The drag can end anywhere (the pointer leaves the grid on the way to the last day), so it finishes on window.
  useEffect(() => {
    if (!drag) return;
    const finish = () => {
      setDrag(null);
      if (drag.a === drag.b) return;
      suppressClick.current = true;
      const [from, to] = drag.a <= drag.b ? [drag.a, drag.b] : [drag.b, drag.a];
      onRange(from, to);
    };
    window.addEventListener("mouseup", finish);
    return () => window.removeEventListener("mouseup", finish);
  }, [drag, onRange]);

  // Focus follows the selection when the keyboard moved it, so an arrow walk is visible as well as announced.
  useEffect(() => {
    if (!wantFocus.current || !selected) return;
    dayRefs.current.get(selected)?.focus();
    wantFocus.current = false;
  });

  const walk = (days: number) => {
    wantFocus.current = true;
    onSelect(addDays(selected ?? today, days));
  };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const moves: Record<string, () => void> = {
      ArrowLeft: () => walk(-1),
      ArrowRight: () => walk(1),
      ArrowUp: () => walk(-7),
      ArrowDown: () => walk(7),
      PageUp: () => onMonth(-1),
      PageDown: () => onMonth(1),
      Home: () => { wantFocus.current = true; onSelect(ymdUtc(cells.find((d) => d.getUTCMonth() === month)!)); },
      Escape: () => onSelect(null),
    };
    const fn = moves[e.key];
    if (!fn) return;
    e.preventDefault();
    fn();
  };

  // One tab stop for the whole grid; the arrows do the rest.
  const focusYmd = selected ?? (cells.some((d) => ymdUtc(d) === today) ? today : ymdUtc(cells[0]));
  const weeks = useMemo(() => Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7)), [cells]);
  const dragFrom = drag && (drag.a <= drag.b ? drag.a : drag.b);
  const dragTo = drag && (drag.a <= drag.b ? drag.b : drag.a);

  // What the drag would actually book, said out loud before the dialog opens: the working days it costs, who
  // is already off, and any holiday inside it. Answering that after the form opens is answering it too late.
  const preview = useMemo(() => {
    if (!dragFrom || !dragTo) return null;
    const days = rangeDays(dragFrom, dragTo);
    const working = workingDaysIn(dragFrom, dragTo, workDays, holidaySet);
    const others = new Set<string>();
    for (const d of days) for (const en of byDay.get(d) ?? []) if (!en.mine && en.kind === "leave") others.add(en.empId);
    const holidays = days.map((d) => holidayOn(d)).filter(Boolean);
    return { from: dragFrom, to: dragTo, span: days.length, working, others: others.size, holidays };
  }, [dragFrom, dragTo, workDays, holidaySet, byDay, holidayOn]);

  return (
    <div onKeyDown={onKeyDown}>
      {/* Weekday header, in the org's week order */}
      <div className="grid grid-cols-7 border-b bg-muted/30 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {weekdayOrder(weekStart).map((wd) => (
          <div key={wd} className={cn("py-2", !workDays.includes(wd) && "text-muted-foreground/60")}>
            <span className="sm:hidden">{DOW[wd][0]}</span>
            <span className="hidden sm:inline">{DOW[wd]}</span>
          </div>
        ))}
      </div>

      <div role="grid" aria-label="Leave calendar month grid">
        {weeks.map((week, w) => {
          const from = ymdUtc(week[0]);
          const to = ymdUtc(week[6]);
          const weekEntries = new Map<string, CalEntry>();
          for (const d of week) for (const en of byDay.get(ymdUtc(d)) ?? []) weekEntries.set(en.key, en);
          const segs = layoutStrip([...weekEntries.values()], from, to);
          const hidden = hiddenPerDay(segs, from, MAX_LANES);
          return (
            <div key={w} role="row" className="relative grid grid-cols-7" data-print-keep>
              {week.map((d, i) => {
                const ymd = ymdUtc(d);
                const inMonth = d.getUTCMonth() === month;
                const isToday = ymd === today;
                const nonWorking = !workDays.includes(d.getUTCDay());
                const hol = holidayOn(ymd);
                const closed = closedOn(ymd);
                const celebs = celebrationsOn(ymd);
                const entries = byDay.get(ymd) ?? [];
                const away = awayOn(ymd);
                const remote = entries.some((en) => en.kind === "remote");
                const isSel = selected === ymd;
                const inDrag = !!dragFrom && ymd >= dragFrom && ymd <= dragTo!;
                return (
                  <div key={ymd} role="gridcell" aria-selected={isSel} className="min-w-0">
                    <Tip content={<DayCard ymd={ymd} entries={entries} away={away} total={total} holiday={hol} celebrations={celebs} />}>
                      <button
                        ref={(el) => { if (el) dayRefs.current.set(ymd, el); else dayRefs.current.delete(ymd); }}
                        type="button"
                        tabIndex={ymd === focusYmd ? 0 : -1}
                        aria-label={`${longDate(ymd)}${hol ? `, ${hol.display_name}` : ""}${closed ? `, closed: ${closed}` : ""}, ${away} of ${total} away`}
                        title={canRequest ? "Click a day for detail · drag across days to request leave" : undefined}
                        onMouseDown={() => { suppressClick.current = false; if (canRequest) setDrag({ a: ymd, b: ymd }); }}
                        onMouseEnter={() => setDrag((cur) => (cur ? { ...cur, b: ymd } : cur))}
                        onClick={() => {
                          if (suppressClick.current) { suppressClick.current = false; return; }
                          onSelect(isSel ? null : ymd);
                        }}
                        className={cn(
                          "relative block h-full min-h-[106px] w-full select-none border-b border-r p-1 text-left align-top transition-colors hover:bg-accent/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:min-h-[122px] sm:p-1.5",
                          i === 6 && "border-r-0",
                          !inMonth && "bg-muted/20 text-muted-foreground/50",
                          hol ? "bg-violet-100/60 dark:bg-violet-950/30" : nonWorking && inMonth && "bg-brand-neutral-100/60 dark:bg-muted/50",
                          // A closed period outranks the weekend/holiday wash: it is the one of the three that
                          // changes whether leave can be booked, and it reads across consecutive days as the
                          // single span it is.
                          closed && inMonth && "bg-warning/10",
                          inDrag && "bg-primary/10",
                          isSel && "ring-2 ring-inset ring-primary",
                        )}
                      >
                        <div className="flex items-center gap-1">
                          <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs tabular-nums sm:h-6 sm:w-6 sm:text-sm", isToday && "bg-primary font-semibold text-primary-foreground")}>{d.getUTCDate()}</span>
                          {hol && <span className="truncate text-[10px] font-medium text-violet-700 dark:text-violet-300">{hol.display_name}</span>}
                          {/* Named on the day rather than only in a tooltip: on a month grid the label has
                              room, and a tint nobody can account for is worse than no tint. */}
                          {closed && !hol && <span className="truncate text-[10px] font-medium text-warning-foreground dark:text-warning">{closed}</span>}
                          {celebs.length > 0 && <PartyPopper className="h-3 w-3 shrink-0 text-warning" aria-hidden />}
                          {remote && <Laptop className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />}
                          {away > 0 && (
                            <span className="ml-auto flex shrink-0 items-center gap-0.5 text-[11px] font-medium text-muted-foreground">
                              <Plane className="h-3 w-3" />{away}
                            </span>
                          )}
                        </div>
                        {(hidden.get(ymd) ?? 0) > 0 && (
                          <span className="absolute bottom-1.5 left-1.5 text-[11px] text-muted-foreground">+{hidden.get(ymd)} more</span>
                        )}
                        <CoverStrip away={away} total={total} />
                      </button>
                    </Tip>
                  </div>
                );
              })}

              {/* Bars over the week's cells, out of the pointer's way */}
              <div className="pointer-events-none absolute inset-x-0" style={{ top: LANES_TOP }}>
                {segs.filter((s) => s.lane < MAX_LANES).map((s) => (
                  <Bar key={s.en.key} seg={s} units={7} top={s.lane * LANE_H} />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Live drag readout: what this range would cost and who it collides with */}
      {preview && (
        <div className="sticky bottom-0 flex flex-wrap items-center gap-x-3 gap-y-1 border-t bg-card/95 px-3 py-2 text-sm backdrop-blur" data-print-hide>
          <span className="flex items-center gap-1.5 font-medium"><CalendarPlus className="h-4 w-4 text-primary" />{longDate(preview.from)}{preview.span > 1 ? ` → ${longDate(preview.to)}` : ""}</span>
          <span className="text-muted-foreground">{preview.working} working day{preview.working === 1 ? "" : "s"} of {preview.span}</span>
          {preview.others > 0 && <span className="font-medium text-warning">{preview.others} already off</span>}
          {preview.holidays.length > 0 && <span className="text-violet-600 dark:text-violet-300">includes {preview.holidays.map((h) => h!.display_name).join(", ")}</span>}
          <span className="ml-auto text-xs text-muted-foreground">Release to request</span>
        </div>
      )}
    </div>
  );
}
