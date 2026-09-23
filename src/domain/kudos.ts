// Kudos recognition levels (tiers). HR-configurable via the `settings/kudos` blob; this is only the default
// ladder used when no config exists. Each level carries a point weight that feeds the recognition leaderboard
// (summed per recipient). Pure data + a resolver, no I/O.
export type KudosLevel = { name: string; points: number };
// Categories are a flat HR-configurable taxonomy (no weight) for tagging/filtering recognition - distinct from
// the weighted `levels` ladder and the free-text company `value`. Each carries an optional icon NAME (resolved
// to a glyph in the web; see web/src/lib/categoryIcons.tsx) and optional example remarks (`prompts`) the web
// rotates through the give-kudos message placeholder to inspire the giver.
// `art` is the sticker set a category suggests: file NAMES under web/public/assets/kudos (e.g. "good-job.png"),
// not paths or URLs. Stored per category rather than derived from the category name, because the artwork is named
// for what it says ("Good Job!") and not for the category it happens to serve - so renaming either side is a data
// edit in Settings, never a code change.
//
// Picking a category while drafting puts one of its stickers on the card, at random, and offers the rest in the
// picker. That is a real stored pick like any other: the giver can swap it or take it off, and a card renders the
// `illustration` its own row names and nothing else. More than one sticker per category is therefore what keeps
// the wall from repeating a single image.
export type KudosCategory = { name: string; icon?: string; art?: string[]; prompts?: string[] };
export type KudosConfig = { levels: KudosLevel[]; categories?: KudosCategory[] };

export const DEFAULT_KUDOS_CONFIG: KudosConfig = {
  levels: [
    { name: "Appreciation", points: 1 },
    { name: "Impact", points: 2 },
    { name: "Exceptional", points: 3 },
  ],
  categories: [], // no built-in categories - HR defines them in Settings (settings/kudos)
};

// The point weight for a level name in a config (0 when the name isn't a configured level, e.g. blank or a
// level since removed). Trimmed, case-insensitive match so a stored label always maps back to its weight.
export function pointsForLevel(cfg: KudosConfig, level: string | null | undefined): number {
  if (!level) return 0;
  const key = level.trim().toLowerCase();
  return cfg.levels.find((l) => l.name.trim().toLowerCase() === key)?.points ?? 0;
}
