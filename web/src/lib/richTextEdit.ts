import { NAME_FONTS } from "./fonts";

// The text transforms behind the composer's formatting bar, and the attribute-line grammar they share with the
// renderer (lib/richText.tsx).
//
// Every command here is a pure function of the source and the selection: `(value, selection) -> {value, selection}`.
// That is the whole design of the editor - the box is a plain textarea holding markdown-lite source, a button is a
// text transform, and what is stored is exactly what is shown. It also means the interesting part is testable
// without a DOM, which is why it lives here rather than inside the component: what a button does to `- one\n- two`
// with the caret in the middle is not something to find out by clicking.
//
// Dependency-free apart from the font table (data, not UI), so the worker test project can reach it the same way
// it reaches splitSource.

export type Sel = [number, number];
/** What a command hands back: the new source, and where the selection should end up in it. */
export type Edit = { value: string; selection: Sel };

// ---- The attribute line ------------------------------------------------------------------------------------
// Markdown proper has no alignment, no type size and no typeface, so those ride on a line of nothing but `{...}`
// tokens that applies to the block below it. Tokens come from fixed vocabularies and anything unrecognised is
// dropped, which is what keeps a feed coherent - an author picks from the design system's ramp rather than naming
// a font or a colour.

/** The vocabularies the toolbar offers, in the order it offers them. */
export const RICH_ALIGNMENTS = ["left", "center", "right", "justify"] as const;
export const RICH_SIZES = ["sm", "base", "lg"] as const;
// The typefaces the app already loads, shared with the organization wordmark (lib/fonts.ts). "default" is the UI
// font and is expressed by having no face token at all, so it is not one of the choices here.
export const RICH_FACES = NAME_FONTS.filter((f) => f.value !== "default").map((f) => f.value);

export type RichAlign = (typeof RICH_ALIGNMENTS)[number];
export type RichSize = (typeof RICH_SIZES)[number];
export type RichFace = string;
export type RichAttrs = { align?: RichAlign; size?: RichSize; face?: RichFace; muted?: boolean };

const ALIGN_KEYS = new Set<string>(RICH_ALIGNMENTS);
const SIZE_KEYS = new Set<string>(RICH_SIZES);
const FACE_KEYS = new Set(RICH_FACES);
const ATTR_LINE = /^\{([a-z0-9 _-]*)\}$/i;

/** Whether a line is markup for the block below it rather than words of its own. */
export const isAttrLine = (line: string) => ATTR_LINE.test(line.trim());

/** `{center lg serif}` -> attrs, or null when the line is ordinary text. */
export function parseAttrLine(line: string): RichAttrs | null {
  const m = ATTR_LINE.exec(line.trim());
  if (!m) return null;
  const attrs: RichAttrs = {};
  for (const raw of m[1]!.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (ALIGN_KEYS.has(raw)) attrs.align = raw as RichAlign;
    else if (SIZE_KEYS.has(raw)) attrs.size = raw as RichSize;
    else if (FACE_KEYS.has(raw)) attrs.face = raw;
    else if (raw === "muted") attrs.muted = true;
  }
  return attrs;
}

/** attrs -> `{center lg serif}`, or "" when nothing is set (the line is then dropped entirely). */
export function formatAttrLine(attrs: RichAttrs): string {
  const tokens = [attrs.align, attrs.size, attrs.face, attrs.muted ? "muted" : ""].filter(Boolean);
  return tokens.length ? `{${tokens.join(" ")}}` : "";
}

// ---- Inline marks ------------------------------------------------------------------------------------------

/** How many of `ch` run together at one end of `text`. */
function runLength(text: string, ch: string, at: "start" | "end"): number {
  let n = 0;
  if (at === "end") while (n < text.length && text[text.length - 1 - n] === ch) n++;
  else while (n < text.length && text[n] === ch) n++;
  return n;
}

/**
 * What `marker` is doing at `sel`, and where the words inside it start and end.
 *
 * Emphasis is a RUN of one character - `*`, `**` and `***` are the same character three ways - so the state is
 * read off the LENGTH of the run on either side rather than by matching the marker as a string. A run of one is
 * italic, two is bold, three is both. That is what makes the two buttons independent: Italic on `**bold**` adds a
 * star to each side instead of stripping one off, and Bold on `***both***` takes two off and leaves italic - and
 * it is what lets an empty pair be recognised and removed however many markers are stacked at the caret.
 */
