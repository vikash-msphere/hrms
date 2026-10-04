// What the ⌘K box was asked, before anything is sent: the plain words, plus the narrowing typed with them.
// Pure, so the palette and its tests agree on what a query means.
//
//   in:tickets laptop    only tickets (the server resolves the word: `ticket`, `tickets` and `tick` all work)
//   @priya laptop        only records belonging to Priya - resolved from the directory the palette holds
//   is:mine laptop       only records belonging to me (`is:team`: belonging to my direct reports)
//   dept:sales laptop    only records filed under the Sales department and its sub-departments
//   status:pending leave records whose own state is PENDING
//   after:2026-01 laptop records created from January 2026 on (`before:` the other way; a day works too, and
//                        so do `today`, `yesterday`, `7d` and `2w`, counted back from the org's today)
//   on:2026-10-01        records created that day (`during:2026-09` that month, `during:2026` that year)
//   sort:new laptop      newest first instead of best match
//
// A `-` in front of `in:`, `@name`, `is:`, `dept:` or `status:` turns it round: `-in:holidays`, `-@priya`,
// `-is:mine`, `-dept:sales`, `-status:rejected` leave out what the plain filter would keep. The two combine:
// `is:team -@priya` is my team but Priya, `dept:eng -dept:eng-platform` is Engineering but its platform team.
// Unlike the plain filters, each `-` form can be used again: `-@priya -@rahul -status:rejected -status:cancelled`.
// The dates and `sort:` have no `-` form; `before:` is already the other side of `after:`.
//
// A prefix the palette cannot resolve (`@nobody`) is kept as a plain word rather than dropped, so the search
// still says "no matches" for what was typed instead of quietly answering a different question. `-@nobody`
// cannot be kept that way - as a word it would ASK for what it means to leave out - so it marks the query
// `incomplete` and nothing is sent until it names one person.

import { collectionsNamed, inWordOf } from "../../../src/domain/entityNames";

export type PalettePerson = { id: string; first: string; last: string };
export type PaletteDepartment = { name: string };

export type PaletteQuery = {
  text: string; // the words to match, prefixes removed
  in: string[]; // collection words from `in:`
  notIn: string[]; // collection words from `-in:`
  owner: PalettePerson | null; // from `@name`
  notOwners: PalettePerson[]; // from `-@name`, one per person left out
  mine: boolean; // from `is:mine`
  notMine: boolean; // from `-is:mine`
  team: boolean; // from `is:team`
  notTeam: boolean; // from `-is:team`
  dept?: string; // from `dept:sales`
  notDepts: string[]; // from `-dept:sales`, one per department left out
  after?: string; // from `after:2026-01` (the server reads YYYY-MM or YYYY-MM-DD)
  before?: string; // from `before:2026-03-01`
  status?: string; // from `status:pending`
  notStatuses: string[]; // from `-status:rejected`, one per status left out
  sort?: "new"; // from `sort:new`
  incomplete: boolean; // a `-@name` that does not yet name one person
};

/** `day` (YYYY-MM-DD) moved by `n` days, by calendar arithmetic - no clock, no time zone. */
const addDays = (day: string, n: number) => {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

/** The month after `month` (YYYY-MM). */
const nextMonth = (month: string) => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
};

/**
 * A relative day (`today`, `yesterday`, `7d`, `2w`) as the YYYY-MM-DD it means from the org-local `today`, or
 * the value unchanged when it is not one - a date is passed on as typed, and the server answers nothing for
 * anything that is neither.
 */
export function resolveDay(value: string, today: string | undefined): string {
  if (!today) return value;
  if (value === "today") return today;
  if (value === "yesterday") return addDays(today, -1);
  const back = /^(\d{1,4})([dw])$/.exec(value);
  return back ? addDays(today, -Number(back[1]) * (back[2] === "w" ? 7 : 1)) : value;
}

/** `on:` / `during:` as the window it means: a day, a month or a year. Null when it is none of those. */
function spanOf(value: string, today: string | undefined): { after: string; before: string } | null {
  const day = resolveDay(value, today);
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return { after: day, before: addDays(day, 1) };
  if (/^\d{4}-\d{2}$/.test(value)) return { after: value, before: nextMonth(value) };
  if (/^\d{4}$/.test(value)) return { after: `${value}-01`, before: `${Number(value) + 1}-01` };
  return null;
}

/** A department name as `dept:` spells it. The server reads it back the same way (services/globalSearch.ts deptSlug). */
export const deptSlug = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");

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

