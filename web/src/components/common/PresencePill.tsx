import { cn, formatDate } from "@/lib/utils";
import type { Presence } from "@/types";

// The status pill beside a name, and the callout under the bio when somebody is away.
//
// Derived server-side from approved leave and open attendance sessions (services/presence.ts) - nobody types
// a status here. That is the point: a hand-set status is only ever as true as the last person who remembered
// to change it, and a profile full of stale "in a meeting" badges teaches everyone to ignore the badge.
//
// The leave TYPE never reaches the client, so this can say "on leave" about a medical absence without saying
// anything about it being one.

// Explicit light/dark pairs, the same idiom `badge.tsx` uses. NOT `bg-warning/10 text-warning-foreground`:
// `--warning-foreground` is the ink for text sitting ON the full-strength warning fill, and in dark mode it
// is near-black - on a 10% tint that is unreadable.
const LOOK = {
  on_leave: {
    label: "On leave",
    ring: "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  in: {
    label: "In office",
    ring: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  out: { label: "Not clocked in", ring: "bg-muted text-muted-foreground", dot: "bg-muted-foreground/50" },
} as const;

export function PresencePill({ presence }: { presence: Presence | null }) {
  // Nothing at all until the lazy read lands, rather than a grey placeholder that flips a moment later - the
  // pill sits next to the name, which is the last place on the page that should flicker.
  if (!presence?.state) return null;
  const look = LOOK[presence.state];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-[11px] py-[5px] text-[12.5px] font-semibold", look.ring)}>
      <span className={cn("h-[7px] w-[7px] shrink-0 rounded-full", look.dot)} />
      {look.label}
    </span>
  );
}

/** The "who is covering" callout. Renders only while they are actually away. */
export function PresenceNote({ presence, coveredByName }: { presence: Presence | null; coveredByName?: string }) {
  if (presence?.state !== "on_leave") return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-xl border border-amber-200 bg-amber-50 px-[13px] py-2.5 text-[13.5px] text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
      {presence.until && <span className="font-bold">On leave until {formatDate(presence.until)}.</span>}
      {/* Only when a delegation actually spans today - the absence of cover is not worth a sentence. */}
      {coveredByName && <span>{coveredByName} is covering.</span>}
    </div>
  );
}
