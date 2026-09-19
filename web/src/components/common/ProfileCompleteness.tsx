import { Check, ChevronRight, Plus } from "lucide-react";
import type { Employee } from "@/types";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";

type Flags = NonNullable<Employee["profile_completeness"]>;
export type CompletenessKey = keyof Flags;

/** Fixed checklist order; labels match the tab/section each chip jumps to. */
const ITEMS: { key: CompletenessKey; label: string }[] = [
  { key: "photo", label: "Profile photo" },
  { key: "personal", label: "Personal details" },
  { key: "contact", label: "Contact details" },
  { key: "emergency", label: "Emergency contact" },
  { key: "identity", label: "Identity" },
  { key: "bank", label: "Bank details" },
  { key: "signature", label: "Signature" },
];

/** Slim checklist under/inside a profile page: progress bar + one chip per missing section, each
 *  jumping straight to where it's filled in. Data rides the employee record the page already fetched
 *  (server-computed; owner + HR) - no extra requests. Hides itself once everything is filled.
 *
 *  variant="self" (default) is the /profile nudge ("Complete your profile"); variant="record" is the
 *  neutral HR framing on someone else's page ("Record completeness" - about the record, not the viewer).
 *  Sections the server withheld (flag absent, e.g. signature for non-owners) are left out entirely. */
export function ProfileCompleteness({ flags, onItem, canOpen, variant = "self" }: {
  flags: Flags;
  onItem: (key: CompletenessKey) => void;
  /**
   * Whether this viewer can actually OPEN the section a tile names. Absent = all of them (the self page,
   * where every section is the reader's own).
   *
   * The flags are deliberately broader than the data: the server sends HR "is there an emergency contact on
   * file" as a record-quality signal while the contents stay owner-only (routes/employees.ts). So the count
   * stays honest - HR is the person who chases an empty record, and a tally that hid what they cannot read
   * would say a blank record is nearly done - while a tile whose section will not render for them stops being
   * a button. A jump that lands on a tab with nothing on it is the dead end this avoids.
   */
  canOpen?: (key: CompletenessKey) => boolean;
  variant?: "self" | "record";
}) {
  const items = ITEMS.filter((i) => flags[i.key] !== undefined);
  const missing = items.filter((i) => !flags[i.key]);
  if (missing.length === 0) return null;
  const done = items.length - missing.length;
  const pct = Math.round((done / items.length) * 100);
  return (
    <Card className="mt-4 rounded-2xl">
      <CardContent className="px-5 py-5 sm:px-6 sm:py-[22px]">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[16.5px] font-bold tracking-[-0.01em]">
              {variant === "record" ? "This record is incomplete" : "Finish your profile"}
            </span>
            <span className="text-[13px] text-muted-foreground">
              {missing.length} {missing.length === 1 ? "item is" : "items are"} still missing.
            </span>
          </div>
          {/* The number first and big: the point of the card is how far off you are, and that is one glance. */}
          <span className="flex items-baseline gap-[7px]">
            <span className="text-[22px] font-bold tracking-[-0.02em] text-primary">{pct}%</span>
            <span className="text-[13px] font-medium text-muted-foreground">{done} of {items.length} done</span>
          </span>
        </div>

        {/* One segment per item rather than one filled bar: at six items the segments ARE the checklist, so
            the bar and the tiles below it agree about what is left instead of restating a percentage. */}
        <div
          className="my-4 flex gap-1"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          // One name for both variants: this is the meter's identity, not its heading. The visible heading
          // reframes for HR; what the bar IS does not change.
          aria-label="Profile completeness"
        >
          {items.map((i) => (
            <span key={i.key} className={cn("h-1.5 flex-1 rounded-full transition-colors", flags[i.key] ? "bg-primary" : "bg-muted")} />
          ))}
        </div>

        {/* Tiles, not chips: each one carries what it is AND that it is unfinished, which a pill the width of
            its own label cannot. Done items stay on screen, greyed - a checklist that hides what you have
            finished makes it impossible to see that you are nearly there. */}
        <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(258px,1fr))]">
          {items.map((i) => {
            const complete = !!flags[i.key];
            // A tile the viewer cannot follow is rendered as a plain tile, not a button: it still counts and
            // still says what is missing, which is the whole of what a record-quality signal owes a reader who
            // may not open the section itself.
            const openable = canOpen ? canOpen(i.key) : true;
            const Tile = openable ? "button" : "div";
            return (
              <Tile
                key={i.key}
                {...(openable
                  ? {
                      type: "button" as const,
                      // Named for the SECTION alone. Without this the accessible name is the whole tile -
                      // label plus "Not added yet" - so the button announces its own status as part of its
                      // purpose, and anything looking for "Emergency contact" finds nothing.
                      "aria-label": i.label,
                      onClick: () => onItem(i.key),
                    }
                  : {})}
                className={cn(
                  "flex min-w-0 items-center gap-[11px] rounded-xl border p-[11px] text-left transition-colors",
                  complete ? "border-transparent bg-muted/40" : "bg-card",
                  !complete && openable && "hover:border-primary/40 hover:bg-accent",
                )}
              >
                <span className={cn("flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-lg", complete ? "bg-emerald-100 dark:bg-emerald-950/60" : "bg-primary/10")}>
                  {complete ? <Check className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-300" /> : <Plus className="h-3.5 w-3.5 text-primary" />}
                </span>
                <span className="flex min-w-0 flex-col gap-px">
                  <span className={cn("truncate text-sm font-semibold", complete && "text-muted-foreground")}>{i.label}</span>
                  <span className="truncate text-xs text-muted-foreground">{complete ? "Added" : "Not added yet"}</span>
                </span>
                {/* The chevron is the promise that pressing goes somewhere, so it goes with the button. */}
                {!complete && openable && <ChevronRight className="ml-auto h-[15px] w-[15px] shrink-0 text-muted-foreground" />}
              </Tile>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