/**
 * `today` (the org-local day) is what relative dates count back from. Without it they are passed on as typed,
 * and the server, which reads only dates, answers nothing for them.
 */
export function parsePaletteQuery(raw: string, people: readonly PalettePerson[], today?: string): PaletteQuery {
  const out: PaletteQuery = {
    text: "", in: [], notIn: [], owner: null, notOwners: [], mine: false, notMine: false, team: false, notTeam: false,
    notDepts: [], notStatuses: [], incomplete: false,
  };
  const words: string[] = [];
  const valueOf = (lower: string, key: string) => (lower.startsWith(`${key}:`) && lower.length > key.length + 1 ? lower.slice(key.length + 1) : null);
  for (const part of raw.trim().split(/\s+/).filter(Boolean)) {
    const lower = part.toLowerCase();
    let v: string | null;
    if ((v = valueOf(lower, "in")) !== null) {
      out.in.push(v);
    } else if ((v = valueOf(lower, "-in")) !== null) {
      out.notIn.push(v);
    } else if ((v = valueOf(lower, "after")) !== null) {
      out.after = resolveDay(v, today);
    } else if ((v = valueOf(lower, "before")) !== null) {
      out.before = resolveDay(v, today);
    } else if ((v = valueOf(lower, "on") ?? valueOf(lower, "during")) !== null) {
      // A value that is no day, month or year still narrows - to nothing - rather than being dropped.
      const span = spanOf(v, today);
      out.after = span?.after ?? v;
      out.before = span?.before ?? v;
    } else if ((v = valueOf(lower, "status")) !== null) {
      out.status = v;
    } else if ((v = valueOf(lower, "-status")) !== null) {
      if (!out.notStatuses.includes(v)) out.notStatuses.push(v);
    } else if ((v = valueOf(lower, "dept")) !== null) {
      out.dept = v;
    } else if ((v = valueOf(lower, "-dept")) !== null) {
      if (!out.notDepts.includes(v)) out.notDepts.push(v);
    } else if (lower === "is:mine") {
      out.mine = true;
    } else if (lower === "-is:mine") {
      out.notMine = true;
    } else if (lower === "is:team") {
      out.team = true;
    } else if (lower === "-is:team") {
      out.notTeam = true;
    } else if (lower === "sort:new") {
      out.sort = "new";
    } else if (part.startsWith("@") && part.length > 1) {
      const who = resolvePerson(part.slice(1), people);
      if (who && !out.owner) out.owner = who;
      else words.push(part.slice(1));
    } else if (part.startsWith("-@") && part.length > 2) {
      const who = resolvePerson(part.slice(2), people);
      if (!who) out.incomplete = true;
      else if (!out.notOwners.includes(who)) out.notOwners.push(who);
    } else {
      words.push(part);
    }
  }
  out.text = words.join(" ");
  return out;
}

/**
 * True when the query narrows at all - such a query is about ONE corner of the app, not all of it. `sort:new`
 * is an order, not a narrowing: on its own it still asks about all of the app.
 */
export const isNarrowed = (q: PaletteQuery) =>
  q.in.length > 0 || q.notIn.length > 0 || !!q.owner || q.notOwners.length > 0 || q.mine || q.notMine || q.team || q.notTeam
  || !!q.dept || q.notDepts.length > 0 || !!q.after || !!q.before || !!q.status || q.notStatuses.length > 0;

/** The `/search` query string for a parsed query. */
export function searchParams(q: PaletteQuery): string {
  const p = new URLSearchParams({ q: q.text });
  if (q.in.length) p.set("in", q.in.join(","));
  if (q.notIn.length) p.set("notin", q.notIn.join(","));
  if (q.owner) p.set("owner", `employees/${q.owner.id}`);
  // Repeated, not comma-joined: the server decodes each person's ref as a whole value.
  for (const who of q.notOwners) p.append("notowner", `employees/${who.id}`);
  if (q.mine) p.set("mine", "1");
  if (q.notMine) p.set("notmine", "1");
  if (q.team) p.set("team", "1");
  if (q.notTeam) p.set("notteam", "1");
  if (q.dept) p.set("dept", q.dept);
  if (q.notDepts.length) p.set("notdept", q.notDepts.join(","));
  if (q.after) p.set("after", q.after);
  if (q.before) p.set("before", q.before);
  if (q.status) p.set("status", q.status);
  if (q.notStatuses.length) p.set("notstatus", q.notStatuses.join(","));
  if (q.sort) p.set("sort", q.sort);
  return p.toString();
}

