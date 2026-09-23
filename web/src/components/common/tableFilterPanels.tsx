import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BLANK, DATE_WINDOWS, parseDateFilter, parseNumberFilter, type NumberStats } from "@/lib/tableFilter";

// The insides of a column's filter popover, one panel per filter kind. They are here rather than in
// DataTable.tsx because each is a small stateful form in its own right, and because the same panels serve
// two surfaces: the desktop header popover and the phone "Sort & filter" sheet, which has no column headers
// to hang a popover off. Every panel is controlled - it reads the column's filter string and emits a new one.

const chip = "rounded-full border px-2.5 py-1 text-xs transition-colors hover:bg-accent";
const chipOn = "border-primary bg-primary/10 font-medium text-primary hover:bg-primary/10";

/** One value of a select column, with how many loaded rows carry it. */
export type SelectOption = { value: string; count: number };

/**
 * A select column's values, each with its share of the rows.
 *
 * The count is the point. "Status: Rejected" as a bare option says nothing about whether picking it is worth
 * the click; "Rejected 3" and "Submitted 41" describe the queue before anyone touches it, and a value with a
 * count of zero (offered because the column declared it, e.g. Deleted) reads as the empty drawer it is.
 */
export function SelectFilterPanel({
  options,
  value,
  total,
  blankCount,
  onPick,
}: {
  options: SelectOption[];
  value: string;
  total: number;
  blankCount: number;
  onPick: (next: string) => void;
}) {
  const negated = value.startsWith("!");
  const body = negated ? value.slice(1) : value;
  return (
    <div className="space-y-1">
      <div className="max-h-56 space-y-0.5 overflow-y-auto">
        <OptionRow label="All" count={total} active={!value} onClick={() => onPick("")} />
        {blankCount > 0 && (
          <OptionRow label="(Blank)" count={blankCount} active={body === BLANK} muted onClick={() => onPick(negated && body === BLANK ? "" : BLANK)} />
        )}
        {options.map((o) => (
          <OptionRow
            key={o.value}
            label={o.value}
            count={o.count}
            active={!negated && body === o.value}
            excluded={negated && body === o.value}
            onClick={() => onPick(!negated && body === o.value ? "" : o.value)}
            // Alt-click excludes instead of selecting. The same thing the cell menu's "Exclude" does, put
            // where someone already looking at the value list can reach it without closing the popover.
            onExclude={() => onPick(negated && body === o.value ? "" : `!${o.value}`)}
          />
        ))}
      </div>
      {value && (
        <p className="border-t pt-1.5 text-[11px] leading-snug text-muted-foreground">
          {negated ? "Excluding this value." : "Showing only this value."} Alt-click a value to exclude it instead.
        </p>
      )}
    </div>
  );
}

function OptionRow({
  label,
  count,
  active,
  excluded,
  muted,
  onClick,
  onExclude,
}: {
  label: string;
  count: number;
  active?: boolean;
  excluded?: boolean;
  muted?: boolean;
  onClick: () => void;
  onExclude?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => (e.altKey && onExclude ? onExclude() : onClick())}
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
        active && "bg-accent font-medium text-accent-foreground",
        excluded && "bg-destructive/10 font-medium text-destructive",
      )}
    >
      <span className={cn("min-w-0 flex-1 truncate", muted && !active && !excluded && "text-muted-foreground")}>
        {excluded ? <span className="line-through">{label}</span> : label}
      </span>
      <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{count}</span>
    </button>
  );
}

const OPS = [
  { id: ">", label: ">" },
  { id: ">=", label: "≥" },
  { id: "<", label: "<" },
  { id: "<=", label: "≤" },
  { id: "=", label: "=" },
  { id: "..", label: "between" },
] as const;

/**
 * A numeric column's filter: an operator, a figure, and - before either - what the column actually holds.
 *
 * The stats line is the enrichment. "Filter by Amount" with an empty box asks the reader to know the shape of
 * the data they came here to find out; min / median / max / total answers it in the same popover, and "above
 * the median" turns the most common follow-up ("the big ones") into one click that needs no figure typed.
 */
