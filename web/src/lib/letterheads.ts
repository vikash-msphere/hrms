import { useCollection } from "@/hooks/useCollection";
import { useOrg } from "@/lib/org";
import type { Letterhead } from "@/types";

// The org's letterhead catalogue (Settings -> Company -> Logos): the stationery documents are ISSUED on, one
// per legal entity or brand. A letter template names one as its default and the generate dialog can switch it
// for a single document; an org with one brand simply has none of these and every document prints on the stock
// page with the organization logo.
//
// Names only. The artwork lives in object storage and is a separate fetch per row (`:image`), which the
// branding editor does because that is where somebody is looking at artwork - a picker shows the names.
/**
 * Does the letterhead a given document kind is issued on have a PRINT version? Answers the one question a
 * PDF viewer needs: offer the Screen/Print switch, or a single Save.
 *
 * Best-effort by design. It reads the org's per-kind choice and the catalogue, and a reader without
 * `letterheads.read` (a recruiter opening an offer) simply gets `false` - one button, which is the honest
 * answer for someone who cannot be shown the alternative anyway.
 */
export function useHasPrintVersion(kind: "letter" | "payslip" | "form16" | "offer" | "review"): boolean {
  const { org } = useOrg();
  const rows = useLetterheads();
  const ref = org.document_logos?.[kind];
  if (!ref) return false;
  const row = rows.find((l) => l.path === ref);
  return !!row && (!!row.print_design || Object.keys((row.assets ?? {}) as Record<string, unknown>).includes("print"));
}

export function useLetterheads(opts: { enabled?: boolean } = {}): Letterhead[] {
  const { rows } = useCollection<Letterhead>("letterheads", { enabled: opts.enabled ?? true });
  // Every row, including one that is still just a name: somebody made it deliberately, and a picker that
  // silently omits what was just created is worse than one offering a letterhead that currently renders as the
  // stock page.
  return rows;
}