// ---- Filter suggestions -------------------------------------------------------------------------------------
// While the caret sits in a filter word (`in:tic`, `status:`, `@pri`, `is:`, `after:`), the palette offers the
// words that complete it. Every offer is a token `parsePaletteQuery` reads back as the narrowing it names, so
// picking one can never produce a filter the search then ignores. A lone `?` offers the keys themselves.

/** Per searchable collection the caller may list, its status values (`GET /v1/search:vocabulary`). */
export type FilterVocabulary = readonly { collection: string; statuses: readonly string[] }[];

// `negate`: the `-` form, which leaves out what the plain form keeps.
export type FilterSuggestion<P extends PalettePerson = PalettePerson> =
  | { kind: "in"; token: string; collection: string; negate?: true }
  | { kind: "status"; token: string; status: string; collections: string[]; negate?: true }
  | { kind: "person"; token: string; person: P; negate?: true }
  | { kind: "is"; token: string; value: "mine" | "team"; negate?: true }
  | { kind: "dept"; token: string; department: PaletteDepartment; negate?: true }
  | { kind: "sort"; token: string }
  | { kind: "date"; token: string; label: string }
  | { kind: "key"; token: string; label: string; example: string; leaveOut?: string };

type GuideEntry = {
  key: string;
  label: string;
  example: string;
  // The `-` form, for a filter that has one: what it does on its own, and an example that shows it off.
  not?: { label: string; example: string };
};

/**
 * Every filter word, for the guide `?` opens: what each one does and an example of it. The hint bar under the
 * palette has room for a few of these; this is where the rest are found. A key is inserted bare (`dept:`), so
 * its own completions take over from there.
 *
 * Leaving something out is one rule, not a list of special keys: a `-` in front of any filter that has a `not`
 * form below. The guide says so once, in its own row, and each such filter shows its `-` form beside it.
 */
export const FILTER_GUIDE: readonly GuideEntry[] = [
  { key: "in:", label: "Only one kind of record", example: "in:tickets",
    not: { label: "Every kind of record but one", example: "-in:holidays" } },
  { key: "@", label: "Records belonging to a person", example: "@priya",
    not: { label: "Records that are not a person's", example: "-@priya" } },
  { key: "is:", label: "Records belonging to you or your team", example: "is:mine · is:team",
    not: { label: "Records that are not yours, or not your team's", example: "-is:mine · -is:team" } },
  { key: "dept:", label: "Records in a department and the ones under it", example: "dept:sales",
    not: { label: "Records outside a department and the ones under it", example: "-dept:sales" } },
  { key: "status:", label: "Records in one status", example: "status:pending",
    not: { label: "Records in any status but one", example: "-status:rejected" } },
  { key: "after:", label: "Created on or after a day", example: "after:7d · after:2026-01" },
  { key: "before:", label: "Created before a day", example: "before:yesterday · before:2026-03-15" },
  { key: "on:", label: "Created on one day", example: "on:today · on:2026-10-01" },
  { key: "during:", label: "Created in one month or year", example: "during:2026-09 · during:2026" },
  { key: "sort:", label: "Newest first instead of best match", example: "sort:new" },
];

/**
 * The row that explains `-` itself: leaving out works on every filter with a `not` form, and mixes with the
 * plain filters - the example shows that, since "my team but Priya" is what a `-` is mostly for.
 */
export const LEAVE_OUT_GUIDE = {
  key: "-",
  label: "Leave out what a filter names: put - in front of it",
  example: `${FILTER_GUIDE.flatMap((g) => (g.not ? [`-${g.key}`] : [])).join(" · ")}   ·   e.g. is:team -@priya`,
};

// The keys a `-` can go in front of.
const NEGATABLE = new Set(FILTER_GUIDE.flatMap((g) => (g.not ? [g.key.replace(/:$/, "")] : [])));

/** The word that opens the filter guide. */
export const GUIDE_WORD = "?";

/** The whitespace-delimited word the caret is in (or at the end of), as its span in `raw`. */
export function tokenAt(raw: string, caret: number): { start: number; end: number; text: string } {
  const at = Math.max(0, Math.min(caret, raw.length));
  let start = at;
  while (start > 0 && !/\s/.test(raw[start - 1]!)) start--;
  let end = at;
  while (end < raw.length && !/\s/.test(raw[end]!)) end++;
  return { start, end, text: raw.slice(start, end) };
}

/**
 * `raw` with the span replaced by `token` and one space after it, and where the caret goes: past that space.
 * A bare key (`dept:`, `@`, `-`) is still open, so it gets no space and the caret stays at its end, where that
 * key's own completions are offered.
 */
