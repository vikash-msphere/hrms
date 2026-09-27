// What the ⌘K box was asked, before anything is sent: the plain words, plus the narrowing typed with them.
// Pure, so the palette and its tests agree on what a query means.
//
//   in:tickets laptop    only tickets (the server resolves the word: `ticket`, `tickets` and `tick` all work)
//   @priya laptop        only records belonging to Priya - resolved from the directory the palette holds
//   is:mine laptop       only records belonging to me
//   after:2026-01 laptop records created from January 2026 on (`before:` the other way; a day works too)
//   status:pending leave records whose own state is PENDING
//
// A prefix the palette cannot resolve (`@nobody`) is kept as a plain word rather than dropped, so the search
// still says "no matches" for what was typed instead of quietly answering a different question.

export type PalettePerson = { id: string; first: string; last: string };

export type PaletteQuery = {
  text: string; // the words to match, prefixes removed
  in: string[]; // collection words from `in:`
  owner: PalettePerson | null; // from `@name`
  mine: boolean; // from `is:mine`
  after?: string; // from `after:2026-01` (the server reads YYYY-MM or YYYY-MM-DD)
  before?: string; // from `before:2026-03-01`
  status?: string; // from `status:pending`
};

/** The one person an `@name` means, or null when nobody or more than one plausibly does. */
export function resolvePerson(handle: string, people: readonly PalettePerson[]): PalettePerson | null {
  const h = handle.toLowerCase();
  if (h.length < 2) return null;
  const full = (p: PalettePerson) => `${p.first}${p.last}`.toLowerCase();
  const exact = people.filter((p) => p.first.toLowerCase() === h || full(p) === h);
  if (exact.length === 1) return exact[0]!;
  const starts = people.filter((p) => p.first.toLowerCase().startsWith(h) || full(p).startsWith(h) || p.last.toLowerCase().startsWith(h));
  return starts.length === 1 ? starts[0]! : null;
}

export function parsePaletteQuery(raw: string, people: readonly PalettePerson[]): PaletteQuery {
  const out: PaletteQuery = { text: "", in: [], owner: null, mine: false };
  const words: string[] = [];
  for (const part of raw.trim().split(/\s+/).filter(Boolean)) {
    const lower = part.toLowerCase();
    if (lower.startsWith("in:") && lower.length > 3) {
      out.in.push(lower.slice(3));
    } else if (lower.startsWith("after:") && lower.length > 6) {
      out.after = lower.slice(6);
    } else if (lower.startsWith("before:") && lower.length > 7) {
      out.before = lower.slice(7);
    } else if (lower.startsWith("status:") && lower.length > 7) {
      out.status = lower.slice(7);
    } else if (lower === "is:mine") {
      out.mine = true;
    } else if (part.startsWith("@") && part.length > 1) {
      const who = resolvePerson(part.slice(1), people);
      if (who && !out.owner) out.owner = who;
      else words.push(part.slice(1));
    } else {
      words.push(part);
    }
  }
  out.text = words.join(" ");
  return out;
}

/** True when the query narrows at all - such a query is about ONE corner of the app, not all of it. */
export const isNarrowed = (q: PaletteQuery) => q.in.length > 0 || !!q.owner || q.mine || !!q.after || !!q.before || !!q.status;

/** The `/search` query string for a parsed query. */
export function searchParams(q: PaletteQuery): string {
  const p = new URLSearchParams({ q: q.text });
  if (q.in.length) p.set("in", q.in.join(","));
  if (q.owner) p.set("owner", `employees/${q.owner.id}`);
  if (q.mine) p.set("mine", "1");
  if (q.after) p.set("after", q.after);
  if (q.before) p.set("before", q.before);
  if (q.status) p.set("status", q.status);
  return p.toString();
}

/**
 * Edit distance with adjacent transposition (optimal string alignment), stopping early past `max`.
 * Enough for a name typed with one slip - "Kpoor", "Kapoorr", "Kapour", "Akpoor".
 */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length]![b.length]!;
}

/**
 * People whose first or last name is one slip away from a word of the query ("did you mean"), for when an
 * exact match found nobody. One edit for a short word, two from seven letters; words under four letters
 * are left alone, because at that length everything is one edit from something.
 */
export function nearPeople<T extends PalettePerson>(text: string, people: readonly T[], limit = 5): T[] {
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4);
  if (!words.length) return [];
  const scored: { p: T; d: number }[] = [];
  for (const p of people) {
    const names = [p.first, p.last].map((n) => n.toLowerCase()).filter(Boolean);
    let best = Infinity;
    for (const w of words) {
      const max = w.length >= 7 ? 2 : 1;
      for (const n of names) {
        const dist = editDistance(w, n, max);
        if (dist <= max) best = Math.min(best, dist);
      }
    }
    if (best < Infinity) scored.push({ p, d: best });
  }
  return scored.sort((a, b) => a.d - b.d).slice(0, limit).map((s) => s.p);
}

/** The words of a query worth highlighting: letters and digits, two characters or more. */
export const highlightTokens = (text: string): string[] =>
  [...new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2))];

/**
 * `text` split into runs, each marked when it is a typed word matching at the START of a word - the same
 * prefix rule the search index matches by, so what is highlighted is what matched ("kap" marks the "Kap" of
 * "Kapoor", never the "kap" inside another word). Only ever applied to the title and subtitle a result
 * already shows, so it reveals nothing the row does not.
 */
export function highlightParts(text: string, tokens: readonly string[]): { text: string; hit: boolean }[] {
  if (!text || tokens.length === 0) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const isWordChar = (ch: string | undefined) => !!ch && /[\p{L}\p{N}]/u.test(ch);
  const parts: { text: string; hit: boolean }[] = [];
  let run = 0; // start of the current unmarked run
  for (let i = 0; i < text.length; ) {
    const len = isWordChar(lower[i]) && !isWordChar(lower[i - 1])
      ? Math.max(0, ...tokens.filter((t) => lower.startsWith(t, i)).map((t) => t.length))
      : 0;
    if (len > 0) {
      if (i > run) parts.push({ text: text.slice(run, i), hit: false });
      parts.push({ text: text.slice(i, i + len), hit: true });
      i += len;
      run = i;
    } else {
      i++;
    }
  }
  if (run < text.length) parts.push({ text: text.slice(run), hit: false });
  return parts;
}

/** The recent-searches list after searching `q`: most recent first, no repeats (case-insensitive), capped. */
export function pushRecent(list: readonly string[], q: string, cap = 8): string[] {
  const t = q.trim().replace(/\s+/g, " ");
  if (t.length < 2) return [...list];
  return [t, ...list.filter((s) => s.toLowerCase() !== t.toLowerCase())].slice(0, cap);
}

/** Whether the words read as a question worth sending to Ask: three words or more, or a question mark. */
export const looksLikeQuestion = (text: string) => text.trim().endsWith("?") || text.trim().split(/\s+/).length >= 3;
