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
  // Spaces dropped, so a two-word surname ("de Souza") still makes one typeable handle.
  const full = (p: PalettePerson) => `${p.first}${p.last}`.replace(/\s+/g, "").toLowerCase();
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

// ---- Filter suggestions -------------------------------------------------------------------------------------
// While the caret sits in a filter word (`in:tic`, `status:`, `@pri`, `is:`, `after:`), the palette offers the
// words that complete it. Every offer is a token `parsePaletteQuery` reads back as the narrowing it names, so
// picking one can never produce a filter the search then ignores.

/** Per searchable collection the caller may list, its status values (`GET /v1/search:vocabulary`). */
export type FilterVocabulary = readonly { collection: string; statuses: readonly string[] }[];

export type FilterSuggestion<P extends PalettePerson = PalettePerson> =
  | { kind: "in"; token: string; collection: string }
  | { kind: "status"; token: string; status: string; collections: string[] }
  | { kind: "person"; token: string; person: P }
  | { kind: "is"; token: string }
  | { kind: "date"; token: string; label: string };

/** The whitespace-delimited word the caret is in (or at the end of), as its span in `raw`. */
export function tokenAt(raw: string, caret: number): { start: number; end: number; text: string } {
  const at = Math.max(0, Math.min(caret, raw.length));
  let start = at;
  while (start > 0 && !/\s/.test(raw[start - 1]!)) start--;
  let end = at;
  while (end < raw.length && !/\s/.test(raw[end]!)) end++;
  return { start, end, text: raw.slice(start, end) };
}

/** `raw` with the span replaced by `token` and one space after it, and where the caret goes: past that space. */
export function applySuggestion(raw: string, span: { start: number; end: number }, token: string): { query: string; caret: number } {
  const rest = raw.slice(span.end).replace(/^\s+/, "");
  const head = raw.slice(0, span.start) + token + " ";
  return { query: head + rest, caret: head.length };
}

/** The collections an `in:` word names, by the rule the server applies (services/globalSearch.ts collectionsNamed). */
export function collectionsNamedBy(word: string, collections: readonly string[]): string[] {
  const w = word.toLowerCase().replace(/[^a-z-]/g, "");
  if (!w) return [];
  return collections.filter((c) => c === w || c === `${w}s` || c === `${w}es` || (w.length >= 3 && (c.startsWith(w) || c.replace(/-/g, "").startsWith(w.replace(/-/g, "")))));
}

// A typed value matches an option at its start, or at the start of any of its words (`prog` finds `in_progress`,
// `req` finds `leave-requests` and "Leave requests").
const startsAWord = (option: string, typed: string) => option.split(/[\s_-]+/).some((w) => w.startsWith(typed));
const matches = (typed: string, ...options: string[]) =>
  !typed || options.some((o) => o.toLowerCase().startsWith(typed) || startsAWord(o.toLowerCase(), typed));

const monthOf = (day: string, back: number) => {
  const [y, m] = day.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 - back, 1));
  return d.toISOString().slice(0, 7);
};

export function suggestFilters<P extends PalettePerson>(
  raw: string,
  caret: number,
  ctx: {
    people: readonly P[];
    vocabulary: FilterVocabulary | null;
    labelOf: (collection: string) => string;
    today: string; // the org-local day, YYYY-MM-DD
    daysAgo30: string; // the org-local day thirty days back
  },
  limit = 8,
): { start: number; end: number; items: FilterSuggestion<P>[] } | null {
  const span = tokenAt(raw, caret);
  const word = span.text.toLowerCase();
  const colon = word.indexOf(":");
  const key = colon > 0 ? word.slice(0, colon) : word.startsWith("@") ? "@" : "";
  const typed = colon > 0 ? word.slice(colon + 1) : word.slice(1);
  // What the rest of the query already says, so an offer never repeats a filter that is already there.
  const others = parsePaletteQuery(raw.slice(0, span.start) + raw.slice(span.end), ctx.people);
  let items: FilterSuggestion<P>[] = [];

  if (key === "in") {
    const vocab = ctx.vocabulary ?? [];
    const named = new Set(others.in.flatMap((w) => collectionsNamedBy(w, vocab.map((v) => v.collection))));
    items = vocab
      .filter((v) => !named.has(v.collection) && matches(typed, v.collection, ctx.labelOf(v.collection)))
      .sort((a, b) => ctx.labelOf(a.collection).localeCompare(ctx.labelOf(b.collection)))
      .map((v) => ({ kind: "in" as const, token: `in:${v.collection}`, collection: v.collection }));
  } else if (key === "status") {
    // Narrowed by `in:` already, only those collections' statuses; otherwise every status any collection has.
    const vocab = ctx.vocabulary ?? [];
    const scoped = others.in.length ? new Set(others.in.flatMap((w) => collectionsNamedBy(w, vocab.map((v) => v.collection)))) : null;
    const byStatus = new Map<string, string[]>();
    for (const v of vocab) {
      if (scoped && !scoped.has(v.collection)) continue;
      for (const s of v.statuses) byStatus.set(s, [...(byStatus.get(s) ?? []), v.collection]);
    }
    items = [...byStatus]
      .filter(([s]) => s !== others.status && matches(typed, s))
      .sort(([a, ac], [b, bc]) => bc.length - ac.length || a.localeCompare(b))
      .map(([s, cols]) => ({ kind: "status" as const, token: `status:${s}`, status: s, collections: cols }));
  } else if (key === "@") {
    if (!typed || others.owner) return null;
    const compact = (s: string) => s.replace(/\s+/g, "").toLowerCase();
    items = ctx.people
      .filter((p) => matches(typed, p.first, p.last, compact(`${p.first}${p.last}`)))
      .sort((a, b) => `${a.first} ${a.last}`.localeCompare(`${b.first} ${b.last}`))
      .flatMap((p) => {
        // The shortest handle that means this one person: the first name when nobody else has it, else the
        // whole name. Somebody no handle singles out (two people with one name) is not offered at all.
        const handle = [p.first, `${p.first}${p.last}`].map(compact).find((h) => resolvePerson(h, ctx.people) === p);
        return handle ? [{ kind: "person" as const, token: `@${handle}`, person: p }] : [];
      });
  } else if (key === "is") {
    items = !others.mine && matches(typed, "mine") ? [{ kind: "is", token: "is:mine" }] : [];
  } else if (key === "after" || key === "before") {
    const thisMonth = ctx.today.slice(0, 7);
    const spans: [string, string, string][] = [
      // [value, label after:, label before:]
      [thisMonth, "This month", "Before this month"],
      [monthOf(ctx.today, 1), "Since last month", "Before last month"],
      [ctx.daysAgo30, "The last 30 days", "More than 30 days ago"],
      [`${ctx.today.slice(0, 4)}-01`, "This year", "Before this year"],
    ];
    const taken = key === "after" ? others.after : others.before;
    items = taken ? [] : spans
      .filter(([v]) => v.startsWith(typed))
      .map(([v, a, b]) => ({ kind: "date" as const, token: `${key}:${v}`, label: key === "after" ? a : b }));
  } else {
    return null;
  }
  // A word already typed out in full is finished, even when longer offers start with it (`@priya` and
  // `@priyanka`): offering anything would make Enter complete what is complete instead of opening the result the
  // person is looking at.
  if (!items.length || items.some((s) => s.token === word)) return null;
  return { start: span.start, end: span.end, items: items.slice(0, limit) };
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
