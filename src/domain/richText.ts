// Board post bodies are markdown-lite (see web/src/lib/richText.tsx for the syntax and the renderer). Everything
// that is NOT the card itself wants the prose without the markup: the FTS index, a notification excerpt, the
// dashboard's two-line teaser, a CSV export. This turns one into the other.
//
// Deliberately a stripper rather than a second parser. It cannot drift into disagreeing with the renderer about
// document STRUCTURE, because it makes no structural claims - it removes markers and returns the words. If the
// renderer grows a construct this does not know, the worst case is a stray character in a search snippet.
//
// The one construct it must handle exactly is the attribute line (`{center lg serif}`): those tokens are real
// words, so leaving them in would mean every centred post matches a search for "center".

const ATTR_LINE = /^\{[a-z0-9 _-]*\}$/i;

/**
 * How long a stored rich-text field may be.
 *
 * NOT A PRODUCT RULE - a bound on what the RENDERER can be handed. `web/src/lib/richText.tsx` scans a block
 * with a ten-alternative regex of lazy `[\s\S]+?` runs, which is linear on prose and quadratic on a long run
 * of unmatched openers (for every start position the engine expands the quantifier to the end and fails, once
 * per alternative). These fields had no length cap at all above the 10 MiB request ceiling, so one post of a
 * few hundred thousand `*` froze the tab of everyone who opened the board - stored once by its author, paid
 * for by every reader. The renderer now stops scanning past its own ceiling as well; this is the other half,
 * and the half that keeps the bytes out of the database in the first place.
 *
 * Sized far past real writing: `BODY` is several times the longest announcement the app has stored, and
 * `COMMENT` matches the cap goal comments have carried since they were written (routes/goals.ts), which is
 * where the convention comes from. Keep `BODY` at or under the renderer's MAX_INLINE_SCAN, or a stored body
 * exists that the renderer will only ever half-format.
 */
export const MAX_RICH_BODY = 20_000;
export const MAX_RICH_COMMENT = 4_000;

export function richToPlain(src?: string | null): string {
  if (!src) return "";
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || ATTR_LINE.test(t)) continue;
    if (/^(---|___|\*\*\*)$/.test(t)) continue; // a rule carries no words
    kept.push(
      t
        .replace(/^#{1,3}\s+/, "")
        .replace(/^>\s?/, "")
        .replace(/^[-*]\s+/, "")
        .replace(/^\d+[.)]\s+/, ""),
    );
  }
  return kept
    .join("\n")
    // Links keep their text, not their target: nobody searches a post for the URL it happened to link to.
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, "$1")
    // Emphasis is a run of one character, longest first - `***both***` has to lose all three, not two and a half.
    .replace(/\*\*\*([\s\S]+?)\*\*\*/g, "$1")
    .replace(/\*\*([\s\S]+?)\*\*/g, "$1")
    .replace(/\*([\s\S]+?)\*/g, "$1")
    // The underscore spelling, word-bounded exactly as the renderer bounds it, so `first_name` and `EMP_0042`
    // reach the search index whole rather than as `firstname`.
    .replace(/(?<![\p{L}\p{N}])(_{1,3})([\s\S]+?)\1(?![\p{L}\p{N}])/gu, "$2")
    .replace(/~~([\s\S]+?)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

/** A one-line teaser of a body, for a notification or a list row. */
export function richExcerpt(src: string | null | undefined, max: number): string {
  const text = richToPlain(src).replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}