function markState(value: string, sel: Sel, marker: string): { s: number; e: number; on: boolean } {
  const ch = marker[0]!;
  // Marker characters at the edges of the selection belong to the mark, not to the words: selecting `**bold**` and
  // selecting the `bold` inside it are the same request.
  let s = sel[0];
  let e = sel[1];
  while (s < e && value[s] === ch) s++;
  while (e > s && value[e - 1] === ch) e--;
  const run = Math.min(runLength(value.slice(0, s), ch, "end"), runLength(value.slice(e), ch, "start"));
  // A two-character marker is on from two upwards; the one-character one is on whenever the run is odd, which is
  // exactly what leaves `**bold**` un-italic and `***both***` italic.
  return { s, e, on: marker.length === 2 ? run >= 2 : run % 2 === 1 };
}

/** Whether the selection is already inside `marker` - what the bar shows as pressed. */
export const markActive = (value: string, sel: Sel, marker: string) => markState(value, sel, marker).on;

/**
 * Toggle `marker` over the selection. With an empty selection this inserts the pair and leaves the caret between
 * them, so the next keystroke comes out formatted and not one character of existing text is touched - and pressing
 * again with the caret still there takes the pair back off.
 */
export function toggleMark(value: string, sel: Sel, marker: string): Edit {
  const len = marker.length;
  const { s, e, on } = markState(value, sel, marker);
  // Taking a mark off removes `len` characters from each side of the words, which on a longer run leaves the rest
  // of it standing: `***both***` un-bolded is `*both*`, still italic.
  if (on) return { value: value.slice(0, s - len) + value.slice(s, e) + value.slice(e + len), selection: [s - len, e - len] };
  return { value: value.slice(0, s) + marker + value.slice(s, e) + marker + value.slice(e), selection: [s + len, e + len] };
}

/** `[text](https://)`, with the caret left on whichever half still needs typing. */
export function insertLink(value: string, sel: Sel): Edit {
  const [start, end] = sel;
  const text = value.slice(start, end);
  const next = `${value.slice(0, start)}[${text}](https://)${value.slice(end)}`;
  // With text selected the URL is what still needs typing, so the caret lands there. With nothing selected the
  // label is typed first, so it lands between the brackets.
  const urlAt = start + text.length + 3 + 8;
  return { value: next, selection: text ? [urlAt, urlAt] : [start + 1, start + 1] };
}

// ---- Lines and blocks --------------------------------------------------------------------------------------

/** The line prefixes the block buttons write, and what each one looks like once written. */
export type Prefix = "ul" | "ol" | "quote" | "h";
const MARKED: Record<Prefix, RegExp> = { ul: /^[-*]\s+/, ol: /^\d+[.)]\s+/, quote: /^>\s?/, h: /^#{1,3}\s+/ };
// Any of them, for taking one off before putting another on - a line carries one marker, not a stack of them.
const ANY_PREFIX = /^\s*(?:[-*]\s+|\d+[.)]\s+|>\s?|#{1,3}\s+)/;
const prefixFor = (kind: Prefix, n: number) => (kind === "ul" ? "- " : kind === "ol" ? `${n}. ` : kind === "quote" ? "> " : "## ");
// What Enter reads off the line it is pressed on, kept in parts so the next line can repeat it: the indent, the
// bullet character, a number with the punctuation that followed it, or a quote mark.
const LINE_MARKER = /^(\s*)(?:([-*])\s+|(\d+)([.)])\s+|(>)\s?)/;

/** Index of the line containing character offset `caret`. */
function lineAt(lines: string[], caret: number): number {
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    pos += lines[i]!.length;
    if (caret <= pos) return i;
    pos += 1; // the newline
  }
  return Math.max(0, lines.length - 1);
}

/** Character offset where line `i` starts. */
function lineStart(lines: string[], i: number): number {
  let pos = 0;
  for (let k = 0; k < i; k++) pos += lines[k]!.length + 1;
  return pos;
}

/** The lines the selection touches. A selection that stops at the very start of a line has not reached into it. */
function selectedLines(lines: string[], sel: Sel): [number, number] {
  const from = lineAt(lines, sel[0]);
  let to = lineAt(lines, sel[1]);
  if (sel[1] > sel[0] && to > from && lineStart(lines, to) === sel[1]) to--;
  return [from, to];
}

/**
 * Which block a line belongs to, by the SAME markers the renderer splits on (lib/richText.tsx's parse loop).
 *
 * A block boundary is not only a blank line. The renderer closes the paragraph it is building whenever a line
 * opens a heading, a rule, a quote or a list, so `## Title` followed straight away by a sentence is two blocks
 * on the page even with nothing between them - and a run of lines is one block only while every line reads as
 * the same kind.
 */
