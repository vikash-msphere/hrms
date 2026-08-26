import { useEffect, useState } from "react";
import { get } from "@/api";
import { getSetting } from "@/lib/settingsStore";

// Kudos recognition levels (tiers), HR-configurable via the `settings/kudos` blob. Each carries a point weight
// that feeds the "most recognized" leaderboard. Mirrors src/domain/kudos.ts DEFAULT_KUDOS_CONFIG.
export type KudosLevel = { name: string; points: number };

export const DEFAULT_KUDOS_LEVELS: KudosLevel[] = [
  { name: "Appreciation", points: 1 },
  { name: "Impact", points: 2 },
  { name: "Exceptional", points: 3 },
];

const valid = (l: unknown): l is KudosLevel =>
  !!l && typeof (l as KudosLevel).name === "string" && (l as KudosLevel).name.trim().length > 0 && typeof (l as KudosLevel).points === "number";

// Fetch the configured levels (settings/kudos is open-read). Falls back to the defaults until loaded or when no
// config exists. `refreshKey` lets a caller (the Settings editor) force a re-read after saving.
export function useKudosLevels(refreshKey = 0): KudosLevel[] {
  const [levels, setLevels] = useState<KudosLevel[]>(DEFAULT_KUDOS_LEVELS);
  useEffect(() => {
    getSetting<{ levels?: KudosLevel[] }>("kudos")
      .then((s) => {
        const ls = (s.value?.levels ?? []).filter(valid);
        if (ls.length) setLevels(ls);
      })
      .catch(() => { /* keep defaults */ });
  }, [refreshKey]);
  return levels;
}

export const pointsForLevel = (levels: KudosLevel[], name?: string): number => {
  if (!name) return 0;
  const key = name.trim().toLowerCase();
  return levels.find((l) => l.name.trim().toLowerCase() === key)?.points ?? 0;
};

// Kudos categories: a flat, HR-configurable taxonomy (settings/kudos categories), each with an optional icon
// name, a sticker set (`art`, file names in web/public/assets/kudos - see lib/kudosArt.ts) that cards fall back
// to when the giver picked no illustration, and optional example remarks (`prompts`) rotated through the
// give-kudos message placeholder. No built-in defaults - empty until HR adds them (bootstrap seeds ten).
// `refreshKey` forces a re-read after the editor saves.
export type KudosCategory = { name: string; icon?: string; art?: string[]; prompts?: string[] };
export function useKudosCategories(refreshKey = 0): KudosCategory[] {
  const [categories, setCategories] = useState<KudosCategory[]>([]);
  useEffect(() => {
    getSetting<{ categories?: KudosCategory[] }>("kudos")
      .then((s) => setCategories((s.value?.categories ?? []).filter((c): c is KudosCategory => !!c && typeof c.name === "string" && c.name.trim().length > 0)))
      .catch(() => { /* none */ });
  }, [refreshKey]);
  return categories;
}
