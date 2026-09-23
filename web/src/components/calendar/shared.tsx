import type { ReactElement, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { barGeometry, coverOf, dmy, halfLabel, longDate, wash, COVER_BAR, type CalEntry, type Seg } from "@/lib/leaveCalendar";
import type { Celebration, Holiday } from "@/types";

// Pieces every leave-calendar view shares: the cover strip, the hover cards, and the bar itself. Kept here so
// a bar means the same thing (colour = type, dashed = pending, ring = mine, half-width = half day) whichever
// view drew it.

// What a view needs to render a day. Assembled once by the page.
export type ViewProps = {
  byDay: Map<string, CalEntry[]>;
  awayOn: (ymd: string) => number;
  holidayOn: (ymd: string) => Holiday | undefined;
  /**
   * The org-wide closed period covering this day, if any - "Year-end close".
   *
   * Here because the picker learned about policy and this calendar had not: the two then disagreed on the
   * same screen, one refusing a day the other drew as free, and a reader believes whichever agrees with the
   * plan they already had. Two views contradicting each other is worse than neither of them knowing.
   */
  closedOn: (ymd: string) => string | undefined;
  celebrationsOn: (ymd: string) => Celebration[];
  workDays: number[];
  weekStart: number;
  total: number;
  today: string;
  selected: string | null;
  onSelect: (ymd: string | null) => void;
};

/** The cover strip: how much of the in-scope team is away, coloured by how thin that leaves things. */
export function CoverStrip({ away, total }: { away: number; total: number }) {
  const cover = coverOf(away, total);
  if (cover === "none") return null;
  return (
    <span className="pointer-events-none absolute inset-x-0 bottom-0 h-[3px] bg-muted/50" aria-hidden>
      <span className={cn("block h-full", COVER_BAR[cover])} style={{ width: `${Math.min(100, Math.round((away / Math.max(1, total)) * 100))}%` }} />
    </span>
  );
}

/** Wrap one element in a rich hover/focus card. `asChild` keeps the element's own DOM node and styles. */
export function Tip({ content, children }: { content: ReactNode; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="overflow-hidden rounded-lg border bg-popover p-0 text-popover-foreground shadow-lg">{content}</TooltipContent>
    </Tooltip>
  );
}

/** Everything an approver or a colleague wants off a bar without clicking it. */
export function EntryCard({ en }: { en: CalEntry }) {
  const half = halfLabel(en);
  return (
    <div className="min-w-[12rem] max-w-[18rem]">
      <div className="flex items-center gap-2 border-b border-border/60 px-2.5 py-2">
        <PhotoAvatar employeeId={en.empId} name={en.name} photo={en.photo} className="h-7 w-7 text-[10px]" />
        <span className="truncate text-[13px] font-semibold">{en.name}</span>
      </div>
      <div className="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-2.5 py-1.5">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: en.color }} />
        <span className="text-[13px] font-semibold leading-tight">{en.type}</span>
        {en.pending && <span className="ml-auto shrink-0 rounded-full bg-background/70 px-1.5 py-0.5 text-[11px] font-medium text-warning">Pending</span>}
      </div>
      <div className="space-y-1 px-2.5 py-1.5 text-xs text-muted-foreground">
        <p className="text-foreground/80">
          {en.start === en.end ? dmy(en.start) : `${dmy(en.start)} – ${dmy(en.end)}`}
          {half ? ` · ${half === "AM" ? "morning" : "afternoon"}` : ""}
          {en.days ? ` · ${en.days} day${en.days === 1 ? "" : "s"}` : ""}
        </p>
        {en.kind === "remote" && <p>Working remotely - not away.</p>}
        {/* Masked, like the same field on the Leaves page ("The reason is masked in session replay" there, and
            on the request textarea). A leave reason is where "hospital appointment", "bereavement" or a
            treatment name goes; /leave-calendar is deliberately not in SENSITIVE_PAGES - who is off when is
            what a replay of it is for - so the one confidential field on it carries its own tag. */}
        {en.reason && <p className="line-clamp-3 italic" data-sentry-mask>"{en.reason}"</p>}
      </div>
    </div>
  );
}