type LineKind = "h" | "hr" | "quote" | "ul" | "ol" | "p";
const lineKind = (line: string): LineKind => {
  const t = line.trim();
  if (/^(---|___|\*\*\*)$/.test(t)) return "hr";
  if (/^#{1,3}\s+/.test(t)) return "h";
  if (/^>\s?/.test(t)) return "quote";
  if (/^[-*]\s+/.test(t)) return "ul";
  if (/^\d+[.)]\s+/.test(t)) return "ol";
  return "p";
};

/**
 * Grow a line index out to its whole block. "The block the caret is in" has to mean the same thing here as it
 * does on the page, or a block command lands on the wrong words: a caret in the sentence under a heading used
 * to grow across the heading (nothing but a blank line stopped the walk), so picking a typeface for that
 * sentence wrote the attribute above the HEADING and restyled the heading instead - leaving the sentence, the
 * one thing the reader had the caret in, untouched.
 */
function blockAround(lines: string[], line: number): [number, number] {
  const here = lines[line] ?? "";
  // A caret on a blank line is between blocks, which is to say it is at the start of the one about to be written.
  // That empty line is the block: walking out from it would reach back into the paragraph ABOVE and format that
  // instead - the finished text, rather than the text this is being pressed for.
  if (here.trim() === "") return [line, line];
  // An attribute line decorates the block UNDER it (that is how the renderer reads it), so a caret parked on one
  // is a caret in that block.
  if (isAttrLine(here) && (lines[line + 1] ?? "").trim() !== "" && !isAttrLine(lines[line + 1] ?? "")) {
    return blockAround(lines, line + 1);
  }
  const kind = lineKind(here);
  let first = line;
  let last = line;
  // A heading and a rule are a line each: two headings in a row are two blocks, never one to format together.
  if (kind !== "h" && kind !== "hr") {
    const joins = (i: number) => {
      const l = lines[i] ?? "";
      return l.trim() !== "" && !isAttrLine(l) && lineKind(l) === kind;
    };
    while (first > 0 && joins(first - 1)) first--;
    while (last < lines.length - 1 && joins(last + 1)) last++;
  }
  return [first, last];
}

/** Every block the selection touches, first to last. A collapsed caret yields the one block it sits in. */
function selectedBlocks(lines: string[], sel: Sel): [number, number][] {
  const [from, to] = selectedLines(lines, sel);
  const out: [number, number][] = [];
  let i = from;
  while (i <= to) {
    if (lines[i]!.trim() === "") { i++; continue; }
    const block = blockAround(lines, i);
    out.push(block);
    i = block[1] + 1;
  }
  return out.length ? out : [blockAround(lines, from)];
}

/** How many characters of line marker a line opens with - `- `, `1. `, `> `, `## ` and their indent. */
const prefixLength = (line: string) => ANY_PREFIX.exec(line)?.[0]!.length ?? 0;

/**
 * Finish a line-structured rewrite, carrying the caret with the WORDS it was next to.
 *
 * A single length delta will not do: a command that prefixes three lines moves a caret in the FIRST of them by two
 * characters, not by six. Measuring against the line's marker instead is what keeps the caret where the author
 * left it - and puts it after the marker, not in front of it, when they were at the head of the line and a marker
 * has just been written there. `map` says where each original line ended up, so a command that splices whole lines
 * in or out (setAttrs, with its attribute lines) is carried too.
 */
function editLines(before: string[], after: string[], map: number[], sel: Sel): Edit {
  const at = (pos: number) => {
    let i = 0;
    let acc = 0;
    while (i < before.length - 1 && acc + before[i]!.length < pos) {
      acc += before[i]!.length + 1;
      i++;
    }
    const col = pos - acc;
    const j = Math.max(0, Math.min(map[i] ?? 0, after.length - 1));
    let out = 0;
    for (let k = 0; k < j; k++) out += after[k]!.length + 1;
    const line = after[j] ?? "";
    const was = prefixLength(before[i] ?? "");
    const now = prefixLength(line);
    // Inside the marker (or at the head of the line) with the marker itself changing: the words are what was
    // meant, so the caret sits at their start. Anywhere else it keeps its distance from them.
    const moved = col <= was && now !== was ? now : col + (now - was);
    return out + Math.max(0, Math.min(line.length, moved));
  };
  return { value: after.join("\n"), selection: [at(sel[0]), at(sel[1])] };
}

/**
 * The lines a prefix button acts on: the selected ones, minus attribute lines (markup for the block, not prose)
 * and minus the blank lines between paragraphs (a bulleted blank line is an empty list item nobody asked for). A
 * caret parked on a blank line is starting a list there, so that one line stays a target.
 */
function prefixTargets(lines: string[], sel: Sel): number[] {
  const [from, to] = selectedLines(lines, sel);
  const range: number[] = [];
  for (let i = from; i <= to; i++) if (!isAttrLine(lines[i] ?? "")) range.push(i);
  const written = range.filter((i) => lines[i]!.trim() !== "");
  return written.length ? written : range;
}

