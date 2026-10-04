// Turning what somebody typed into ⌘K (or a list page's search box) into an FTS5 MATCH expression - the one
// place both services/globalSearch.ts and services/searchFilter.ts build it, so the two boxes agree on what a
// query means.
//
// TOKENS. Everything but letters and digits is a separator, so no FTS5 operator or quote from the query text
// survives into the expression and the query cannot alter its structure. Each typed word is a quoted PREFIX
// term, and terms are joined by an explicit AND, so "ali kap" finds "Alice Kapoor". Explicit, not FTS5's
// implicit AND by juxtaposition: that is only allowed between plain phrases, and a synonym group below is a
// parenthesised expression - `"log"* ("overtime"* OR "ot")` is an FTS5 syntax error, and ⌘K answered 500.
//
// SYNONYMS. The keyword index only knows the words on the row, and HR is a vocabulary of abbreviations: "PTO"
// finds nothing on an org whose leave types say "Earned Leave", and neither does "WFH" against a policy called
// "Work from home guidelines". The embedding model does not bridge these either (measured 2026-09-26: "vacation"
// never reached a leave type). So a typed word or phrase found in a group below is widened to
// `(typed OR every other member)`. Exact on the typed side - a half-typed "vacat" is not expanded, the finished
// word is - and deterministic, so it costs nothing and can be read and argued with.
//
// A group is a set of terms that should find each other. Keep them TIGHT: every member widens every other,
// so a loose member ("pay" in the payslip group) turns one precise query into a browse.
import { localDayStartMs } from "./attendance";

export const MAX_TOKENS = 6; // a search box query; more terms than this is a paste, not a search

export const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ["pto", "time off", "vacation", "annual leave", "earned leave", "privilege leave"],
  ["wfh", "work from home", "remote work"],
  ["lop", "loss of pay", "unpaid leave"],
  ["sick leave", "medical leave"],
  ["casual leave"],
  ["comp off", "compensatory off"],
  ["payslip", "pay slip", "salary slip"],
  ["increment", "raise", "hike"],
  ["resignation", "resign", "relieving", "quit"],
  ["fnf", "full and final", "full final", "final settlement"],
  ["reimbursement", "expense claim"],
  ["tds", "income tax"],
  ["pf", "provident fund", "epf"],
  ["esi", "esic"],
  ["noc", "no objection"],
  ["posh", "sexual harassment"],
  ["okr", "objective", "key result"],
  ["one on one", "1on1", "check in"],
  ["ot", "overtime"],
  ["birthday", "date of birth", "dob"],
  ["laptop", "notebook", "macbook"],
  ["mobile", "phone", "cellphone"],
  ["wifi", "wi fi", "internet"],
  ["id card", "access card", "badge"],
];

const words = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);

/** Synonym groups as data - the built-in list above, or an org's own (`search-synonyms` setting). */
export type SynonymGroups = readonly (readonly string[])[];

// The org's own groups arrive from a settings blob somebody typed into, so they are bounded and normalised
// here, once, for both the write validator (routes/settings.ts) and the read: at most this many groups, this
// many terms a group, this long a term.
export const MAX_ORG_GROUPS = 100;
export const MAX_GROUP_TERMS = 12;
export const MAX_TERM_CHARS = 40;

/**
 * An org's synonym groups, cleaned: each term lower-cased to the words search would split it into, empty and
 * repeated terms dropped, groups of fewer than two terms dropped (a group of one widens nothing), and the
 * bounds above applied. Tolerant on purpose - it is also the READ side, and a stored blob that has somehow
 * gone wrong should narrow what widens, never fail a search.
 */
export function normalizeSynonymGroups(raw: unknown): string[][] {
  if (!Array.isArray(raw)) return [];
  const out: string[][] = [];
  for (const g of raw.slice(0, MAX_ORG_GROUPS)) {
    if (!Array.isArray(g)) continue;
    const terms = [...new Set(g.filter((t): t is string => typeof t === "string").map((t) => words(t.slice(0, MAX_TERM_CHARS)).join(" ")).filter(Boolean))];
    if (terms.length >= 2) out.push(terms.slice(0, MAX_GROUP_TERMS));
  }
  return out;
}

type Lookup = Map<string, { tokens: string[]; alternatives: string[][] }[]>;

