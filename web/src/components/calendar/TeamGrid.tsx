import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, CalendarOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { COVER_BAR, DOW, coverOf, layoutStrip, longDate, parseYmd, type CalEntry } from "@/lib/leaveCalendar";
import { EmptyState } from "@/components/common/EmptyState";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { Bar, type ViewProps } from "./shared";

// Rows are people, columns are days: the shape that answers "who overlaps whom". The month grid can say a day
// is heavy; only this says it's the same three people out all fortnight. Grouped by department because that is
// the unit cover is actually planned in, and capped at a page of rows because a 400-person org would otherwise
// render 400 rows nobody scrolls.

const ROW_BUDGET = 60;
const NAME_COL = "10rem";

type Row = { empId: string; name: string; photo?: string; mine: boolean; deptId: string; segs: CalEntry[]; days: number };

export function TeamGrid({
  monthDays, entries, employees, awayOn, holidayOn, closedOn, workDays, total, today, selected, onSelect, monthLabel,
  compact, deptName,
}: ViewProps & {
  monthDays: string[];
  entries: CalEntry[];
  employees: number;
  monthLabel: string;
  compact: boolean;
  deptName: (id: string) => string;
}) {
  const [showAll, setShowAll] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  // Compact mode drops the columns nobody works: 22 columns of signal instead of 31 with weekend padding.
  const days = useMemo(
    () => (compact ? monthDays.filter((d) => workDays.includes(new Date(parseYmd(d)).getUTCDay()) && !holidayOn(d)) : monthDays),
    [compact, monthDays, workDays, holidayOn],
  );
  const from = monthDays[0];
  const to = monthDays[monthDays.length - 1];

  // Only people with leave this month get a row; the rest are a footer count, not hundreds of empty lines.
  const rows = useMemo(() => {
    const m = new Map<string, Row>();
    for (const en of entries) {
      if (en.end < from || en.start > to) continue;
      const r = m.get(en.empId) ?? { empId: en.empId, name: en.name, photo: en.photo, mine: en.mine, deptId: en.deptId, segs: [], days: 0 };
      r.segs.push(en);
      r.days += en.days || 0;
      m.set(en.empId, r);
    }
    return [...m.values()].sort((a, b) => Number(b.mine) - Number(a.mine) || a.name.localeCompare(b.name));
  }, [entries, from, to]);

  // Department groups, biggest first; a person with no department lands in one honest "No department" group.
  const groups = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const r of rows) {
      const list = m.get(r.deptId);
      if (list) list.push(r);
      else m.set(r.deptId, [r]);
    }
    return [...m.entries()]
      .map(([id, list]) => ({ id, label: id ? deptName(id) : "No department", rows: list, days: list.reduce((n, r) => n + r.days, 0) }))
      .sort((a, b) => b.rows.length - a.rows.length || a.label.localeCompare(b.label));
  }, [rows, deptName]);

  const shown = showAll ? rows.length : ROW_BUDGET;
  const cols = { gridTemplateColumns: `${NAME_COL} repeat(${days.length}, minmax(0, 1fr))` } as const;
  // A closed period outranks both the holiday and the weekend wash: of the three it is the only one that
  // changes whether leave can be booked, and this grid is read to decide exactly that. One function, so the
  // header, the cover row and every person's row agree about which columns are shut.
  const dayTint = (ymd: string) =>
    closedOn(ymd) ? "bg-warning/15"
      : holidayOn(ymd) ? "bg-violet-100/60 dark:bg-violet-950/30"
        : !workDays.includes(new Date(parseYmd(ymd)).getUTCDay()) ? "bg-brand-neutral-100/60 dark:bg-brand-neutral-800/30" : "";

  if (rows.length === 0) {
    return (
      <div className="p-4">
        <EmptyState icon={CalendarOff} title={`No leave in ${monthLabel}`} description="Nobody in this scope has leave booked this month." />
      </div>
    );
  }

  // Bars are positioned against the visible columns, so compact mode has to lay them out against the compacted
  // day list - a bar spanning a dropped weekend closes up rather than pointing at a column that isn't there.
  const segsFor = (r: Row) =>
    compact
      ? r.segs.flatMap((en) => {
          // In compact mode a leave becomes one segment per RUN of visible days it covers.
          const idx = days.map((d, i) => ({ d, i })).filter(({ d }) => d >= en.start && d <= en.end);
          const runs: { i: number; span: number }[] = [];
          for (const { i } of idx) {
            const last = runs[runs.length - 1];
            if (last && last.i + last.span === i) last.span++;
            else runs.push({ i, span: 1 });
          }
          return runs.map((run) => ({
            en, i: run.i, span: run.span,
            cutL: days[run.i] > en.start, cutR: days[run.i + run.span - 1] < en.end, lane: 0,
          }));
        })
      : layoutStrip(r.segs, days[0], days[days.length - 1]).map((s) => ({ ...s, lane: 0 }));

  let rendered = 0;
  return (
    <div className="scroll-shadow-x [--scroll-ground:hsl(var(--card))] overflow-x-auto">
      <div className="min-w-[52rem]">
        {/* Day header */}
        <div className="grid border-b bg-card" style={cols}>
          <div className="sticky left-0 z-10 bg-card px-2 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {rows.length} {rows.length === 1 ? "person" : "people"}
          </div>
          {days.map((ymd) => {
            const d = new Date(parseYmd(ymd));
            return (
              <button
                key={ymd}
                type="button"
                onClick={() => onSelect(selected === ymd ? null : ymd)}
                title={closedOn(ymd) ? `${longDate(ymd)} · Closed: ${closedOn(ymd)}` : longDate(ymd)}
                className={cn("flex flex-col items-center py-1 text-[10px] leading-tight transition-colors hover:bg-accent/50", dayTint(ymd), selected === ymd && "ring-1 ring-inset ring-primary")}
              >
                <span className="text-muted-foreground">{DOW[d.getUTCDay()][0]}</span>
                <span className={cn("flex h-4 w-4 items-center justify-center rounded-full tabular-nums", ymd === today && "bg-primary font-semibold text-primary-foreground")}>{d.getUTCDate()}</span>
              </button>
            );
          })}
        </div>

        {/* Cover row: the month's staffing read in one line */}
        <div className="grid border-b bg-muted/20" style={cols}>
          <div className="sticky left-0 z-10 bg-card px-2 py-1 text-[11px] text-muted-foreground">Away</div>
          {days.map((ymd) => {
            const away = awayOn(ymd);
            return (
              <div key={ymd} className={cn("relative flex h-6 items-end justify-center", dayTint(ymd))} title={`${away} of ${total} away`}>
                {away > 0 && (
                  <span
                    className={cn("w-2/3 rounded-t-sm", COVER_BAR[coverOf(away, total)])}
                    style={{ height: `${Math.max(12, Math.min(100, (away / Math.max(1, total)) * 100))}%` }}
                  />
                )}
              </div>
            );
          })}
        </div>

        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.id);
          return (
            <div key={g.id || "none"} data-print-keep>
              <button
                type="button"
                onClick={() => setCollapsed((s) => { const n = new Set(s); if (!n.delete(g.id)) n.add(g.id); return n; })}
                className="sticky left-0 flex w-full items-center gap-1.5 border-b bg-muted/30 px-2 py-1 text-left text-xs font-medium"
                aria-expanded={!isCollapsed}
              >
                {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                {g.label}
                <span className="text-muted-foreground">· {g.rows.length} away · {Math.round(g.days * 10) / 10} days</span>
              </button>
              {!isCollapsed && g.rows.map((r) => {
                if (rendered >= shown) return null;
                rendered++;
                return (
                  <div key={r.empId} className={cn("relative grid items-center border-b last:border-b-0", r.mine && "bg-primary/5")} style={cols}>
                    <div className="sticky left-0 z-10 flex min-w-0 items-center gap-2 bg-card px-2 py-1.5">
                      <PhotoAvatar employeeId={r.empId} name={r.name} photo={r.photo} className="h-6 w-6 text-[10px]" />
                      <span className="truncate text-xs font-medium">{r.name}</span>
                    </div>
                    {days.map((ymd, i) => (
                      <div key={ymd} className={cn("h-8", dayTint(ymd), selected === ymd && "bg-primary/10")} style={{ gridColumn: i + 2, gridRow: 1 }} />
                    ))}
                    {/* Bars sit over the day columns only (never the name column), positioned as a share of them */}
                    <div className="pointer-events-none absolute inset-y-0 right-0" style={{ left: NAME_COL }}>
                      {segsFor(r).map((s, i) => (
                        <Bar
                          key={`${s.en.key}-${i}`}
                          seg={s}
                          units={days.length}
                          top={6}
                          height={20}
                          interactive
                          showType={false}
                          onClick={() => onSelect(s.en.start > days[0] ? s.en.start : days[0])}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}

        {!showAll && rows.length > ROW_BUDGET && (
          <button type="button" onClick={() => setShowAll(true)} className="w-full border-t px-2 py-2 text-sm font-medium text-primary hover:bg-accent/40">
            Show all {rows.length} people ({rows.length - ROW_BUDGET} more)
          </button>
        )}
        {employees > rows.length && (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            {employees - rows.length} other {employees - rows.length === 1 ? "person has" : "people have"} no leave booked in {monthLabel}.
          </p>
        )}
      </div>
    </div>
  );
}