/** Whether every line the selection touches already carries this prefix - what the bar shows as pressed. */
export function prefixActive(value: string, sel: Sel, kind: Prefix): boolean {
  const lines = value.split("\n");
  const targets = prefixTargets(lines, sel);
  return targets.length > 0 && targets.every((i) => MARKED[kind].test(lines[i]!.trim()));
}

/**
 * Toggle a line prefix (`- `, `1. `, `> `, `## `) across the selected LINES. Per line rather than per block, so
 * bulleting three lines of a paragraph gives three bullets - which is also exactly reversible, since the renderer
 * decides every construct by how a line starts.
 */
export function togglePrefix(value: string, sel: Sel, kind: Prefix): Edit {
  const lines = value.split("\n");
  const targets = prefixTargets(lines, sel);
  if (!targets.length) return { value, selection: sel };
  // Marked everywhere already -> the button removes it; otherwise it applies to all of them.
  const already = targets.every((i) => MARKED[kind].test(lines[i]!.trim()));
  const next = [...lines];
  let n = 0;
  let prev = -2;
  for (const i of targets) {
    if (i !== prev + 1) n = 0; // a gap ends the list, and the next one starts counting again
    prev = i;
    const bare = lines[i]!.replace(ANY_PREFIX, "");
    next[i] = already ? bare : prefixFor(kind, ++n) + bare;
  }
  return editLines(lines, next, lines.map((_, i) => i), sel);
}

/**
 * Enter inside a list item or a quote opens the next one, the way every editor with these does - typing a list
 * should not mean typing its markers. An item with nothing in it ends the list instead: that Enter is how an
 * author says they are done, and answering with another empty bullet is a loop they have to back out of.
 *
 * Returns null when there is nothing to continue, which is Enter's ordinary job and belongs to the textarea.
 */
export function continueList(value: string, caret: number): Edit | null {
  const from = value.lastIndexOf("\n", caret - 1) + 1;
  const nl = value.indexOf("\n", caret);
  const to = nl === -1 ? value.length : nl;
  const m = LINE_MARKER.exec(value.slice(from, to));
  // Nothing to continue, or the caret is inside the marker itself - splitting THAT is just a newline.
  if (!m || caret < from + m[0]!.length) return null;
  if (!value.slice(from + m[0]!.length, to).trim()) return { value: value.slice(0, from) + value.slice(to), selection: [from, from] };
  // A number is carried on rather than repeated. The rendered list numbers itself, so this is only what the author
  // reads back in the box - but reading `1.` four times over would be a bar that cannot count.
  const marker = m[2] ? `${m[2]} ` : m[3] ? `${Number(m[3]) + 1}${m[4]} ` : "> ";
  const insert = `\n${m[1]}${marker}`;
  return { value: value.slice(0, caret) + insert + value.slice(caret), selection: [caret + insert.length, caret + insert.length] };
}

// ---- Block attributes --------------------------------------------------------------------------------------

/** The attributes governing the block the caret is in - what the bar reports as active. */
export function attrsAt(value: string, sel: Sel): RichAttrs {
  const lines = value.split("\n");
  const [first] = blockAround(lines, lineAt(lines, sel[0]));
  return (first > 0 ? parseAttrLine(lines[first - 1]!) : null) ?? {};
}

/** Set or clear attribute tokens on every selected block. */
export function setAttrs(value: string, sel: Sel, patch: Partial<RichAttrs>): Edit {
  const lines = value.split("\n");
  const heads = new Set(selectedBlocks(lines, sel).map(([first]) => first));
  const out: string[] = [];
  const map: number[] = []; // where each original line ended up, so the caret can follow it
  for (let i = 0; i < lines.length; i++) {
    if (heads.has(i)) {
      // The block's attribute line, if it has one, is the line just pushed - blockAround has already stepped past
      // it, so a head is never itself one.
      const existing = i > 0 ? parseAttrLine(lines[i - 1]!) : null;
      const merged: RichAttrs = { ...(existing ?? {}), ...patch };
      // A token back at its default drops out entirely, so a plain block keeps a clean source.
      for (const k of ["align", "size", "face"] as const) if (!merged[k]) delete merged[k];
      if (!merged.muted) delete merged.muted;
      const line = formatAttrLine(merged);
      if (existing) {
        if (line) out[out.length - 1] = line;
        else out.pop();
      } else if (line) {
        out.push(line);
      }
    }
    map[i] = out.length;
    out.push(lines[i]!);
  }
  return editLines(lines, out, map, sel);
}
