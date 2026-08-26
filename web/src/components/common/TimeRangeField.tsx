import * as React from "react";
import { ArrowRight, Clock, Moon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

// A reimagined time-range control: one shared date, a start and end TIME connected by a live duration, with
// quick-set chips and automatic overnight handling (if end <= start the end rolls to the next day). Each time
// field is editable - you can TYPE it ("6:30pm", "18:30", "1830") OR click the clock to PICK from columns; no
// mode toggle. Emits ISO start/end built from the viewer's LOCAL time (same convention as the Events form).

const pad = (n: number) => String(n).padStart(2, "0");
const todayLocal = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const localParts = (iso: string) => { const d = new Date(iso); return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` }; };
const localISO = (date: string, time: string) => new Date(`${date}T${time}:00`).toISOString();
const nextDay = (date: string) => { const d = new Date(`${date}T00:00:00`); d.setDate(d.getDate() + 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const parseMin = (t: string) => { const [h, m] = t.split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const fmtMin = (mins: number) => { const m = ((mins % 1440) + 1440) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };
const durMin = (start: string, end: string) => { let d = parseMin(end) - parseMin(start); if (d <= 0) d += 1440; return d; };
export const fmtDuration = (mins: number) => {
  const d = Math.floor(mins / 1440), rest = mins % 1440;
  const h = Math.floor(rest / 60), m = rest % 60;
  const hm = h && m ? `${h}h ${m}m` : h ? `${h}h` : m ? `${m}m` : "";
  return d ? (hm ? `${d}d ${hm}` : `${d}d`) : hm || "0m";
};
const daysBetween = (a: string, b: string) => Math.round((+new Date(`${b}T00:00:00`) - +new Date(`${a}T00:00:00`)) / 86400000);
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDateLabel = (ymd: string) => { const d = new Date(`${ymd}T00:00:00`); return `${WD[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`; };
const fmt12 = (t: string) => { const [h, m] = t.split(":").map(Number); const ap = (h ?? 0) < 12 ? "AM" : "PM"; const h12 = (h ?? 0) % 12 || 12; return `${h12}:${pad(m ?? 0)} ${ap}`; };

// Parse free-typed time -> "HH:MM" (24h), or null if unintelligible. Accepts "6:30pm", "6 pm", "18:30",
// "1830", "9" etc. AM/PM optional; without it the number is read as 24-hour.
function parseTime(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  const ap = /p\.?m/.test(s) || /\bp\b/.test(s) ? "pm" : /a\.?m/.test(s) || /\ba\b/.test(s) ? "am" : null;
  const m = s.match(/(\d{1,2})\s*[:.]?\s*(\d{2})?/);
  if (!m) return null;
  let h = parseInt(m[1]!, 10);
  const min = m[2] != null ? parseInt(m[2], 10) : 0;
  if (h > 23 || min > 59) return null;
  if (ap) { h = h % 12; if (ap === "pm") h += 12; }
  return `${pad(h)}:${pad(min)}`;
}

const HOURS = Array.from({ length: 12 }, (_, i) => i + 1); // 1..12
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5); // 0,5,...,55
const QUICK = Array.from({ length: 16 }, (_, i) => (i + 1) * 15); // 15-min steps, 15m … 4h

// Recompute an HH:MM (24h) value when one of the 12h parts changes (from the pick columns).
function with12(time: string, part: "h" | "m" | "ap", val: number | "AM" | "PM"): string {
  const [h, m] = time.split(":").map(Number);
  let h12 = (h ?? 0) % 12 || 12;
  let mm = m ?? 0;
  let ap: "AM" | "PM" = (h ?? 0) < 12 ? "AM" : "PM";
  if (part === "h") h12 = val as number;
  else if (part === "m") mm = val as number;
  else ap = val as "AM" | "PM";
  const h24 = (h12 % 12) + (ap === "PM" ? 12 : 0);
  return `${pad(h24)}:${pad(mm)}`;
}

function TimeControl({ value, onChange, alignEnd }: { value: string; onChange: (t: string) => void; alignEnd?: boolean }) {
  const [open, setOpen] = React.useState(false);
  const [text, setText] = React.useState(() => fmt12(value));
  React.useEffect(() => { setText(fmt12(value)); }, [value]); // reflect external changes (pick, quick-set, swap)
  const commit = () => { const p = parseTime(text); onChange(p ?? value); setText(fmt12(p ?? value)); };

  const [hh] = value.split(":").map(Number);
  const h12 = (hh ?? 0) % 12 || 12;
  const mm = Number(value.split(":")[1] ?? 0);
  const ap: "AM" | "PM" = (hh ?? 0) < 12 ? "AM" : "PM";
  const item = (active: boolean) => cn("w-full rounded px-2 py-1 text-center text-sm tabular-nums transition-colors", active ? "bg-primary font-medium text-primary-foreground" : "hover:bg-accent");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* Fluid inside its grid cell on a phone (the cell is already `minmax(0,1fr)`), fixed from `sm` up. */}
      <div className="relative w-full min-w-0 sm:w-36">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }}
          aria-label="Time"
          className="h-10 pr-9 text-center text-base tabular-nums"
        />
        <PopoverTrigger asChild>
          <button type="button" aria-label="Pick time" className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground transition-colors hover:text-foreground">
            <Clock className="h-4 w-4" />
          </button>
        </PopoverTrigger>
      </div>
      <PopoverContent align={alignEnd ? "end" : "start"} className="w-auto p-2">
        <div className="flex gap-1">
          <div className="max-h-44 w-12 space-y-0.5 overflow-y-auto pr-1">{HOURS.map((x) => <button key={x} type="button" className={item(x === h12)} onClick={() => onChange(with12(value, "h", x))}>{x}</button>)}</div>
          <div className="max-h-44 w-12 space-y-0.5 overflow-y-auto pr-1">{MINUTES.map((x) => <button key={x} type="button" className={item(x === mm)} onClick={() => onChange(with12(value, "m", x))}>{pad(x)}</button>)}</div>
          <div className="w-12 space-y-0.5">{(["AM", "PM"] as const).map((x) => <button key={x} type="button" className={item(x === ap)} onClick={() => onChange(with12(value, "ap", x))}>{x}</button>)}</div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function TimeRangeField({ initialStart, initialEnd, onChange, allowEndDate, className }: {
  initialStart?: string;
  initialEnd?: string;
  onChange: (startISO: string, endISO: string) => void;
  // Multi-day ranges: the end-date label becomes pickable, for events like offsites that span days.
  // With an explicit end date the overnight auto-roll is off (any end time is valid on a later day);
  // it stays strictly after the start date - picking the same day collapses back to the derived range.
  allowEndDate?: boolean;
  className?: string;
}) {
  const seed = React.useMemo(() => {
    const s = initialStart ? localParts(initialStart) : { date: todayLocal(), time: "18:00" };
    const e = initialEnd ? localParts(initialEnd) : { date: s.date, time: fmtMin(parseMin(s.time) + 60) };
    // A stored multi-day range seeds an explicit end date - EXCEPT the plain overnight shape (+1 day with
    // end <= start), which stays derived so it keeps the amber-moon treatment.
    const explicit = allowEndDate && e.date > s.date && !(e.date === nextDay(s.date) && parseMin(e.time) <= parseMin(s.time)) ? e.date : null;
    return { date: s.date, start: s.time, end: e.time, endDate: explicit as string | null };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [st, setSt] = React.useState(seed);

  const emit = (next: typeof st) => {
    const endDate = next.endDate ?? (parseMin(next.end) <= parseMin(next.start) ? nextDay(next.date) : next.date);
    onChange(localISO(next.date, next.start), localISO(endDate, next.end));
  };
  const apply = (patch: Partial<typeof st>) => {
    const next = { ...st, ...patch };
    if (next.endDate && next.endDate <= next.date) next.endDate = null; // explicit must be a LATER day
    setSt(next);
    emit(next);
  };

  const minutes = st.endDate ? daysBetween(st.date, st.endDate) * 1440 + (parseMin(st.end) - parseMin(st.start)) : durMin(st.start, st.end);
  const overnight = !st.endDate && parseMin(st.end) <= parseMin(st.start);
  const endDate = st.endDate ?? (overnight ? nextDay(st.date) : st.date);

  return (
    <div className={cn("space-y-3 rounded-lg border bg-muted/20 p-3", className)}>
      {/* Two columns (start | end), each with its date directly above its time; the arrow + duration sit
          between. The end date is editable (start date) on the left and a label on the right that turns amber
          and advances a day when the range crosses midnight. */}
      {/* 18rem of fixed columns plus the gutters needs ~350px, which a 320px phone does not have. The gutter
          tightens first and the columns become fluid below `sm`; the two-column start|end reading is what
          matters, not the exact widths. */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center justify-center gap-x-2 gap-y-1 sm:grid-cols-[9rem_auto_9rem] sm:gap-x-5">
        <Input type="date" value={st.date} onChange={(e) => e.target.value && apply({ date: e.target.value })} aria-label="Date" className="h-8 w-full text-xs tabular-nums sm:w-36" />
        <div />
        {allowEndDate && st.endDate ? (
          <span className="flex items-center gap-1">
            <Input type="date" value={st.endDate} min={nextDay(st.date)} onChange={(e) => e.target.value && apply({ endDate: e.target.value })} aria-label="End date" className="h-8 w-full min-w-0 text-xs tabular-nums sm:w-32" />
            <button type="button" onClick={() => apply({ endDate: null })} title="Back to a same-day range" aria-label="Clear end date" className="text-muted-foreground transition-colors hover:text-foreground">×</button>
          </span>
        ) : (
          <div className="text-center text-xs">
            {(() => {
              const label = overnight
                ? <span className="inline-flex items-center gap-1 font-medium text-amber-600 dark:text-amber-400"><Moon className="h-3 w-3" />{fmtDateLabel(endDate)}</span>
                : <span className="text-muted-foreground/70">{fmtDateLabel(endDate)}</span>;
              return allowEndDate ? (
                <button type="button" onClick={() => apply({ endDate: nextDay(st.date) })} title="Ends on a later day? Pick the end date" className="underline-offset-2 hover:underline">
                  {label}
                </button>
              ) : label;
            })()}
          </div>
        )}

        <TimeControl value={st.start} onChange={(t) => apply({ start: t })} />
        <div className="flex flex-col items-center px-1">
          <ArrowRight className="h-4 w-4 text-muted-foreground" />
          <span className="mt-0.5 whitespace-nowrap text-xs font-medium tabular-nums text-foreground">{fmtDuration(minutes)}</span>
        </div>
        <TimeControl value={st.end} alignEnd onChange={(t) => apply({ end: t })} />
      </div>

      <div className="space-y-2 border-t pt-2.5">
        <span className="block text-[11px] uppercase tracking-wide text-muted-foreground">Quick set</span>
        {/* Sixteen chips. Eight across is right on a desktop popover; on a phone the track lands near
            35px while the widest label ("3h 45m", tabular) needs ~40px, so the pill spills out of its
            own track. Four across on a phone: taller, but every duration is readable and tappable. */}
        <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-8">
          {QUICK.map((q) => (
            <button key={q} type="button" onClick={() => apply({ end: fmtMin(parseMin(st.start) + q), endDate: null })} className="rounded-full bg-muted px-1 py-1 text-center text-[11px] font-medium tabular-nums text-muted-foreground transition-colors hover:bg-primary hover:text-primary-foreground">{fmtDuration(q)}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
