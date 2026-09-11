import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { todayStr, addDaysYmd } from "@/lib/orgDay";

// A month grid for picking a date RANGE, built for leave: the thing that decides a request is not the two
// dates, it's what sits between them - which days are already off, which are holidays, and who else on the
// team is away. Two native date inputs can't show any of that, so the range is picked on a calendar that does,
// with the inputs kept alongside for typed/precise entry.
//
// Click a day to start a range, click again to close it (either direction), or press and drag across. Arrow
// keys move a roving focus, Enter/Space picks - so the grid is one tab stop, not sixty.

export type DayInfo = {
  /** Name of the holiday on this day, when there is one. */
  holiday?: string;
  /** A half-day holiday costs 0.5 rather than nothing, so it reads differently. */
  halfHoliday?: boolean;
  /** Teammates already away that day (approved or pending), for the "can we all be off at once" question. */
  away?: string[];
};

const MS_DAY = 86_400_000;
const parse = (ymd: string) => Date.parse(ymd + "T00:00:00Z");
const toYmd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = addDaysYmd;
const startOfMonth = (ymd: string) => ymd.slice(0, 8) + "01";
const addMonths = (ymd: string, n: number) => {
  const d = new Date(parse(startOfMonth(ymd)));
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};
const monthTitle = (ymd: string) => new Date(parse(ymd)).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
const dowOf = (ymd: string) => new Date(parse(ymd)).getUTCDay();
const DOW_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