export function NumberFilterPanel({
  value,
  stats,
  fmt,
  onChange,
}: {
  value: string;
  stats: NumberStats | null;
  fmt: (n: number) => string;
  onChange: (next: string) => void;
}) {
  const parsed = parseNumberFilter(value.startsWith("!") ? value.slice(1) : value);
  const isRange = !!parsed && !("op" in parsed);
  const [mode, setMode] = React.useState<string>(isRange ? ".." : parsed && "op" in parsed ? parsed.op : ">=");
  const one = parsed && "op" in parsed ? String(parsed.n) : "";
  const from = isRange && parsed.from !== undefined ? String(parsed.from) : "";
  const to = isRange && parsed.to !== undefined ? String(parsed.to) : "";

  const emit = (m: string, a: string, b: string) => {
    if (m === "..") {
      const next = a === "" && b === "" ? "" : `${a}..${b}`;
      onChange(next);
      return;
    }
    onChange(a === "" ? "" : `${m}${a}`);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {OPS.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => {
              setMode(o.id);
              // Carry the figure across an operator change: switching > to ≥ should not blank the box.
              if (o.id === "..") emit("..", one || from, to);
              else emit(o.id, one || from, "");
            }}
            className={cn(chip, mode === o.id && chipOn)}
          >
            {o.label}
          </button>
        ))}
      </div>
      {mode === ".." ? (
        <div className="flex items-center gap-1.5">
          <Input type="number" inputMode="decimal" value={from} placeholder="Min" className="h-8" onChange={(e) => emit("..", e.target.value, to)} />
          <span className="text-xs text-muted-foreground">to</span>
          <Input type="number" inputMode="decimal" value={to} placeholder="Max" className="h-8" onChange={(e) => emit("..", from, e.target.value)} />
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <Input
            autoFocus
            type="number"
            inputMode="decimal"
            value={one}
            placeholder="Amount"
            className="h-8"
            onChange={(e) => emit(mode, e.target.value, "")}
          />
          {value && (
            <Button variant="ghost" size="icon" aria-label="Clear the filter" className="h-8 w-8 shrink-0" onClick={() => onChange("")}>
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      )}
      {stats && (
        <div className="space-y-1.5 border-t pt-2">
          <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
            <Stat label="Lowest" value={fmt(stats.min)} />
            <Stat label="Highest" value={fmt(stats.max)} />
            <Stat label="Median" value={fmt(stats.median)} />
            <Stat label="Total" value={fmt(stats.sum)} />
          </dl>
          <div className="flex flex-wrap gap-1">
            <button type="button" className={chip} onClick={() => { setMode(">"); onChange(`>${stats.median}`); }}>
              Above median
            </button>
            <button type="button" className={chip} onClick={() => { setMode("<"); onChange(`<${stats.median}`); }}>
              Below median
            </button>
            <button type="button" className={chip} onClick={() => { setMode("="); onChange("=0"); }}>
              Zero
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt>{label}</dt>
      <dd className="truncate font-medium tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

/**
 * A date column's filter: the windows people actually ask for, then an explicit range underneath.
 *
 * `hint` says which half of the calendar this column lives in - a Created column is asked about the past, a
 * Due column about what is coming - and only reorders the buttons. Both halves stay reachable, because the
 * reverse question ("which of these started before today") is asked often enough to matter.
 */
export function DateFilterPanel({
  value,
  hint,
  onChange,
}: {
  value: string;
  hint?: "past" | "future";
  onChange: (next: string) => void;
}) {
  const negated = value.startsWith("!");
  const body = negated ? value.slice(1) : value;
  const explicit = !DATE_WINDOWS.some((w) => w.id === body) ? parseDateFilter(body) : null;
  const windows = React.useMemo(() => {
    if (!hint) return DATE_WINDOWS;
    const first = hint === "past" ? "past" : "future";
    return [...DATE_WINDOWS].sort((a, b) => Number(b.when === first) - Number(a.when === first));
  }, [hint]);
  const setEnd = (which: "from" | "to", v: string) => {
    const from = which === "from" ? v : (explicit?.from ?? "");
    const to = which === "to" ? v : (explicit?.to ?? "");
    onChange(!from && !to ? "" : `${from}..${to}`);
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {windows.map((w) => (
          <button key={w.id} type="button" className={cn(chip, body === w.id && chipOn)} onClick={() => onChange(body === w.id ? "" : w.id)}>
            {w.label}
          </button>
        ))}
      </div>
      <div className="space-y-1.5 border-t pt-2">
        <div className="flex items-center gap-1.5">
          <Input type="date" value={explicit?.from ?? ""} aria-label="From date" className="h-8" onChange={(e) => setEnd("from", e.target.value)} />
          <span className="text-xs text-muted-foreground">to</span>
          <Input type="date" value={explicit?.to ?? ""} aria-label="To date" className="h-8" onChange={(e) => setEnd("to", e.target.value)} />
        </div>
        {value && (
          <Button variant="ghost" size="sm" className="h-7 w-full text-xs" onClick={() => onChange("")}>
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}
