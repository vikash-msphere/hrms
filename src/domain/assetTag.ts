// The human-facing asset tag (e.g. MS-LAP-014) - what a printed sticker says and what a scanner reads back.
// Shape comes from the org's `settings/asset-tags` blob, the middle code comes from the asset's category
// (asset_categories.tag_code), and the trailing sequence is per code: MS-LAP-014 and MS-PHN-014 coexist.
//
// Pure data + helpers, no I/O, mirroring domain/employeeNumber.ts: services/assets.ts reads the settings and
// the tags already in use, this decides what the next one is called. Tags are allocated on create and never
// reused, because a retired asset's sticker may still be stuck to something in a cupboard.
export type AssetTagConfig = {
  prefix: string; // leading org label, e.g. "MS" (may be blank; then the tag starts at the category code)
  separator: string; // joins prefix / category code / sequence, e.g. "-" (may be blank)
  digits: number; // zero-pad width for the sequence, 1-6, e.g. 3 -> "014"
};

export const DEFAULT_ASSET_TAG_CONFIG: AssetTagConfig = { prefix: "", separator: "-", digits: 3 };

/** Code used when an asset has no category. Also the last-resort prefix for an org whose name has no letters. */
export const FALLBACK_TAG_CODE = "AST";

/** The org's initials, used as the tag prefix when the org has not configured one (Mission Sphere -> MS). */
export function orgPrefix(orgName?: string | null): string {
  const initials = (orgName ?? "")
    .split(/\s+/)
    .map((w) => w[0])
    .filter((ch): ch is string => !!ch && /[a-zA-Z0-9]/.test(ch))
    .join("")
    .toUpperCase();
  return initials.slice(0, 4) || FALLBACK_TAG_CODE;
}

/**
 * Resolve the stored (partial, possibly absent) `settings/asset-tags` blob into a complete config.
 *
 * A blank/omitted prefix means "use our initials", so an org that never opens the settings panel still gets
 * recognisable tags rather than bare numbers.
 */
export function normalizeTagConfig(blob: unknown, orgName?: string | null): AssetTagConfig {
  const s = (blob ?? {}) as { prefix?: unknown; separator?: unknown; digits?: unknown };
  const digits = typeof s.digits === "number" && Number.isInteger(s.digits) && s.digits >= 1 && s.digits <= 6 ? s.digits : DEFAULT_ASSET_TAG_CONFIG.digits;
  return {
    prefix: (typeof s.prefix === "string" ? s.prefix.trim() : "") || orgPrefix(orgName),
    separator: typeof s.separator === "string" ? s.separator : DEFAULT_ASSET_TAG_CONFIG.separator,
    digits,
  };
}

/** A category's short code, upper-cased; falls back to the first three letters of its name. */
export function deriveTagCode(name: string): string {
  const letters = name.replace(/[^a-zA-Z0-9]/g, "").slice(0, 3).toUpperCase();
  return letters || FALLBACK_TAG_CODE;
}

/** Compose a tag from the config, the category's code (absent = uncategorised) and a sequence. */
export function formatAssetTag(cfg: AssetTagConfig, tagCode: string | null | undefined, seq: number): string {
  const code = tagCode?.trim().toUpperCase() || FALLBACK_TAG_CODE;
  return [cfg.prefix, code, String(seq).padStart(cfg.digits, "0")].filter(Boolean).join(cfg.separator);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The sequence inside a tag, but only if the tag actually follows this config for this code.
 *
 * Strict on purpose: an HR-typed override ("LOANER-3", an old label off a legacy sticker) must not move the
 * counter for MS-LAP-nnn, or the next generated tag skips a run of numbers nobody printed.
 */
export function seqOf(cfg: AssetTagConfig, tagCode: string | null | undefined, tag: string | null | undefined): number | null {
  if (!tag) return null;
  const code = tagCode?.trim().toUpperCase() || FALLBACK_TAG_CODE;
  const sep = escapeRe(cfg.separator);
  const re = new RegExp(`^${cfg.prefix ? escapeRe(cfg.prefix) + sep : ""}${escapeRe(code)}${sep}(\\d+)$`, "i");
  const m = re.exec(tag.trim());
  return m ? parseInt(m[1]!, 10) : null;
}

/** One past the highest sequence already used for this code; 1 when the code is fresh. */
export function nextSeq(cfg: AssetTagConfig, tagCode: string | null | undefined, existing: Iterable<string | null | undefined>): number {
  let max = 0;
  for (const tag of existing) {
    const s = seqOf(cfg, tagCode, tag);
    if (s !== null && s > max) max = s;
  }
  return max + 1;
}

/**
 * Tags for a RUN of assets created in one act - twenty identical adapters out of one box, or a pasted list of
 * serials - one per entry of `tagCodes`, in order.
 *
 * The whole point is that the run is allocated from ONE view of the tags already in use: nextSeq called in a
 * loop would hand every laptop in the box the same number, because none of them is in the table yet. Runs stay
 * per code (MS-LAP-014 and MS-PHN-014 coexist), so a mixed batch counts each category up separately, and an
 * uncategorised entry falls onto the AST run exactly as a single create would.
 */
export function allocTagRun(cfg: AssetTagConfig, existing: Iterable<string | null | undefined>, tagCodes: (string | null | undefined)[]): string[] {
  const tags = [...existing];
  const next = new Map<string, number>();
  return tagCodes.map((code) => {
    const key = (code?.trim().toUpperCase() || FALLBACK_TAG_CODE);
    const seq = next.get(key) ?? nextSeq(cfg, key, tags);
    next.set(key, seq + 1);
    return formatAssetTag(cfg, key, seq);
  });
}
