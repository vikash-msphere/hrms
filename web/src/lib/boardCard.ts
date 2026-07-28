import type { KudosLevel } from "@/lib/kudosLevels";

// Shared board-card presentation: the bits the feed and the composer preview both need, so the preview is the
// same card the wall renders rather than a lookalike that drifts.

// How wide a card actually is on the board. The feed is a centred column with the author's avatar beside each
// card, so the card itself gets what is left. The composer preview renders at exactly this width and scales the
// result down to fit the dialog - anything else would show the author a card of different PROPORTIONS from the
// one they are about to post, which is the one thing a preview must not do.
export const FEED_WIDTH = 960; // the board column
const AUTHOR_COLUMN = 56 + 12; // the avatar column (w-14) plus the row gap (gap-3)
export const CARD_WIDTH = FEED_WIDTH - AUTHOR_COLUMN;

// Kudos accent by level tier (index into the configured levels): a soft card tint + the appreciation-icon
// colour, so a kudo reads as a normal board post with a light recognition accent. Literal class strings (not
// interpolated) so Tailwind's JIT keeps them. Levels past the 4th reuse the top tier.
export const KUDOS_TIERS = [
  { icon: "text-emerald-500", card: "border-emerald-200/70 bg-emerald-50/40 dark:border-emerald-900/50 dark:bg-emerald-950/20" },
  { icon: "text-blue-500", card: "border-blue-200/70 bg-blue-50/40 dark:border-blue-900/50 dark:bg-blue-950/20" },
  { icon: "text-amber-500", card: "border-amber-200/70 bg-amber-50/40 dark:border-amber-900/50 dark:bg-amber-950/20" },
  { icon: "text-violet-500", card: "border-violet-200/70 bg-violet-50/40 dark:border-violet-900/50 dark:bg-violet-950/20" },
];

export function kudosTier(levels: KudosLevel[], level?: string | null) {
  const at = levels.findIndex((l) => l.name.toLowerCase() === (level ?? "").toLowerCase());
  return KUDOS_TIERS[Math.min(Math.max(0, at), KUDOS_TIERS.length - 1)]!;
}
