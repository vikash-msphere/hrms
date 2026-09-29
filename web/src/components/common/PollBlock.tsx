import { Check } from "lucide-react";
import { cn, formatDateTime, relativeFuture } from "@/lib/utils";
import type { Announcement } from "@/types";

const dateTime = (iso?: string | null) => (iso ? formatDateTime(iso) : "");

// A board poll: its options with anonymous tallies, and voting. Results (bars + counts) are revealed only
// after the viewer votes, once the poll closes, or when they can't vote - so a tally never biases an open
// vote. While open and votable, each option is a button (single-choice replaces; multi-choice toggles). The
// caller's own picks are highlighted. stopPropagation so voting on a feed card doesn't unfold the post.
//
// The options are sized to the longest one rather than to the card: a two-word choice does not need a bar across
// the whole post, and on a card with a sticker the space they give back is space the picture can use.
//
// Shared by the feed and the composer preview, which hands it a zero-tally poll built from the options being
// typed - so an author sees the block they are about to post, not an approximation of it. `preview` is what makes
// that true: with no viewer to judge, the ordinary rules would read "this one cannot vote" and reveal the results
// instead, showing the author a row of empty bars and a "voting not available" note that nobody they post to will
// ever see. In preview it shows the unvoted block a reader gets, inert.
export function PollBlock({
  poll,
  canVote,
  canManage,
  preview,
  onVote,
  onSetClosed,
}: {
  poll: NonNullable<Announcement["poll"]>;
  canVote: boolean;
  canManage: boolean;
  preview?: boolean; // the composer's card: show what a reader will get, and let nothing be pressed
  onVote: (option: string) => void;
  onSetClosed: (close: boolean) => void;
}) {
  const { options, total_votes, voted, closed, multiple, closes_time } = poll;
  const interactive = canVote && !closed && !preview;
  const showResults = !preview && (voted || closed || !canVote);
  // Once a poll closes the tallies are final - the leading option(s) get a stronger fill + weight so the
  // outcome reads at a glance instead of asking the viewer to compare percentages.
  const topVotes = closed ? Math.max(0, ...options.map((o) => o.votes)) : 0;
  return (
    <div className="mt-3 space-y-2" onClick={(e) => e.stopPropagation()}>
      {/* The options are only as wide as the longest one needs, and every one of them matches it.
          `w-max` sizes this group to its widest child, and each option is `w-full` inside it - so they come out
          equal without anyone measuring anything. `max-w-full` is the safety rail: an option longer than the
          space available (a narrow card, or the strip left beside a sticker) caps here and wraps its text rather
          than running out of the card. The vote count stays outside the group, on its own full-width line, so a
          long "closes ..." line cannot stretch the boxes.

          The floor is `min(300px, 100%)`, not a flat 300px, because min-width beats max-width: a flat one would
          win over the safety rail and push the options out of a strip narrower than 300px - straight across the
          sticker they were just made narrow to sit beside. Clamped to 100% it is 300px wherever 300px fits, and
          simply the full width where it does not. */}
      <div className="w-max min-w-[min(300px,100%)] max-w-full space-y-2">
        {options.map((o) => {
          const pct = total_votes ? Math.round((o.votes / total_votes) * 100) : 0;
          const leads = closed && o.votes > 0 && o.votes === topVotes;
          if (showResults) {
            return (
              <button
                key={o.id}
                type="button"
                disabled={!interactive}
                onClick={() => interactive && onVote(o.id)}
                className={cn(
                  "relative block w-full overflow-hidden rounded-md border px-3 py-2 text-left text-sm transition-colors",
                  o.voted ? "border-primary/60" : "border-border",
                  interactive ? "cursor-pointer hover:bg-muted/40" : "cursor-default",
                )}
              >
                <span className={cn("absolute inset-y-0 left-0", leads ? "bg-primary/25" : "bg-primary/10")} style={{ width: `${pct}%` }} aria-hidden />
                {/* gap-6 rather than gap-2: this is also what separates the label from the tally when the group
                    is at its natural width, and the two run together without it. */}
                <span className="relative flex items-center justify-between gap-6">
                  <span className={cn("flex items-center gap-1.5", o.voted && "font-semibold text-primary", leads && "font-semibold")}>
                    {o.voted && <Check className="h-3.5 w-3.5 shrink-0" />}
                    {o.label}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{pct}% · {o.votes}</span>
                </span>
              </button>
            );
          }
          return (
            <button
              key={o.id}
              type="button"
              disabled={preview}
              onClick={() => onVote(o.id)}
              className={cn(
                "block w-full rounded-md border px-3 py-2 text-left text-sm font-medium transition-colors",
                preview ? "cursor-default" : "hover:border-primary/60 hover:bg-muted/40",
              )}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
        <span className="tabular-nums">{total_votes} {total_votes === 1 ? "vote" : "votes"}</span>
        {multiple && <span>· pick more than one</span>}
        {/* A deadline reads as a countdown ("closes in 2h") - the exact moment is on hover. */}
        {closed ? <span className="font-medium text-foreground/70">· voting closed · final results</span> : closes_time && <span title={dateTime(closes_time)}>· closes {relativeFuture(closes_time)}</span>}
        {!preview && !canVote && !closed && <span>· voting not available</span>}
        {canManage && (
          <button type="button" onClick={() => onSetClosed(!closed)} className="ml-auto font-medium text-primary hover:underline">
            {closed ? "Reopen" : "Close voting"}
          </button>
        )}
      </div>
    </div>
  );
}
