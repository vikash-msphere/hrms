import { useCollection } from "@/hooks/useCollection";
import type { LetterheadLogo } from "@/types";

// The org's letterhead catalogue (Settings -> Company -> Logos): the logos letters can be ISSUED on, one per
// legal entity or brand. A letter template names one as its default and the generate dialog can switch it for a
// single document; an org with one brand simply has none of these and every letter carries the organization
// logo.
//
// Names only. The artwork lives in object storage and is a separate fetch per logo (`:image`), which the
// branding editor does because that is where somebody is looking at artwork - a picker shows the names.
export function useLetterheadLogos(opts: { enabled?: boolean } = {}): LetterheadLogo[] {
  const { rows } = useCollection<LetterheadLogo>("letterhead-logos", { enabled: opts.enabled ?? true });
  return rows.filter((l) => l.has_image); // a letterhead with no artwork yet would render as no logo at all
}