export function applySuggestion(raw: string, span: { start: number; end: number }, token: string): { query: string; caret: number } {
  const rest = raw.slice(span.end).replace(/^\s+/, "");
  const open = /[:@-]$/.test(token);
  const head = raw.slice(0, span.start) + token + (open ? "" : " ");
  return { query: head + (open && rest ? ` ${rest}` : rest), caret: head.length };
}

/** The collections an `in:` word names - the server's own rule (src/domain/entityNames.ts), not a copy of it. */
export const collectionsNamedBy = collectionsNamed;
/** The word to write a collection as after `in:` - its own name where that is unambiguous (entityNames.ts). */
export { inWordOf };

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
    departments?: readonly PaletteDepartment[] | null; // the ones the caller may list, once loaded
  },
  limit = 8,
): { start: number; end: number; items: FilterSuggestion<P>[] } | null {
  const span = tokenAt(raw, caret);
  const word = span.text.toLowerCase();
  // A leading `-` turns the filter round; everything after it is completed exactly as the plain filter is, and
  // every offer carries the `-` back.
  const negate = word.length > 1 && word.startsWith("-");
  const base = negate ? word.slice(1) : word;
  const sign = negate ? "-" : "";
  const not = negate ? { negate: true as const } : {};
  const colon = base.indexOf(":");
  const key = colon > 0 ? base.slice(0, colon) : base.startsWith("@") ? "@" : "";
  const typed = colon > 0 ? base.slice(colon + 1) : base.slice(1);
  if (negate && !NEGATABLE.has(key)) return null; // the dates and `sort:` have no `-` form
  // What the rest of the query already says, so an offer never repeats a filter that is already there.
  const others = parsePaletteQuery(raw.slice(0, span.start) + raw.slice(span.end), ctx.people, ctx.today);
  let items: FilterSuggestion<P>[] = [];

  if (word === GUIDE_WORD) {
    // Every key, less the ones the query already holds and cannot hold twice; the `-` rule first, since it
    // applies to most of what follows.
    const taken = new Set([
      ...(others.owner ? ["@"] : []),
      ...(others.mine || others.team ? ["is:"] : []),
      ...(others.dept ? ["dept:"] : []),
      ...(others.status ? ["status:"] : []),
      ...(others.after ? ["after:", "on:", "during:"] : []),
      ...(others.before ? ["before:", "on:", "during:"] : []),
      ...(others.sort ? ["sort:"] : []),
    ]);
    items = [
      { kind: "key" as const, token: LEAVE_OUT_GUIDE.key, label: LEAVE_OUT_GUIDE.label, example: LEAVE_OUT_GUIDE.example },
      ...FILTER_GUIDE.filter((g) => !taken.has(g.key))
        .map((g) => ({ kind: "key" as const, token: g.key, label: g.label, example: g.example, ...(g.not ? { leaveOut: g.not.example } : {}) })),
    ];
    return { start: span.start, end: span.end, items }; // the whole guide, not a page of it
  } else if (word === "-") {
    // A `-` on its own: the filters it can turn round, each described by what its `-` form does. Every one can
    // be used again for another value; only `-is:` runs out, once mine and my team are both left out.
    const taken = new Set(others.notMine && others.notTeam ? ["is:"] : []);
    items = FILTER_GUIDE.filter((g) => g.not && !taken.has(g.key))
      .map((g) => ({ kind: "key" as const, token: `-${g.key}`, label: g.not!.label, example: g.not!.example }));
  } else if (key === "in") {
    const vocab = ctx.vocabulary ?? [];
    const named = new Set([...others.in, ...others.notIn].flatMap((w) => collectionsNamedBy(w, vocab.map((v) => v.collection))));
    // Written with the kind's own name (`in:tasks`), not its wire name (`in:cards`) - see inWordOf.
    const all = vocab.map((v) => v.collection);
    items = vocab
      .filter((v) => !named.has(v.collection) && matches(typed, v.collection, ctx.labelOf(v.collection)))
      .sort((a, b) => ctx.labelOf(a.collection).localeCompare(ctx.labelOf(b.collection)))
      .map((v) => ({ kind: "in" as const, token: `${sign}in:${inWordOf(v.collection, all)}`, collection: v.collection, ...not }));
  } else if (key === "status") {
    // Narrowed by `in:` already, only those collections' statuses; otherwise every status any collection has.
    const vocab = ctx.vocabulary ?? [];
    const scoped = others.in.length ? new Set(others.in.flatMap((w) => collectionsNamedBy(w, vocab.map((v) => v.collection)))) : null;
    const byStatus = new Map<string, string[]>();
    for (const v of vocab) {
      if (scoped && !scoped.has(v.collection)) continue;
      for (const s of v.statuses) byStatus.set(s, [...(byStatus.get(s) ?? []), v.collection]);
    }
    // A query holds one `status:` but any number of `-status:`; neither offers a value the query already names.
    items = !negate && others.status ? [] : [...byStatus]
      .filter(([s]) => s !== others.status && !others.notStatuses.includes(s) && matches(typed, s))
      .sort(([a, ac], [b, bc]) => bc.length - ac.length || a.localeCompare(b))
      .map(([s, cols]) => ({ kind: "status" as const, token: `${sign}status:${s}`, status: s, collections: cols, ...not }));
  } else if (key === "dept") {
    // The same for departments: one `dept:`, any number of `-dept:`.
    const named = new Set([...(others.dept ? [others.dept] : []), ...others.notDepts]);
    items = !negate && others.dept ? [] : (ctx.departments ?? [])
      .filter((d) => !named.has(deptSlug(d.name)) && matches(typed, deptSlug(d.name), d.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((d) => ({ kind: "dept" as const, token: `${sign}dept:${deptSlug(d.name)}`, department: d, ...not }));
  } else if (key === "sort") {
    items = !others.sort && matches(typed, "new") ? [{ kind: "sort", token: "sort:new" }] : [];
  } else if (key === "@") {
    // And people: one `@name`, any number of `-@name`, never one already named either way.
    if (!typed || (!negate && others.owner)) return null;
    const named = new Set([...(others.owner ? [others.owner.id] : []), ...others.notOwners.map((p) => p.id)]);
    const compact = (s: string) => s.replace(/\s+/g, "").toLowerCase();
    items = ctx.people
      .filter((p) => !named.has(p.id) && matches(typed, p.first, p.last, compact(`${p.first}${p.last}`)))
      .sort((a, b) => `${a.first} ${a.last}`.localeCompare(`${b.first} ${b.last}`))
      .flatMap((p) => {
        // The shortest handle that means this one person: the first name when nobody else has it, else the
        // whole name. Somebody no handle singles out (two people with one name) is not offered at all.
        const handle = [p.first, `${p.first}${p.last}`].map(compact).find((h) => resolvePerson(h, ctx.people) === p);
        return handle ? [{ kind: "person" as const, token: `${sign}@${handle}`, person: p, ...not }] : [];
      });
  } else if (key === "is") {
    // Mine and my team are two different owners, so one of them already there rules out the other. Leaving one
    // out is not ruled out by anything but leaving it out already, or asking for it.
    const left = (v: "mine" | "team") => (v === "mine" ? others.notMine || others.mine : others.notTeam || others.team);
    const values = negate
      ? (["mine", "team"] as const).filter((v) => !left(v) && matches(typed, v))
      : others.mine || others.team ? [] : (["mine", "team"] as const).filter((v) => matches(typed, v));
    items = values.map((value) => ({ kind: "is" as const, token: `${sign}is:${value}`, value, ...not }));
  } else if (key === "on" || key === "during") {
    const thisMonth = ctx.today.slice(0, 7);
    const spans: [string, string][] = key === "on"
      ? [["today", "Today"], ["yesterday", "Yesterday"]]
      : [[thisMonth, "This month"], [monthOf(ctx.today, 1), "Last month"], [ctx.today.slice(0, 4), "This year"]];
    items = others.after || others.before ? [] : spans
      .filter(([v]) => v.startsWith(typed))
      .map(([v, label]) => ({ kind: "date" as const, token: `${key}:${v}`, label }));
  } else if (key === "after" || key === "before") {
    const thisMonth = ctx.today.slice(0, 7);
    const spans: [string, string, string][] = [
      // [value, label after:, label before:]
      ["7d", "The last 7 days", "More than 7 days ago"],
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
  // Every kind for `in:`, not the first `limit` of them: its offers are chips in a row that scrolls, ranked by
  // the palette by how much each kind holds (CommandPalette.tsx) - which this module does not know - so cutting
  // here would cut alphabetically, and the kinds that hold the most went unoffered.
  return { start: span.start, end: span.end, items: key === "in" ? items : items.slice(0, limit) };
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
export const looksLikeQuestion = (text: string) =>
  /[\p{L}\p{N}]/u.test(text) && (text.trim().endsWith("?") || text.trim().split(/\s+/).length >= 3); // a lone `?` opens the filter guide