// Every distinct spelling as its token list, keyed by first token, longest first - the lookup the greedy match
// below walks - with what it widens to: the other members of EVERY group it is in. A spelling can sit in more
// than one group, most often an org group reusing a built-in word ("vacation, holiday trip" beside the PTO
// group), and each group must still widen it. Not transitive: two groups that share a word stay two groups for
// all their other words, so one shared word cannot chain a precise query into a browse.
function buildLookup(groups: SynonymGroups): Lookup {
  const groupsOf = new Map<string, number[]>();
  for (const [group, members] of groups.entries()) {
    for (const member of members) {
      const spelling = words(member).join(" ");
      if (spelling) groupsOf.set(spelling, [...(groupsOf.get(spelling) ?? []), group]);
    }
  }
  const byFirst: Lookup = new Map();
  for (const [spelling, inGroups] of groupsOf) {
    const others = new Set(inGroups.flatMap((g) => groups[g]!.map((m) => words(m).join(" "))));
    others.delete(spelling);
    others.delete("");
    const tokens = spelling.split(" ");
    const list = byFirst.get(tokens[0]!) ?? [];
    list.push({ tokens, alternatives: [...others].map((m) => m.split(" ")) });
    byFirst.set(tokens[0]!, list);
  }
  for (const list of byFirst.values()) list.sort((a, b) => b.tokens.length - a.tokens.length);
  return byFirst;
}

const BUILT_IN = buildLookup(SYNONYM_GROUPS);
// The last org lookup built. An isolate serves one org, so this is almost always a hit, and rebuilding a
// hundred groups on a miss is still microseconds.
let lastOrg: { key: string; lookup: Lookup } | null = null;

function lookupWith(extra: SynonymGroups): Lookup {
  if (!extra.length) return BUILT_IN;
  const key = JSON.stringify(extra);
  if (lastOrg?.key !== key) lastOrg = { key, lookup: buildLookup([...SYNONYM_GROUPS, ...extra]) };
  return lastOrg.lookup;
}

/** One unit of the query: the words typed, and every way of saying it that should also match. */
export type QueryTerm = { typed: string[]; alternatives: string[][] };

/** The query split into terms, each widened by its synonym group when it has one - built-in, or the org's
 *  own (`extra`, already normalised). */
export function queryTerms(raw: string, extra: SynonymGroups = []): QueryTerm[] {
  const byFirst = lookupWith(extra);
  const tokens = words(raw).slice(0, MAX_TOKENS);
  const out: QueryTerm[] = [];
  for (let i = 0; i < tokens.length; ) {
    const hit = (byFirst.get(tokens[i]!) ?? []).find((m) => m.tokens.every((t, k) => tokens[i + k] === t));
    if (!hit) {
      out.push({ typed: [tokens[i]!], alternatives: [] });
      i++;
      continue;
    }
    out.push({ typed: hit.tokens, alternatives: hit.alternatives });
    i += hit.tokens.length;
  }
  return out;
}

// A term as FTS5 syntax. A single word is a prefix term; a phrase is matched as a phrase. An alternative that
// is one SHORT word ("pf", "ot") is exact rather than a prefix: `"ot"*` would also find "other" and "total".
const phrase = (tokens: string[], prefix: boolean) => `"${tokens.join(" ")}"${prefix && tokens.length === 1 ? "*" : ""}`;

/** The MATCH expression for a raw query, or null when it has no searchable token. */
export function matchExpression(raw: string, extra: SynonymGroups = []): string | null {
  const terms = queryTerms(raw, extra);
  if (terms.length === 0) return null;
  return terms
    .map((t) => {
      if (!t.alternatives.length) return phrase(t.typed, true);
      const alts = t.alternatives.map((a) => phrase(a, a.length > 1 || a[0]!.length > 3));
      return `(${[phrase(t.typed, true), ...alts].join(" OR ")})`;
    })
    .join(" AND ");
}

/** `YYYY-MM` or `YYYY-MM-DD` (a search's `after:` / `before:`) as the instant that month or day starts in the
 *  org timezone `tz`, or null when it is not one - including a date the calendar would roll over (2026-02-30).
 *  An org-local day, because that is the day the palette counts `today` and `7d` from: read at UTC midnight, a
 *  record created in the first hours of an IST morning fell outside `on:today`. */
export function startOfPeriod(raw: string, tz: string): number | null {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(raw.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : 1];
  const back = new Date(Date.UTC(y, mo - 1, d));
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return localDayStartMs(back.toISOString().slice(0, 10), tz);
}

/**
 * Whether `text` still contains every term, by any of its spellings - the question the field gate in
 * globalSearch.ts asks of a hit when the caller may not read every column it could have matched on.
 * Substring, deliberately the permissive side of FTS's prefix match: a hit kept here is one whose visible text
 * explains it anyway. Compared as words, split exactly as the index splits them, because the index matched
 * "team outing" in "Team-outing" and "team\nouting": compared as raw text, a phrase spelling never matched
 * there and the hit was dropped.
 */
export function explains(text: string, terms: QueryTerm[]): boolean {
  const said = words(text).join(" ");
  return terms.every((t) => [t.typed, ...t.alternatives].some((spelling) => said.includes(spelling.join(" "))));
}