/** The whole day in one card: who's out, plus what else lands on it. Used where bars can't be hovered. */
export function DayCard({ ymd, entries, away, total, holiday, celebrations }: {
  ymd: string;
  entries: CalEntry[];
  away: number;
  total: number;
  holiday?: Holiday;
  celebrations: Celebration[];
}) {
  const cover = coverOf(away, total);
  return (
    <div className="min-w-[13rem] max-w-[20rem]">
      <div className="border-b border-border/60 px-2.5 py-2">
        <p className="text-[13px] font-semibold leading-tight">{longDate(ymd)}</p>
        {holiday && <p className="mt-0.5 text-xs text-violet-600 dark:text-violet-300">{holiday.display_name}</p>}
      </div>
      <div className={cn("border-b border-border/60 bg-muted/40 px-2.5 py-1.5 text-xs font-medium", cover === "critical" ? "text-destructive" : cover === "heavy" ? "text-warning" : "text-muted-foreground")}>
        {Math.max(0, total - away)} of {total} available
      </div>
      <div className="space-y-1 px-2.5 py-1.5 text-xs">
        {entries.length === 0 && <p className="text-muted-foreground">Nobody away.</p>}
        {entries.slice(0, 8).map((en) => (
          <p key={en.key} className="flex items-center gap-1.5">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: en.color }} />
            <span className="truncate text-foreground/90">{en.name}</span>
            <span className="truncate text-muted-foreground">{en.type}{halfLabel(en) ? ` · ${halfLabel(en)}` : ""}{en.pending ? " · pending" : ""}</span>
          </p>
        ))}
        {entries.length > 8 && <p className="text-muted-foreground">+{entries.length - 8} more</p>}
        {celebrations.map((c) => (
          <p key={`${c.employee}-${c.kind}`} className="text-muted-foreground">🎉 {c.name} · {c.kind === "birthday" ? "birthday" : `${c.years ?? ""} year work anniversary`}</p>
        ))}
      </div>
    </div>
  );
}

/** One bar inside a strip of `units` day-columns. Interactive bars carry their own hover card; inert ones let
 *  the day cells underneath keep click, drag and keyboard (the month grid's whole interaction model). */
export function Bar({ seg, units, top, height = 18, interactive, showType = true, onClick }: {
  seg: Seg;
  units: number;
  top: number;
  height?: number;
  interactive?: boolean;
  showType?: boolean;
  onClick?: () => void;
}) {
  const { en } = seg;
  const { left, width } = barGeometry(seg, units);
  const half = halfLabel(en);
  const className = cn(
    "absolute flex items-center gap-1 overflow-hidden px-1 text-[11px] leading-none text-foreground",
    en.pending ? "rounded-[3px] border border-dashed opacity-80" : "rounded-[3px] border-l-[3px]",
    en.kind === "remote" && "border-dotted",
    seg.cutL && "rounded-l-none border-l-0",
    seg.cutR && "rounded-r-none",
    en.mine && "ring-1 ring-inset ring-primary",
    // Interactive bars opt back INTO pointer events: the overlay they sit in is inert so it can't swallow a
    // drag on the grid underneath.
    interactive && "pointer-events-auto cursor-pointer hover:brightness-95",
  );
  const style = { left: `calc(${left}% + 2px)`, width: `calc(${width}% - 4px)`, top, height, backgroundColor: wash(en.color), borderColor: en.color };
  const body = (
    <>
      <span className="truncate font-medium">{en.short}</span>
      {showType && <span className="truncate text-muted-foreground">{en.type}{half ? ` · ${half}` : ""}</span>}
    </>
  );
  if (!interactive) return <div className={className} style={style}>{body}</div>;
  return (
    <Tip content={<EntryCard en={en} />}>
      <button type="button" onClick={onClick} className={className} style={style} aria-label={`${en.name}, ${en.type}, ${dmy(en.start)} to ${dmy(en.end)}`}>{body}</button>
    </Tip>
  );
}