export function DateRangeCalendar({
  start,
  end,
  onSelect,
  workDays,
  dayInfo,
  minDate,
  months = 2,
  weekStart = 0,
  className,
}: {
  start: string;
  end: string;
  onSelect: (range: { start: string; end: string }) => void;
  workDays: number[];
  dayInfo?: (ymd: string) => DayInfo | undefined;
  /** Earliest selectable day (org policy may forbid back-dating). */
  minDate?: string;
  months?: number;
  /** 0 = weeks start on Sunday, 1 = Monday. */
  weekStart?: number;
  className?: string;
}) {
  // The org's day: this drives the "today" ring and, through the pickers that host it, what counts as
  // back-dating. Reading the browser's day instead let the calendar offer a date the server then refused.
  const today = todayStr();
  const [view, setView] = useState(() => startOfMonth(start || today));
  // Following the selection is right when it comes from outside (a quick pick, a bridge suggestion); it must
  // not fight the user's own paging, so it only re-aims when the chosen start leaves the months on screen.
  useEffect(() => {
    if (!start) return;
    const first = view;
    const last = addMonths(view, months - 1);
    if (start.slice(0, 7) < first.slice(0, 7) || start.slice(0, 7) > last.slice(0, 7)) setView(startOfMonth(start));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start]);

  // Two ways to pick the same range, sharing one anchor: click a day then click the other end, or press and
  // drag across. A press alone must NOT anchor, or the click that follows it would immediately close a
  // one-day range and the click-click path could never reach a second day.
  const [anchor, setAnchor] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const pressedOn = useRef<string | null>(null);
  const dragged = useRef(false);
  const [focusDay, setFocusDay] = useState(() => start || today);
  const cellRefs = useRef(new Map<string, HTMLButtonElement>());

  const preview = useMemo(() => {
    if (anchor && hover) return anchor <= hover ? { start: anchor, end: hover } : { start: hover, end: anchor };
    if (anchor) return { start: anchor, end: anchor };
    return start && end ? { start, end } : null;
  }, [anchor, hover, start, end]);

  const disabled = (ymd: string) => !!minDate && ymd < minDate;

  const orient = (a: string, b: string) => (a <= b ? { start: a, end: b } : { start: b, end: a });

  function pick(ymd: string) {
    if (disabled(ymd)) return;
    // A drag already produced the range; the click that ends it must not start a new one.
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    if (!anchor) {
      setAnchor(ymd);
      onSelect({ start: ymd, end: ymd });
      return;
    }
    setAnchor(null);
    setHover(null);
    onSelect(orient(anchor, ymd));
  }

  function pressDay(ymd: string) {
    if (disabled(ymd)) return;
    pressedOn.current = ymd;
    dragged.current = false;
  }
  // Entering another cell with the button held is a drag: anchor on the day the press started and keep the
  // far end under the pointer.
  function enterDay(ymd: string) {
    setHover(ymd);
    const from = pressedOn.current;
    if (!from || from === ymd || disabled(ymd)) return;
    dragged.current = true;
    if (!anchor) setAnchor(from);
    onSelect(orient(from, ymd));
  }
  function releaseDay(ymd: string) {
    if (dragged.current && pressedOn.current && pressedOn.current !== ymd) {
      setAnchor(null);
      setHover(null);
      if (!disabled(ymd)) onSelect(orient(pressedOn.current, ymd));
    }
    pressedOn.current = null;
  }

  function onKeyDown(e: React.KeyboardEvent, ymd: string) {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (step) {
      e.preventDefault();
      const next = addDays(ymd, step);
      setFocusDay(next);
      if (next.slice(0, 7) !== view.slice(0, 7) && next.slice(0, 7) > addMonths(view, months - 1).slice(0, 7)) setView(addMonths(view, 1));
      if (next.slice(0, 7) < view.slice(0, 7)) setView(addMonths(view, -1));
      requestAnimationFrame(() => cellRefs.current.get(next)?.focus());
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(ymd);
    }
    if (e.key === "Escape" && anchor) {
      e.preventDefault();
      setAnchor(null);
      setHover(null);
    }
  }

  // `cal-*` classes are container-query driven (see index.css): the extra month appears when the calendar
  // itself is wide enough, whatever the window is doing.
  const monthsShown = Array.from({ length: months }, (_, i) => addMonths(view, i));

  return (
    <div
      className={cn("cal-scope select-none rounded-lg border p-3", className)}
      onPointerUp={() => { pressedOn.current = null; }}
      // Releasing outside the grid ends the gesture: clear the drag too, or the next click would be swallowed
      // as if it were the end of one.
      onPointerLeave={() => { pressedOn.current = null; dragged.current = false; setHover(null); }}
    >
      <div className="mb-2 flex items-center gap-1">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => setView(addMonths(view, -1))}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        {/* The titles use the same track layout as the grids below, so each month name sits centred over its
            own month rather than floating somewhere between the two. */}
        <div className={cn("grid flex-1 gap-5 text-center text-sm font-medium", months > 1 && "sm:grid-cols-2")}>
          {monthsShown.map((m, i) => (
            <span key={m} className={cn(i > 0 && "hidden sm:block")}>{monthTitle(m)}</span>
          ))}
        </div>
        <button
          type="button"
          aria-label="Next month"
          onClick={() => setView(addMonths(view, 1))}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {/* Two months side by side from `sm`; a phone gets the current one and the arrows. Seven day columns
          into half a dialog is about 39px each, which still holds a 36px day. */}
      <div className={cn("grid gap-5", months > 1 && "sm:grid-cols-2")}>
        {monthsShown.map((m, i) => (
          <div key={m} className={cn(i > 0 && "hidden sm:block")}>
            <Month
              month={m}
              weekStart={weekStart}
              workDays={workDays}
              dayInfo={dayInfo}
              today={today}
              range={preview}
              focusDay={focusDay}
              disabled={disabled}
              cellRefs={cellRefs}
              onPick={pick}
              onFocusDay={setFocusDay}
              onKey={onKeyDown}
              onHover={enterDay}
              onDragStart={pressDay}
              onDragEnd={releaseDay}
            />
          </div>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-2 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-warning" /> Holiday</span>
        <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-primary/70" /> Someone away</span>
        <span className="flex items-center gap-1.5"><span className="text-muted-foreground/50">15</span> Not a working day</span>
      </div>
    </div>
  );
}

function Month({
  month, weekStart, workDays, dayInfo, today, range, focusDay, disabled, cellRefs, onPick, onHover, onFocusDay, onKey, onDragStart, onDragEnd,
}: {
  month: string;
  weekStart: number;
  workDays: number[];
  dayInfo?: (ymd: string) => DayInfo | undefined;
  today: string;
  range: { start: string; end: string } | null;
  focusDay: string;
  disabled: (ymd: string) => boolean;
  cellRefs: React.MutableRefObject<Map<string, HTMLButtonElement>>;
  onPick: (ymd: string) => void;
  onHover: (ymd: string) => void;
  onFocusDay: (ymd: string) => void;
  onKey: (e: React.KeyboardEvent, ymd: string) => void;
  onDragStart: (ymd: string) => void;
  onDragEnd: (ymd: string) => void;
}) {
  const first = startOfMonth(month);
  const daysInMonth = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const lead = (dowOf(first) - weekStart + 7) % 7;
  const dows = Array.from({ length: 7 }, (_, i) => DOW_SHORT[(i + weekStart) % 7]);

  return (
    <div>
      <div className="grid grid-cols-7 text-center text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {dows.map((d) => <span key={d} className="py-1">{d}</span>)}
      </div>
      {/* No gaps between columns: the selected range is one continuous band drawn on the cell WRAPPERS, with
          only its two ends rounded. The day itself is a circle inside that band, which is what keeps a
          selection reading as one shape instead of seven separate rectangles. */}
      <div className="grid grid-cols-7">
        {Array.from({ length: lead }, (_, i) => <span key={`pad${i}`} />)}
        {Array.from({ length: daysInMonth }, (_, i) => {
          const ymd = addDays(first, i);
          const info = dayInfo?.(ymd);
          const nonWorking = !workDays.includes(dowOf(ymd));
          const inRange = !!range && ymd >= range.start && ymd <= range.end;
          const isStart = range?.start === ymd;
          const isEnd = range?.end === ymd;
          const isEdge = isStart || isEnd;
          // A one-day selection is just the circle; drawing a band behind it only adds a halo.
          const banded = inRange && !(isStart && isEnd);
          const dis = disabled(ymd);
          const away = info?.away ?? [];
          const title = [
            info?.holiday ? `${info.holiday}${info.halfHoliday ? " (half day)" : ""}` : "",
            away.length ? `Away: ${away.slice(0, 4).join(", ")}${away.length > 4 ? ` +${away.length - 4}` : ""}` : "",
          ].filter(Boolean).join(" · ");
          return (
            <div
              key={ymd}
              className={cn(
                "py-0.5",
                banded && "bg-primary/10",
                banded && isStart && "rounded-l-full",
                banded && isEnd && "rounded-r-full",
              )}
            >
              <button
                type="button"
                ref={(el) => { if (el) cellRefs.current.set(ymd, el); else cellRefs.current.delete(ymd); }}
                tabIndex={ymd === focusDay ? 0 : -1}
                disabled={dis}
                title={title || undefined}
                aria-label={`${ymd}${title ? ` - ${title}` : ""}`}
                aria-pressed={inRange}
                onFocus={() => onFocusDay(ymd)}
                onClick={() => onPick(ymd)}
                onPointerDown={() => onDragStart(ymd)}
                onPointerEnter={() => onHover(ymd)}
                onPointerUp={() => onDragEnd(ymd)}
                onKeyDown={(e) => onKey(e, ymd)}
                className={cn(
                  "relative mx-auto flex h-9 w-9 items-center justify-center rounded-full text-sm tabular-nums transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                  // A day off is quieter, not shaded: a fill per weekend and holiday turns the month into a
                  // checkerboard, and the dots below already say which is which.
                  nonWorking && !isEdge && "text-muted-foreground/50",
                  !inRange && !dis && "hover:bg-accent",
                  isEdge && "bg-primary font-medium text-primary-foreground",
                  ymd === today && !isEdge && "font-semibold text-primary ring-1 ring-inset ring-primary/40",
                  dis && "cursor-not-allowed opacity-40 hover:bg-transparent",
                )}
              >
                {Number(ymd.slice(8, 10))}
                {(info?.holiday || away.length > 0) && (
                  <span aria-hidden className="absolute inset-x-0 bottom-1 flex items-center justify-center gap-0.5">
                    {info?.holiday && <span className={cn("h-1 w-1 rounded-full", isEdge ? "bg-primary-foreground/80" : "bg-warning")} />}
                    {away.length > 0 && <span className={cn("h-1 w-1 rounded-full", isEdge ? "bg-primary-foreground/80" : "bg-primary/70")} />}
                  </span>
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
