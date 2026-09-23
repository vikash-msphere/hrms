// @mentions inside a board body (a post, a poll question, a kudo message, a reply).
//
// The token is the markdown-lite link shape with an `@` on the label and an employee ref as the target:
//
//     [@Priya Nair](employees/9m4k...)
//
// Two properties fall out of that choice. The NAME is in the source, so the renderer needs no lookup to
// draw the chip and a reader of the raw text still sees who was meant; and `richToPlain` already reduces
// `[text](url)` to its text, so the search index, excerpts and exports read "@Priya Nair" with no extra
// stripping rule.
//
// The ref carries the WIRE token, not the internal id: bodies are authored by the client, and an internal
// id must never travel. The server decodes each token when it decides whom to notify. A rotated
// WIRE_ID_KEY therefore degrades mentions to plain names (the words survive, the notification and the link
// stop resolving) - the accepted trade for keeping internal ids off the wire, and reversible by re-editing
// the post.

// The 26-char base32 wire token (Crockford alphabet - no i/l/o/u), same shape encodeWireIds emits.
const MENTION_RE = /\[@([^\]\n]{1,80})\]\(employees\/([0-9a-hj-km-np-tv-z]{26})\)/g;

// How many people one body may notify. A post that names half the company is a broadcast, and a broadcast
// is what publishing already is - so the cap keeps a mention list from becoming a second, unaudited one.
export const MAX_MENTIONS = 10;

/** The wire tokens mentioned in `src`, deduped and capped (in the order they appear). */
export function mentionedTokens(src?: string | null): string[] {
  if (!src) return [];
  const out: string[] = [];
  for (const m of src.matchAll(MENTION_RE)) {
    const token = m[2]!;
    if (!out.includes(token)) out.push(token);
    if (out.length >= MAX_MENTIONS) break;
  }
  return out;
}

/** The tokens `next` mentions that `prev` did not - what an EDIT should notify (never a re-notify). */
export function newMentions(next?: string | null, prev?: string | null): string[] {
  const before = new Set(mentionedTokens(prev));
  return mentionedTokens(next).filter((t) => !before.has(t));
}
