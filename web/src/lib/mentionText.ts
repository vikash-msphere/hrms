// What a mention looks like WHILE IT IS BEING TYPED, as against what gets stored.
//
// Stored, a mention is the markdown-lite link shape with the employee's wire id in it (see
// src/domain/mentions.ts), because the server reads that id to decide whom to notify and the renderer reads
// the name to draw the chip. In a plain <textarea> that shape is also what the author sees:
//
//     Nice work [@Ananya Reddy](employees/b9fmbzck9620ty2q4af4rdh72m) on the migration
//
// which is a line of machine address in the middle of a sentence somebody is writing. So the box holds the
// DISPLAY form - `@Ananya Reddy` - and the two functions here convert at the edges: `collapseMentions` when
// existing text is loaded for editing, `expandMentions` when the draft is sent.
//
// Keeping the draft in display form (rather than storing wire text and drawing something else) is what keeps
// the caret honest: the formatting bar, the emoji button and the `@` picker all splice by the textarea's own
// selection offsets, and those offsets are only meaningful against the string the textarea is holding.

/** The stored shape: `[@Name](employees/<26-char wire token>)`. Mirrors MENTION_RE in src/domain/mentions.ts. */
const TOKEN_RE = /\[@([^\]\n]{1,80})\]\(employees\/([0-9a-hj-km-np-tv-z]{26})\)/g;

/** A name the author bound to a particular person, in the order the binding appears in the text. */
export type PickedMention = { name: string; id: string };

/** Stored text to what the author should see, plus the bindings that text carried. */
export function collapseMentions(src?: string | null): { text: string; picked: PickedMention[] } {
  const picked: PickedMention[] = [];
  const text = (src ?? "").replace(TOKEN_RE, (_m, name: string, id: string) => {
    picked.push({ name, id });
    return `@${name}`;
  });
  return { text, picked };
}

/**
 * What the author sees back to what gets stored.
 *
 * A `@name` run becomes a token when the name can be tied to somebody: first from `picked` (who the author
 * actually chose in the picker, which is the only thing that can tell two people with the same name apart),
 * then from `resolve` - a directory lookup that answers only for an unambiguous name. A run that resolves to
 * nobody is left as the plain words it already is: a mention that cannot say WHO is not worth guessing at,
 * since the guess would notify a stranger.
 */
export function expandMentions(text: string, picked: PickedMention[], resolve: (name: string) => string | null): string {
  // One queue per name: the same name bound to two different ids in one draft (two Ananya Reddys) keeps its
  // occurrences in the order they were picked in. Once a queue runs dry, later repeats reuse the last id -
  // naming the same person twice in a post is ordinary, and it is the same person.
  const queues = new Map<string, string[]>();
  for (const p of picked) queues.set(p.name, [...(queues.get(p.name) ?? []), p.id]);
  const idFor = (name: string): string | null => {
    const q = queues.get(name);
    if (q?.length) return q.length > 1 ? q.shift()! : q[0]!;
    return resolve(name);
  };

  let out = "";
  let i = 0;
  for (;;) {
    const at = text.indexOf("@", i);
    if (at < 0) return out + text.slice(i);
    out += text.slice(i, at);
    i = at + 1;
    // A mention starts a word, the same rule the picker completes by: `user@host` is an address.
    const before = at > 0 ? text[at - 1]! : " ";
    if (!/[\s(]/.test(before)) { out += "@"; continue; }
    // The words after the `@` are tried longest first, so "@Ananya Reddy" is read as her rather than as an
    // "@Ananya" with a stray word behind it. Trying candidates against the names we know beats scanning the
    // whole directory for each `@`, and it is what lets a name resolve that this draft never picked - one
    // restored from storage after a reload, or typed out in full.
    let name: string | null = null;
    let id: string | null = null;
    for (const cand of nameCandidates(text, at + 1)) {
      id = idFor(cand);
      if (id) { name = cand; break; }
    }
    if (!name || !id) { out += "@"; continue; }
    out += `[@${name}](employees/${id})`;
    i = at + 1 + name.length;
  }
}

/** How many words a name may run to. Two is the common case; four covers the long ones. */
const MAX_NAME_WORDS = 4;

/** The names that could start at `from`, longest first, with any trailing punctuation trimmed off. */
export function nameCandidates(text: string, from = 0): string[] {
  const ends: number[] = [];
  let i = from;
  for (let word = 0; word < MAX_NAME_WORDS; word++) {
    if (word > 0) {
      // One space between words, and nothing that ends the line: a mention does not run over a newline.
      if (text[i] !== " ") break;
      i += 1;
    }
    const start = i;
    while (i < text.length && !/\s/.test(text[i]!)) i += 1;
    if (i === start) break;
    ends.push(i);
  }
  const out: string[] = [];
  for (const end of ends.reverse()) {
    const raw = text.slice(from, end);
    // "@Ananya Reddy, could you" is a mention of her followed by a comma, so the name is tried both ways.
    const trimmed = raw.replace(/[^\p{L}\p{N}]+$/u, "");
    for (const cand of raw === trimmed ? [raw] : [raw, trimmed]) if (cand && !out.includes(cand)) out.push(cand);
  }
  return out;
}
