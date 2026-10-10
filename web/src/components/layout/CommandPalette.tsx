import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Search, ArrowLeft, User, Loader2, KeyRound, X, Sparkles, ListFilter, Lock, History, Check, Ban, CalendarDays, ChevronDown, Bookmark, BookmarkPlus, Pin, PinOff, WandSparkles } from "lucide-react";
import { useAskReason, useConfirm } from "@/components/common/confirm";
import { FilterChips, filterChipClass } from "@/components/common/FilterChips";
import { ChipsSkeleton } from "@/components/common/Skeletons";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/use-toast";
import { askDecision } from "@/lib/confirmDecision";
import { useSelfApprovalAllowed } from "@/lib/approvals";
import { hasPaletteActions, paletteVerbs, type ActionableRow, type PaletteVerb, type PaletteVerbOption } from "@/lib/paletteActions";
import { previewOf } from "@/lib/searchPreview";
import { useSavedSearches, type SavedSearch } from "@/lib/savedSearches";
import { readLocal, userKey, writeLocal } from "@/lib/localPref";
import { useAppLock, lockNow } from "@/lib/appLock";
import { openAppLockSettings } from "@/components/lock/AppLockSheet";
import { useKeyboardInset } from "@/hooks/useKeyboardInset";
import { useAccessMode } from "@/components/access/AccessModeProvider";
import { NAV, itemVisible, navAdmits } from "@/nav";
import { SETTINGS_REGISTRY, settingsEntryVisible } from "@/settings/registry";
import { hasCapability } from "@/lib/perm";
import { navigate, useRoute } from "@/router";
import { cn, idOf } from "@/lib/utils";
import { useCollection } from "@/hooks/useCollection";
import { resolveQuickActionList, runQuickAction } from "@/lib/quickActions";
import { useOrg } from "@/lib/org";
import { api, invoke } from "@/api";
import { collectionsOnRoute, resourceRoute } from "@/lib/resourceRoute";
import { frecencyScore, useKindAffinity } from "@/lib/searchKinds";
import { collectionsOfTone, entityLabel, entityLabelSingular, iconOf, toneOf, TONE_CLS, type Tone } from "@/lib/entityKinds";
import type { OrgSettings } from "@/lib/org";
import type { LucideIcon } from "lucide-react";
import type { Department, Employee, Me, SearchHit, SearchPage } from "@/types";
import { useAiFeature } from "@/lib/aiFeatures";
import {
  GUIDE_WORD, applyFacetPick, applySuggestion, collectionsNamedBy, facetOf, facetOffers, filtersForWords, inWordOf, highlightParts, highlightTokens, isGuideQuery,
  isNarrowed, looksLikeQuestion, nearPeople, parsePaletteQuery, pushRecent, rankKindOffers, resolveDay, resolvePerson, searchParams, suggestFilters, tokenAt, whenCounts,
  type Facet, type FacetOffer, type FilterContext, type FilterSuggestion, type FilterVocabulary, type PalettePerson, type PaletteQuery, type WordFilter,
} from "@/lib/paletteQuery";
import { addDaysYmd, orgDayFromToday, stampDay, todayStr, weekStartYmd } from "@/lib/orgDay";

// One row of the palette. Everything the palette can offer - a create flow, a page, a settings panel, or an
// actual record out of the database - is normalised to this shape, so the list renders and keyboard-navigates
// uniformly while each row still announces WHAT it is (`badge` + `tone`).
type Item = {
  key: string;
  label: string;
  detail?: string | null;
  badge: string; // the type word shown on the right: "Action", "Page", "Leave request", ...
  tone: Tone;
  icon: LucideIcon;
  route?: string; // app route to navigate to
  run?: () => void; // ...or an action to fire instead
  // How it was found, for the open counters (routes/search.ts `search:feedback`). Absent = a palette row that
  // is not a result at all (See all, Ask), which is not counted.
  source?: "keyword" | "related" | "local";
  stay?: boolean; // runs without closing the palette (See all, Ask)
  // A database record (a server hit): its ref and collection, which is what the Tab actions act on.
  record?: { name: string; collection: string };
  completes?: boolean; // a filter suggestion: Tab accepts it, as Enter does
  count?: string; // an `in:` suggestion's count ("12", "12+", "1,240"), drawn after its label
  muted?: boolean; // an `in:` suggestion the words found nothing of: still offered, drawn quieter
};

// A record as read whole for a result: what its decisions are judged on, and what its preview shows.
type PeekRow = ActionableRow & Record<string, unknown> & { etag?: string };

// The record whose actions the palette is showing (Tab on a result), and what loading it found.
type ActionsState = {
  item: Item;
  name: string;
  collection: string;
  status: "loading" | "ready" | "error";
  verbs: PaletteVerbOption[];
  etag?: string;
  message?: string;
};

// Rows shown per record type before "See all". The top of each group is what a person reads; the rest is one
// press away, narrowed to that type.
const PER_SECTION = 5;
// The server answers at most this many hits across every type (services/globalSearch.ts TOTAL), so a group
// that reached it may have more than it shows.
const SERVER_TOTAL = 60;

type AskAnswer = { destinations: { key: string; why: string }[]; search: string | null };
type AskState =
  | { status: "idle" }
  | { status: "loading"; question: string }
  | { status: "done"; question: string; answer: AskAnswer }
  | { status: "error"; question: string; message: string };
type Section = { label: string; items: Item[] };

// Build the always-available, zero-latency half of the palette: "Do" actions first (run a create flow from
// anywhere), then every destination the caller may reach. Both inherit the exact capability gating used
// elsewhere. A workspace contributes its tabs (Attendance, Overtime, …) as individual jump targets.
function buildLocal(me: Me, quickCfg?: OrgSettings["quick_actions"]): { actions: Item[]; pages: Item[]; settings: Item[] } {
  const actions: Item[] = resolveQuickActionList(me, quickCfg).map((a) => ({
    key: `action:${a.id}`,
    label: a.label,
    badge: "Action",
    tone: "action",
    icon: a.icon,
    run: () => runQuickAction(a),
  }));
  const pages: Item[] = NAV.flatMap((g) =>
    g.items.flatMap((i): Item[] => {
      if (i.tabs) {
        return i.tabs
          .filter((t) => navAdmits(t, (p) => hasCapability(me.capabilities, p), (c) => !!me.scopes.read[c]))
          .map((t) => ({ key: t.key, label: `${i.label}: ${t.label}`, detail: g.label, badge: "Page", tone: "page", icon: i.icon, route: t.key }));
      }
      if (!itemVisible(i, (p) => hasCapability(me.capabilities, p), (c) => !!me.scopes.read[c])) return [];
      return [{ key: i.key, label: i.label, detail: g.label, badge: "Page", tone: "page", icon: i.icon, route: i.key }];
    }),
  );
  // Every settings panel is a jump target ("Leave types"), gated exactly like the Settings page - write on what
  // the panel edits (registry.ts settingsEntryVisible) - so nobody is offered a door they can't open.
  const settings: Item[] = SETTINGS_REGISTRY.filter((s) => settingsEntryVisible(me.capabilities, s)).map((s) => ({
    key: `settings/${s.key}`,
    label: s.title,
    detail: s.group,
    badge: "Setting",
    tone: "setting",
    icon: s.icon,
    route: `settings/${s.key}`,
  }));
  return { actions, pages, settings };
}

// Rank matches: exact prefix on the label beats a word-boundary prefix, which beats any substring (label then
// detail). Non-matches are dropped. Keeps the obvious target at the top as you type.
function score(item: Item, q: string): number {
  const label = item.label.toLowerCase();
  const detail = (item.detail ?? "").toLowerCase();
  if (label.startsWith(q)) return 0;
  if (label.split(/\s+/).some((w) => w.startsWith(q))) return 1;
  if (label.includes(q)) return 2;
  if (detail.includes(q)) return 3;
  return -1;
}

// ---- Frecency ----------------------------------------------------------------------------------------------
// What this user actually opens from the palette, kept in localStorage per user: use-count decayed by recency
// (lib/searchKinds.ts frecencyScore, shared with the `in:` kind ranking). Ranks the empty-query view ("Recent"
// on top) and breaks match-score ties while typing, so the palette learns the handful of destinations each
// person lives in.
type FrecencyMap = Record<string, { n: number; t: number }>;
const frecencyLsKey = (email: string) => `palette:frecent:${email}`;
function loadFrecency(email: string): FrecencyMap {
  try {
    return JSON.parse(localStorage.getItem(frecencyLsKey(email)) || "{}") as FrecencyMap;
  } catch {
    return {};
  }
}
function bumpFrecency(email: string, key: string) {
  const map = loadFrecency(email);
  const prev = map[key];
  map[key] = { n: (prev?.n ?? 0) + 1, t: Date.now() };
  // Cap the store so it can't grow unboundedly: keep the 50 strongest entries.
  const kept = Object.entries(map)
    .sort(([, a], [, b]) => frecencyScore(b) - frecencyScore(a))
    .slice(0, 50);
  try {
    localStorage.setItem(frecencyLsKey(email), JSON.stringify(Object.fromEntries(kept)));
  } catch {
    /* private mode */
  }
}

/** True when the caret sits at the end of the input, so an arrow key is not also moving through the text. */
const caretAtEnd = (e: React.KeyboardEvent) => {
  const el = e.currentTarget as HTMLInputElement;
  return el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
};

// ---- Recent searches ----------------------------------------------------------------------------------------
// The last few queries that ended in something being opened, per person (lib/localPref.ts `userKey`, so a
// shared machine does not hand one person's searches to the next, and sign-out clears them).
const RECENT_QUERIES = "palette:recentq";
function loadRecentQueries(): string[] {
  const k = userKey(RECENT_QUERIES);
  if (!k) return [];
  try {
    const v: unknown = JSON.parse(readLocal(k) ?? "[]");
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}
function saveRecentQuery(q: string) {
  const k = userKey(RECENT_QUERIES);
  if (k) writeLocal(k, JSON.stringify(pushRecent(loadRecentQueries(), q)));
}
function clearRecentQueries() {
  const k = userKey(RECENT_QUERIES);
  if (k) writeLocal(k, "[]");
}

// ---- Filters in the box ----------------------------------------------------------------------------------
// What the chip row says while a filter word is being typed, by the kind of word (lib/paletteQuery.ts).
const COMPLETING: Record<FilterSuggestion["kind"], string> = {
  in: "Kind", status: "Status", person: "Person", is: "Whose", dept: "Department", sort: "Order", date: "Date", key: "Filter",
};

// A filter word as typed: `in:tickets`, `-@priya`, `after:7d`, ... - every word parsePaletteQuery reads as a
// narrowing rather than as words to match.
const FILTER_WORD = /^-?(?:(?:in|status|dept|after|before|on|during|sort|is):\S+|@\S+)$/i;

/** The filter words in the box, with where each sits - leaving out `skip`, the word still being completed. */
function typedFilterWords(raw: string, skip: { start: number; end: number } | null): { start: number; end: number; word: string }[] {
  const out: { start: number; end: number; word: string }[] = [];
  for (const m of raw.matchAll(/\S+/g)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (skip && start === skip.start && end === skip.end) continue;
    if (FILTER_WORD.test(m[0])) out.push({ start, end, word: m[0] });
  }
  return out;
}

/**
 * Why a typed filter word names nothing, in plain words - or null when it names something, or when that cannot
 * be told yet (`status:` before the vocabulary has loaded, `dept:` whose list is read only while completing it):
 * a word is only called wrong on the strength of the same readings the server makes.
 */
function filterWordProblem(word: string, ctx: { people: readonly PalettePerson[]; kinds: readonly string[]; vocabulary: FilterVocabulary | null; today: string }): string | null {
  const body = word.startsWith("-") ? word.slice(1) : word;
  if (body.startsWith("@")) {
    const handle = body.slice(1);
    // The directory is read when the search first opens; until it lands, nobody is anybody.
    if (ctx.people.length === 0) return null;
    return resolvePerson(handle, ctx.people) ? null : handle.length < 2 ? "Type more of a name" : `No one, or more than one person, is called ${handle}`;
  }
  const colon = body.indexOf(":");
  const key = body.slice(0, colon).toLowerCase();
  const value = body.slice(colon + 1);
  const lower = value.toLowerCase();
  switch (key) {
    case "in":
      return collectionsNamedBy(value, ctx.kinds).length ? null : `No kind of record you can search is called ${value}`;
    case "is":
      return lower === "mine" || lower === "team" ? null : "is: takes mine or team";
    case "status":
      if (!ctx.vocabulary) return null;
      return ctx.vocabulary.some((c) => c.statuses.some((s) => s.toLowerCase() === lower)) ? null : `Nothing you can search has the status ${value}`;
    case "sort":
      return lower === "new" ? null : "sort: takes new";
    case "after":
    case "before":
      return /^\d{4}-\d{2}(-\d{2})?$/.test(resolveDay(lower, ctx.today)) ? null : `${value} is not a day or a month`;
    case "on":
    case "during":
      return /^\d{4}(-\d{2}(-\d{2})?)?$/.test(resolveDay(lower, ctx.today)) ? null : `${value} is not a day, a month or a year`;
    default:
      return null;
  }
}

/** A typed filter word in plain words, for its pill: `in:tickets` is "Tickets", `-@priya` is "Not Priya Shah". */
function filterWordLabel(word: string, people: readonly PalettePerson[], kinds: readonly string[]): string {
  const negate = word.startsWith("-");
  const body = negate ? word.slice(1) : word;
  const not = (label: string) => (negate ? `Not ${label}` : label);
  if (body.startsWith("@")) {
    const who = resolvePerson(body.slice(1), people);
    return not(who ? `${who.first} ${who.last}` : body);
  }
  const colon = body.indexOf(":");
  const key = body.slice(0, colon).toLowerCase();
  const value = body.slice(colon + 1);
  switch (key) {
    case "in": {
      // The server's own reading of the word (collectionsNamedBy), so the pill names what is really searched.
      const named = collectionsNamedBy(value, kinds);
      return not(named.length === 1 ? entityLabel(named[0]!) : entityLabel(value));
    }
    case "is":
      return not(value.toLowerCase() === "team" ? "My team" : value.toLowerCase() === "mine" ? "Mine" : value);
    case "status":
      return not(`Status: ${statusLabel(value)}`);
    case "dept":
      return not(`Department: ${value}`);
    case "sort":
      return "Newest first";
    default:
      return `${key.charAt(0).toUpperCase()}${key.slice(1)} ${value}`;
  }
}

const filterLocal = (items: Item[], q: string, fre: FrecencyMap): Item[] =>
  items
    .map((c) => ({ c, s: score(c, q) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || frecencyScore(fre[b.c.key]) - frecencyScore(fre[a.c.key]))
    .map((x) => x.c);

/**
 * Which "when" group a record created at `stamp` falls in, by the org-local day (lib/orgDay - never a UTC
 * slice, or late-evening records land on tomorrow): Today, Yesterday, This week, This month, Earlier.
 */
function whenLabel(stamp: string | undefined): string {
  if (!stamp) return "Date unknown";
  const day = stampDay(stamp);
  const today = todayStr();
  if (day >= today) return "Today";
  if (day === addDaysYmd(today, -1)) return "Yesterday";
  if (day >= weekStartYmd(today)) return "This week";
  if (day.slice(0, 7) === today.slice(0, 7)) return "This month";
  return "Earlier";
}

const statusLabel = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");

// One filter suggestion as a palette row. The detail always leads with the token itself, so picking from the
// list teaches the syntax that typing it would have needed.
function filterItem(s: FilterSuggestion<{ id: string; first: string; last: string; e: Employee }>, accept: (token: string) => void): Item {
  const base = { key: `filter:${s.token}`, badge: "Filter", tone: "action" as const, icon: ListFilter, stay: true, completes: true, run: () => accept(s.token) };
  // A `-` filter reads as what it keeps: everything except the thing named.
  const except = (negate: boolean | undefined, label: string) => (negate ? `Except ${label}` : label);
  switch (s.kind) {
    case "in":
      return { ...base, label: except(s.negate, entityLabel(s.collection)), detail: s.token };
    case "status": {
      const names = s.collections.slice(0, 3).map(entityLabel).join(", ");
      const more = s.collections.length > 3 ? ` +${s.collections.length - 3}` : "";
      return { ...base, label: except(s.negate, statusLabel(s.status)), detail: `${s.token} · ${names}${more}` };
    }
    case "person":
      return { ...base, label: except(s.negate, `${s.person.first} ${s.person.last}`), detail: [s.token, s.person.e.job_title].filter(Boolean).join(" · "), icon: User };
    case "is":
      if (s.negate) {
        return s.value === "team"
          ? { ...base, label: "Except my team", detail: `${s.token} · leaves out what belongs to your direct reports` }
          : { ...base, label: "Except mine", detail: `${s.token} · leaves out what belongs to you` };
      }
      return s.value === "team"
        ? { ...base, label: "My team", detail: `${s.token} · records that belong to your direct reports` }
        : { ...base, label: "Mine", detail: `${s.token} · records that belong to you` };
    case "dept":
      return s.negate
        ? { ...base, label: except(true, s.department.name), detail: `${s.token} · leaves out this department and the ones under it` }
        : { ...base, label: s.department.name, detail: `${s.token} · this department and the ones under it` };
    case "sort":
      return { ...base, label: "Newest first", detail: `${s.token} · instead of best match` };
    case "key":
      // A filter that can be turned round shows how, beside its plain example.
      return { ...base, label: s.label, detail: s.leaveOut ? `${s.example}   ·   leave out with ${s.leaveOut}` : s.example };
    case "date":
      return { ...base, label: s.label, detail: s.token, icon: CalendarDays };
  }
}

// One of a filter bar key's choices as it reads there: the bare value, since the key it sits under and the Keep /
// Leave out switch beside it say the rest ("Pending", not "Except Status: Pending").
function choiceLabel(s: FilterSuggestion): string {
  switch (s.kind) {
    case "in":
      return entityLabel(s.collection);
    case "status":
      return statusLabel(s.status);
    case "person":
      return `${s.person.first} ${s.person.last}`.trim();
    case "is":
      return s.value === "team" ? "My team" : "Me";
    case "dept":
      return s.department.name;
    case "sort":
      return "Newest first";
    case "date":
    case "key":
      return s.label;
  }
}

// A filter offered for typed words ("Filter by"), as its pill will read once it is taken - "Status: Pending",
// "Priya Shah", "Mine" - with a word that names several kinds saying how many.
function wordFilterLabel(s: FilterSuggestion): string {
  switch (s.kind) {
    case "in":
      return s.named ? `${entityLabel(s.token.slice(s.token.indexOf(":") + 1))} · ${s.named.length} kinds` : entityLabel(s.collection);
    case "status":
      return `Status: ${statusLabel(s.status)}`;
    case "dept":
      return `Department: ${s.department.name}`;
    case "is":
      return s.value === "team" ? "My team" : "Mine";
    default:
      return choiceLabel(s);
  }
}

/** A row's label or detail with the typed words marked where they matched (lib/paletteQuery.ts highlightParts). */
function Marked({ text, tokens }: { text: string; tokens: readonly string[] }) {
  return (
    <>
      {highlightParts(text, tokens).map((p, i) =>
        p.hit ? <mark key={i} className="rounded-sm bg-primary/15 font-semibold text-foreground">{p.text}</mark> : <span key={i}>{p.text}</span>,
      )}
    </>
  );
}

// ---- Categories and filters ---------------------------------------------------------------------------------
// The category chips, in one fixed order so the row never rearranges itself under the pointer while typing.
// Each record category is a tone (lib/entityKinds.ts) and narrows the search to that tone's collections;
// Pages lists the app's pages and settings panels instead of asking the server.
type Scope = "all" | "pages" | Extract<Tone, "people" | "time" | "work" | "docs" | "money" | "hiring" | "support">;
const SCOPES: { scope: Exclude<Scope, "all">; label: string }[] = [
  { scope: "people", label: "People" },
  { scope: "pages", label: "Pages" },
  { scope: "time", label: "Time" },
  { scope: "work", label: "Work" },
  { scope: "docs", label: "Docs" },
  { scope: "money", label: "Money" },
  { scope: "hiring", label: "Hiring" },
  { scope: "support", label: "Support" },
];
/** The categories this caller has anything to search in, with the collections each narrows to. */
function searchScopes(me: Me): { scope: Exclude<Scope, "all">; label: string; collections: string[] }[] {
  return SCOPES.flatMap((s) => {
    if (s.scope === "pages") return [{ ...s, collections: [] }];
    const collections = collectionsOfTone(s.scope).filter((c) => !!me.scopes.read[c]);
    return collections.length ? [{ ...s, collections }] : [];
  });
}

// A saved search also stores `refine` - an owner, a window and an order - which older saves fill in and new ones
// leave empty: those choices are filter words in the box, where the filter bar writes them. Running a saved
// search turns any it holds into those words (`refineAsWords`). lib/savedSearches.ts requires the field.
const EMPTY_REFINE: SavedSearch["refine"] = { owner: "", since: "", sort: "" };
/** A saved search's stored owner, window and order as the filter words they mean, less a key the words hold. */
function refineAsWords(refine: SavedSearch["refine"], query: string): string {
  return [
    (refine.owner === "mine" || refine.owner === "team") && !/(^|\s)(is:|@)\S/i.test(query) ? `is:${refine.owner}` : "",
    /^\d{1,4}d$/.test(refine.since) && !/(^|\s)(after|before|on|during):\S/i.test(query) ? `after:${refine.since}` : "",
    refine.sort === "new" && !/(^|\s)sort:\S/i.test(query) ? "sort:new" : "",
  ].filter(Boolean).join(" ");
}

// The filter bar's keys, as it names them; a key's choices are lib/paletteQuery.ts facetOffers.
const FACET_LABEL: Record<Facet, string> = { kind: "Kind", who: "Who", dept: "Department", status: "Status", when: "When" };
// The keys whose choices are a long list: after their choices, one more hands over to typing the key in the box,
// where its completions narrow as letters are typed.
const HAND_OFF: Partial<Record<Facet, { key: string; label: string }>> = {
  kind: { key: "in:", label: "Find a kind…" },
  who: { key: "@", label: "Someone else…" },
  dept: { key: "dept:", label: "Find a department…" },
};

// How a search ends: dismissed (Esc), or done (something was opened) - the inline field lets go of focus on
// the second, so the page's own shortcuts work again, and keeps it on the first, ready for another try.
type CloseHow = "dismiss" | "done";

// Everything the search does, whichever shell it is drawn in: the modal palette (CommandPalette) or the field
// in the top bar (InlineSearch). One hook, so the two can never answer the same words differently. `open` is
// whether its results are showing; `close` is the shell's way of putting them away.
function usePaletteSearch({ me, open, close }: { me: Me; open: boolean; close: (how: CloseHow) => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // Where the caret is, so the filter word it sits in can be completed. `pendingCaret` is where a completion
  // puts it once the new text has rendered.
  const inputRef = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(0);
  const pendingCaret = useRef<number | null>(null);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  // Ties the box to its listbox and to the row it is highlighting (aria-controls / aria-activedescendant).
  const listId = useId();
  const { org } = useOrg();
  const quickCfg = org.quick_actions;
  const am = useAccessMode();
  const lockEnabled = !!useAppLock().config?.enabled;
  // The create flows a nothing-found search can hand its words to, when this caller has them.
  const prefillable = useMemo(
    () => resolveQuickActionList(me, quickCfg).filter((a) => a.id === "new-ticket" || a.id === "new-suggestion"),
    [me, quickCfg],
  );
  const local = useMemo(() => {
    const built = buildLocal(me, quickCfg);
    // Access mode used to be reachable only from the user menu - a mode you had to know about to find. It is
    // an action like any other, so it belongs in ⌘K for the people who may use it.
    // The app lock is an action from anywhere, for everyone: lock now, or set it up.
    built.actions = [
      ...built.actions,
      lockEnabled
        ? { key: "action:lock", label: "Lock the app", badge: "Action", tone: "action", icon: Lock, run: () => void lockNow() }
        : { key: "action:lock", label: "Set up app lock (PIN)", badge: "Action", tone: "action", icon: Lock, run: () => openAppLockSettings({ setup: true }) },
    ];
    if (am.available) {
      built.actions = [
        ...built.actions,
        { key: "action:access-mode", label: am.enabled ? "Turn off access mode" : "Turn on access mode (manage who can see what)", badge: "Action", tone: "action", icon: KeyRound, run: am.toggle },
      ];
    }
    return built;
  }, [me, quickCfg, am.available, am.enabled, am.toggle, lockEnabled]);
  // Directory is server-scoped to who the caller may see, so people results never leak hidden employees.
  // Matching it locally gives instant people hits while the cross-collection search is still in flight;
  // identical server hits are deduped below. Read only once the palette has been OPENED: the shell mounts on
  // every page, so fetching it eagerly put a directory read on pages that never touch the directory (and
  // pages that DO show people load the same cached rows themselves). `opened` latches, so reopening is free.
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (open) setOpened(true);
  }, [open]);
  const { rows: employees } = useCollection<Employee>("employees", { all: true, enabled: opened });
  // The directory as `@name` and "did you mean" read it.
  const directory = useMemo(() => employees.map((e) => ({ id: idOf(e.path), first: e.first_name ?? "", last: e.last_name ?? "", e })), [employees]);
  // The category chip (PaletteChips): a narrowing the search already knows how to read - `in:` its collections -
  // so it is applied as those words, added to what was typed without being written into the box. Pages is not a
  // narrowing of records but of what the palette lists, so it is read where the list is built instead. Every
  // other filter is a word in the box, typed or written there by the filter bar.
  const [scope, setScopeState] = useState<Scope>("all");
  const scopes = useMemo(() => searchScopes(me), [me]);
  // The filter bar's open picker (FilterBar): which key, and whether its choices keep or leave out.
  const [facet, setFacet] = useState<{ facet: Facet; leaveOut: boolean } | null>(null);
  // The caller as an employee, and who reports to them: what Who and a bare `@` offer first. None for a caller
  // with no employee record, to whom "mine" and "my team" mean nothing (routes/search.ts).
  const reports = useMemo(
    () => (me.employee_id ? directory.filter((d) => !!d.e.manager && idOf(d.e.manager) === me.employee_id) : []),
    [directory, me.employee_id],
  );
  const self = useMemo(() => (me.employee_id ? { reports } : null), [me.employee_id, reports]);
  const askOn = useAiFeature("search.ask");
  const [ask, setAsk] = useState<AskState>({ status: "idle" });
  // An answer is about the question it was asked; editing the box makes it an answer to something else.
  useEffect(() => setAsk({ status: "idle" }), [query]);

  // What `in:` and `status:` can be completed with - the collections this caller may search, and their status
  // values. Asked for the first time somebody types one of those two words, types a word of three letters (which
  // the filter bar may offer as the status or kind it names), or opens the Kind or Status picker - not on open:
  // most opens go straight to a page, and the answer does not change within a session. A failure is asked again
  // the next time.
  const [vocabulary, setVocabulary] = useState<FilterVocabulary | null>(null);
  const vocabularyAsked = useRef(false);
  useEffect(() => {
    setVocabulary(null);
    vocabularyAsked.current = false;
  }, [me.email]);
  const wantsVocabulary = /^-?(in|status):/i.test(tokenAt(query, caret).text) || /(^|\s)[\p{L}\p{N}]{3}/u.test(query)
    || facet?.facet === "kind" || facet?.facet === "status";
  // The departments `dept:` completes with, read the first time somebody types it or opens the Department picker
  // - the cached list every department picker shares, and only the ones this caller may list.
  const [wantedDepartments, setWantedDepartments] = useState(false);
  const wantsDepartments = /^-?dept:/i.test(tokenAt(query, caret).text) || facet?.facet === "dept";
  useEffect(() => {
    if (wantsDepartments) setWantedDepartments(true);
  }, [wantsDepartments]);
  const { rows: departmentRows, state: departmentsState } = useCollection<Department>("departments", { all: true, enabled: wantedDepartments });
  const departments = useMemo(() => departmentRows.flatMap((d) => (d.display_name ? [{ name: d.display_name }] : [])), [departmentRows]);
  useEffect(() => {
    if (!wantsVocabulary || vocabulary || vocabularyAsked.current) return;
    vocabularyAsked.current = true;
    api<{ collections?: FilterVocabulary }>("/search:vocabulary")
      .then((r) => setVocabulary(r.collections ?? []))
      .catch(() => {
        vocabularyAsked.current = false;
      });
  }, [wantsVocabulary, vocabulary]);
  // How many records of each kind this caller can find by words (GET /v1/search:counts) - the `in:` suggestions'
  // totals when there are no other words to count results for (`kindSignals`). Asked the first time `in:` is typed, once
  // per page life like the vocabulary: one grouped read of the pre-counted table, not cheap enough to ask on
  // every keystroke, and a total a few records out of date still ranks the kinds the same way.
  const [kindTotals, setKindTotals] = useState<Record<string, number> | null>(null);
  const totalsAsked = useRef(false);
  useEffect(() => {
    setKindTotals(null);
    totalsAsked.current = false;
  }, [me.email]);
  const wantsTotals = /^-?in:/i.test(tokenAt(query, caret).text) || facet?.facet === "kind";
  useEffect(() => {
    if (!wantsTotals || kindTotals || totalsAsked.current) return;
    totalsAsked.current = true;
    api<{ counts?: Record<string, number> }>("/search:counts")
      .then((r) => setKindTotals(r.counts ?? {}))
      .catch(() => {
        totalsAsked.current = false;
      });
  }, [wantsTotals, kindTotals]);
  // What every filter offer is made from: the completions under the caret, and the filter bar's choices and the
  // filters it reads in the typed words.
  const filterCtx = useMemo(
    (): FilterContext<(typeof directory)[number]> => ({
      people: directory, vocabulary, labelOf: entityLabel, today: todayStr(), daysAgo30: orgDayFromToday(-30), departments, self,
    }),
    [directory, vocabulary, departments, self],
  );
  const filterOffers = useMemo(() => suggestFilters(query, caret, filterCtx), [query, caret, filterCtx]);
  // What is searched while a filter word is being completed: everything BUT that word. Half a filter (`in:tic`)
  // names nothing yet, and searched as typed it emptied the list at the moment the person was choosing what to
  // narrow it to; without it, the list goes on showing what the rest of the words find. A word typed out in
  // full - one of its own offers - is a filter already, and is searched.
  const searchText = useMemo(() => {
    if (!filterOffers) return query;
    const word = query.slice(filterOffers.start, filterOffers.end).toLowerCase();
    if (filterOffers.items.some((s) => s.token.toLowerCase() === word)) return query;
    return `${query.slice(0, filterOffers.start)} ${query.slice(filterOffers.end)}`.replace(/\s+/g, " ").trim();
  }, [query, filterOffers]);
  // The filter words in the box, each as a pill that says what it means and takes it out again (PaletteChips),
  // so every narrowing in force is in one line, whether it was typed or written there by the filter bar.
  const kinds = useMemo(() => scopes.flatMap((s) => s.collections), [scopes]);
  const typedFilters = useMemo(
    () => typedFilterWords(query, filterOffers ? { start: filterOffers.start, end: filterOffers.end } : null).map((w) => ({
      ...w,
      label: filterWordLabel(w.word, directory, kinds),
      problem: filterWordProblem(w.word, { people: directory, kinds, vocabulary, today: todayStr() }),
    })),
    [query, filterOffers, directory, kinds, vocabulary],
  );
  // The box's text as runs for the highlight drawn behind it (QueryHighlight): plain words as typed, each
  // filter word split into its key and its value, and flagged when it names nothing.
  const runs = useMemo(() => {
    const out: HighlightRun[] = [];
    let at = 0;
    for (const w of typedFilters) {
      if (w.start > at) out.push({ text: query.slice(at, w.start) });
      const keyEnd = w.word.startsWith("@") ? 1 : w.word.startsWith("-@") ? 2 : w.word.indexOf(":") + 1;
      out.push({ text: w.word, filter: { key: w.word.slice(0, keyEnd), value: w.word.slice(keyEnd), problem: w.problem } });
      at = w.end;
    }
    if (at < query.length) out.push({ text: query.slice(at) });
    return out;
  }, [query, typedFilters]);
  // A typed `in:` names the kinds itself, and it wins over the category chip: added together, the two asked
  // for both sets of collections - a WIDER search than either - which is never what either one meant.
  const typedKinds = /(^|\s)-?in:\S/i.test(searchText);
  const scopeWords = typedKinds ? "" : scopes.find((s) => s.scope === scope)?.collections.map((c) => `in:${c}`).join(" ") ?? "";
  const parsed = useMemo(
    () => parsePaletteQuery([searchText, scopeWords].filter(Boolean).join(" "), directory, todayStr()),
    [searchText, scopeWords, directory],
  );
  const narrowed = isNarrowed(parsed);
  // The same words without the category: what the chips count against, whichever one is on.
  const unscoped = useMemo(
    () => (scopeWords ? parsePaletteQuery(searchText, directory, todayStr()) : parsed),
    [scopeWords, searchText, directory, parsed],
  );
  // New text for the box that the person did not type (a completion, a recent search, See all), with the caret
  // put where it belongs - the end, unless said otherwise - so the word being completed is the right one. The box
  // takes the focus with it, unless `focus` is false: a press from the filter bar made with the keyboard, whose
  // focus stays in the bar.
  const replaceQuery = (text: string, at = text.length, { focus = true }: { focus?: boolean } = {}) => {
    if (focus) pendingCaret.current = at;
    setQuery(text);
    setCaret(at);
    setActive(0);
  };
  // Accepting a suggestion swaps the word under the caret for it and leaves the caret after it, ready for the
  // next word - or, in a box that starts with `?`, swaps the whole box, since all of it was asking for the
  // filter. Read off the input itself so a row built a render ago still edits what is in the box now.
  const acceptFilter = (token: string) => {
    const raw = inputRef.current?.value ?? query;
    const span = isGuideQuery(raw) ? { start: 0, end: raw.length } : tokenAt(raw, inputRef.current?.selectionStart ?? caret);
    const next = applySuggestion(raw, span, token);
    replaceQuery(next.query, next.caret);
  };
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (pendingCaret.current === null || !el) return;
    el.focus();
    el.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [query]);

  // Reset query + selection whenever the results are put away - on closing, not on opening: the inline field
  // opens on the first keystroke typed into it, and a reset then would throw that keystroke away.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setCaret(0);
      setActive(0);
      setHits([]);
      setHitsKey("");
    }
  }, [open]);

  // Cross-collection search. The server side is an FTS index lookup, so a query is cheap and the guards here
  // are about not sending pointless requests rather than about cost:
  //   1. debounce + a 2-character floor, matching the server's minimum (pages, actions and cached people
  //      still match from the first character, with no request at all),
  //   2. a per-session result cache, so backspacing to a query already run re-renders instead of refetching.
  // Responses are sequence-guarded, so a slow reply can never overwrite a newer one.
  //
  // NO DEAD-PREFIX SKIP. Keyword matching is by token prefix, so "abc" finding nothing once meant no extension
  // of it could find anything, and those requests were skipped. The semantic half broke that: "vacat" can find
  // nothing while "vacation" finds Earned Leave, and the skip meant the second request was never sent. A miss
  // on the keyword index reads no rows, so the skip was saving very little.
  const seq = useRef(0);
  const cache = useRef(new Map<string, SearchHit[]>());
  // Bumped after a decision made from the palette, so the results re-read what that decision changed.
  const [refreshTick, setRefreshTick] = useState(0);
  // Keyed by the whole request, narrowing included: `in:tickets laptop` and `laptop` are different questions.
  // Filters with no words at all are a question too - "which records are these" - which the server answers
  // with the newest ones; a single stray letter after them is still waited on, and so is a `-@name` that does
  // not name one person yet (lib/paletteQuery.ts `incomplete`).
  const plainWords = parsed.text.trim();
  const keyOf = (q: PaletteQuery) => (!q.incomplete && (plainWords.length >= 2 || (isNarrowed(q) && !plainWords)) ? searchParams(q) : "");
  // Pages asks the server nothing: pages and settings panels are listed from the app itself. Nor does a box
  // that starts with `?`, which lists the filters alone, even under a category chip.
  const requestKey = scope === "pages" || isGuideQuery(query) ? "" : keyOf(parsed);
  const unscopedKey = keyOf(unscoped);
  // WHICH request the hits on screen answer. Between a keystroke and the effect below flipping `searching`
  // there is a render where the hits are still the last query's (or none), and anything that concludes
  // "nothing was found" from that render - Did you mean, the nothing-found offers, the spoken count - flashed
  // for a result that had not arrived yet. `settled` is the honest version of "the answer is in".
  const [hitsKey, setHitsKey] = useState("");
  const settled = !searching && hitsKey === requestKey;
  // A request that failed, by the request it was. Shown as the failure it is: read as "no records", it offered
  // Did you mean and a ticket for words that were never searched at all.
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const failed = settled && !!requestKey && failure?.key === requestKey;
  useEffect(() => {
    if (!open) return;
    const key = requestKey;
    if (!key) {
      setHits([]);
      setHitsKey("");
      setSearching(false);
      return;
    }
    const cached = cache.current.get(key);
    if (cached) {
      seq.current++;
      setHits(cached);
      setHitsKey(key);
      setSearching(false);
      return;
    }
    const mine = ++seq.current;
    setSearching(true);
    const timer = setTimeout(() => {
      api<SearchPage>(`/search?${key}`)
        .then((r) => {
          const results = r.results ?? [];
          cache.current.set(key, results);
          if (seq.current === mine) {
            setHits(results);
            setHitsKey(key);
          }
        })
        .catch((e: unknown) => {
          if (seq.current === mine) {
            setHits([]); // never cached: a failure says nothing about the data
            setHitsKey(key);
            setFailure({ key, message: (e as Error).message || "the request did not go through" });
          }
        })
        .finally(() => {
          if (seq.current === mine) setSearching(false);
        });
    }, 220);
    return () => clearTimeout(timer);
  }, [requestKey, open, refreshTick]);

  // With a category on, the other chips count against the answer WITHOUT it (chipCounts), which is only in the
  // cache if All has already been asked these exact words. So ask it alongside, debounced like the main request
  // and guarded by its own sequence: one more request per settled search while a category is on, none while
  // All is - where the main request IS the unscoped one. A failure just leaves the counts off.
  const countSeq = useRef(0);
  const [countsIn, setCountsIn] = useState(0);
  useEffect(() => {
    if (!open || !unscopedKey || unscopedKey === requestKey || cache.current.has(unscopedKey)) return;
    const mine = ++countSeq.current;
    const timer = setTimeout(() => {
      api<SearchPage>(`/search?${unscopedKey}`)
        .then((r) => {
          cache.current.set(unscopedKey, r.results ?? []);
          if (countSeq.current === mine) setCountsIn((n) => n + 1);
        })
        .catch(() => {});
    }, 220);
    return () => clearTimeout(timer);
  }, [unscopedKey, requestKey, open]);

  // Tab on a result: the decisions this caller can make on it, loaded from the record itself (its `access.can`
  // and state), so what is offered is what the server would allow.
  const [actions, setActions] = useState<ActionsState | null>(null);
  const confirm = useConfirm();
  const askReason = useAskReason();
  const { toast } = useToast();
  const allowSelfApproval = useSelfApprovalAllowed();
  useEffect(() => setActions(null), [query, open]);

  // Records read whole for a result - its decisions, its preview - kept for this opening of the search, so the
  // highlight going back and forth over the same rows reads each one once. Dropped on close (a decision taken
  // elsewhere between two openings must not be shown as still waiting), and per record after a decision here.
  const records = useRef(new Map<string, PeekRow>());
  const readRecord = async (name: string): Promise<PeekRow> => {
    const known = records.current.get(name);
    if (known) return known;
    const row = await api<PeekRow>(`/${name}`);
    records.current.set(name, row);
    return row;
  };
  useEffect(() => {
    if (!open) records.current.clear();
  }, [open]);
  // The record behind the lit row, once read: what the row's decision buttons and the preview pane show.
  const [peek, setPeek] = useState<{ name: string; row: PeekRow } | null>(null);
  // Whether the shell has room for the preview pane right now (InlineSearch measures its drop-down).
  const [previewable, setPreviewable] = useState(false);

  // Drop the cache when the palette closes: a write made between two openings must not be masked by a stale
  // "no results" from the previous session.
  useEffect(() => {
    if (!open) cache.current.clear();
  }, [open]);

  // Re-read frecency each time the palette opens (another tab may have bumped it since).
  const frecent = useMemo(() => (open ? loadFrecency(me.email) : {}), [open, me.email]);
  // And the last few searches that led somewhere, for the empty box.
  // `recentCleared` re-reads them after "Clear recent searches".
  const [recentCleared, setRecentCleared] = useState(0);
  const recentQueries = useMemo(() => (open ? loadRecentQueries() : []), [open, recentCleared]); // eslint-disable-line react-hooks/exhaustive-deps

  // The box without its filter words - last first, so each cut leaves the earlier positions where they were.
  const withoutTyped = () => {
    let raw = inputRef.current?.value ?? query;
    for (const w of [...typedFilters].reverse()) raw = raw.slice(0, w.start) + raw.slice(w.end);
    return raw.replace(/\s+/g, " ").trimStart();
  };
  // Saved searches (lib/savedSearches.ts): read the first time the search is opened.
  const savedSearches = useSavedSearches(opened);
  // Which kinds this person narrows to and opens (lib/searchKinds.ts), and which the page behind the search
  // shows: the two things the `in:` suggestions are ranked by after the typed words (rankKindOffers).
  const kindAffinity = useKindAffinity(opened);
  const route = useRoute();
  const pageKinds = useMemo(() => collectionsOnRoute([route.page, route.id, route.sub].filter(Boolean).join("/")), [route.page, route.id, route.sub]);
  // Running one puts back everything it was saved with - words and category - and leaves the caret after the
  // words, ready for one more. A category this caller no longer has falls back to none rather than to a
  // narrowing they cannot see; an owner, window or order stored by an older save comes back as its words.
  const applySaved = (s: SavedSearch) => {
    const knownScope = s.scope === "all" || scopes.some((x) => x.scope === s.scope);
    setScopeState(knownScope ? (s.scope as Scope) : "all");
    const words = [s.query, refineAsWords(s.refine, s.query)].filter(Boolean).join(" ");
    replaceQuery(words ? `${words} ` : "");
  };
  // The name a new saved search is offered under, said the way its pills say it: "Time · Status: Pending · leave".
  const suggestedName = [
    ...(scope !== "all" && !typedKinds ? [scopes.find((s) => s.scope === scope)?.label ?? ""] : []),
    ...typedFilters.map((w) => w.label),
    parsed.text.trim(),
  ].filter(Boolean).join(" · ") || "My search";

  // Every narrowing off - the category and the filter words in the box - keeping the words.
  const widen = () => {
    setScopeState("all");
    replaceQuery(withoutTyped());
  };

  const sections = useMemo((): Section[] => {
    // Showing one record's actions replaces the list until Esc or ← goes back to it.
    if (actions) {
      const back: Item = { key: "actions:back", label: "Back to results", badge: "Back", tone: "page", icon: ArrowLeft, stay: true, run: () => setActions(null) };
      const verbs: Item[] = actions.verbs.map((v) => ({
        key: `actions:${v.verb}`,
        label: `${v.label}: ${actions.item.label}`,
        detail: actions.item.detail,
        badge: v.label,
        tone: "action",
        icon: v.verb === "approve" ? Check : Ban,
        stay: true,
        run: () => void decide(v.verb),
      }));
      const label = actions.status === "loading" ? "Loading actions…"
        : actions.status === "error" ? `Could not load actions: ${actions.message ?? "try again"}`
        : verbs.length ? "Actions" : "Nothing to decide on this one";
      return [{ label, items: [...verbs, back] }];
    }
    // What is searched, not what is in the box: a lone filter word still being typed (`in:`) is no search
    // yet, so the catalogue stays under its suggestions.
    const q = searchText.trim().toLowerCase();
    // The filter guide (`?`, a bare `-`) leads whatever list is showing: it is what was just asked for.
    const guide = filterOffers?.items[0]?.kind === "key" ? filterOffers.items.map((s) => filterItem(s, acceptFilter)) : null;
    const withGuide = (list: Section[]) => (guide ? [{ label: "Filters", items: guide }, ...list] : list);
    // A box that starts with `?` asks only about the filters: the guide, narrowed by what follows, and nothing else.
    if (isGuideQuery(query)) return guide ? [{ label: "Filters", items: guide }] : [];
    // The Pages chip: the app's own pages and settings panels, matched on the words (all of them for none).
    if (scope === "pages") {
      const text = parsed.text.trim().toLowerCase();
      return withGuide([
        { label: "Pages", items: text ? filterLocal(local.pages, text, frecent) : local.pages },
        { label: "Settings", items: text ? filterLocal(local.settings, text, frecent) : local.settings },
      ].filter((s) => s.items.length > 0));
    }
    // A category or a filter with nothing typed is a question too - the newest records it names - so only the
    // bare box shows the catalogue.
    if (!q && scope === "all") {
      // Empty query: this user's most-opened targets first, then the full catalogue.
      const all = [...local.actions, ...local.pages, ...local.settings];
      const recent = all
        .map((i) => ({ i, f: frecencyScore(frecent[i.key]) }))
        .filter((x) => x.f > 0)
        .sort((a, b) => b.f - a.f)
        .slice(0, 5)
        .map((x) => x.i);
      // The searches that ended in something being opened - running one again puts the words back in the box.
      const searches: Item[] = recentQueries.map((s) => ({
        key: `recent-search:${s}`,
        label: s,
        badge: "Search",
        tone: "action",
        icon: History,
        stay: true,
        run: () => replaceQuery(s),
      }));
      // They are this person's own words, kept on this machine, so there is a way to wipe them from here.
      if (searches.length) {
        searches.push({
          key: "recent-search:clear",
          label: "Clear recent searches",
          badge: "Clear",
          tone: "action",
          icon: X,
          stay: true,
          run: () => {
            clearRecentQueries();
            setRecentCleared((n) => n + 1);
            setActive(0);
          },
        });
      }
      return withGuide([
        { label: "Recent searches", items: searches },
        { label: "Recent", items: recent },
        { label: "Actions", items: local.actions },
        { label: "Pages", items: local.pages },
        { label: "Settings", items: local.settings },
      ].filter((s) => s.items.length > 0));
    }

    const text = parsed.text.trim().toLowerCase();
    const personItem = (e: Employee): Item => ({
      key: `employees/${idOf(e.path)}`,
      label: `${e.first_name} ${e.last_name}`,
      detail: e.job_title,
      badge: "Person",
      tone: "people",
      icon: User,
      route: `employees/${idOf(e.path)}`,
      source: "local",
    });
    // What this person opens most, first, within each group - the server's order otherwise.
    const byFrecency = (items: Item[]) =>
      items
        .map((it, i) => ({ it, i, f: frecencyScore(frecent[it.key]) }))
        .sort((a, b) => b.f - a.f || a.i - b.i)
        .map((x) => x.it);

    // People from the cached directory — instant, and the route matches the server's `employees/<id>` hit
    // exactly, so the dedupe below keeps whichever arrives without ever showing the person twice. Not for a
    // narrowed query: `in:tickets` or `@priya` is asking about records, not about who works here.
    const people: Item[] = narrowed || !text
      ? []
      : employees
          .filter((e) => `${e.first_name} ${e.last_name} ${e.work_email ?? ""} ${e.job_title ?? ""}`.toLowerCase().includes(text))
          .slice(0, 6)
          .map(personItem);

    // Records from the server, grouped by collection so a list of 40 mixed rows stays scannable. Related hits
    // (found by meaning, not by the typed words) are kept out of those groups and shown last, under their own
    // heading: mixed in, a suggestion read as a match, and a loose one read as the search being broken.
    const seen = new Set(people.map((p) => p.route));
    const byCollection = new Map<string, Item[]>();
    // Newest first (`sort:new`, typed or from the Filters menu), the same rows group by WHEN instead: the order
    // already says time matters more than kind, and a kind heading every few rows would chop it up. Buckets by
    // the org-local day of the record's creation, in the server's own newest-first order.
    const byWhen = new Map<string, Item[]>();
    const newestFirst = parsed.sort === "new";
    const related: Item[] = [];
    for (const h of hits) {
      const route = resourceRoute(h.collection, h.name);
      if (!route || seen.has(route)) continue;
      seen.add(route);
      const item: Item = {
        key: h.name,
        label: h.title || entityLabelSingular(h.collection),
        detail: h.subtitle,
        badge: entityLabelSingular(h.collection),
        tone: toneOf(h.collection),
        icon: h.collection === "employees" ? User : iconOf(h.collection),
        route,
        source: h.related ? "related" : "keyword",
        record: { name: h.name, collection: h.collection },
      };
      if (h.related) {
        related.push(item);
        continue;
      }
      if (newestFirst) {
        const when = whenLabel(h.create_time);
        byWhen.set(when, [...(byWhen.get(when) ?? []), item]);
        continue;
      }
      const bucket = byCollection.get(h.collection);
      if (bucket) bucket.push(item);
      else byCollection.set(h.collection, [item]);
    }

    const out: Section[] = [];
    // The Ask answer, when there is one, leads the results: it is what the person pressed Enter for.
    if (ask.status === "done") {
      const all = [...local.actions, ...local.pages, ...local.settings];
      const picks: Item[] = ask.answer.destinations
        .map((d): Item | null => {
          const target = all.find((i) => i.key === d.key);
          return target ? { ...target, key: `ask:${target.key}`, detail: d.why } : null;
        })
        .filter((i): i is Item => i !== null);
      const words = ask.answer.search;
      if (words) {
        picks.push({ key: `ask-search:${words}`, label: `Search records for "${words}"`, badge: "Search", tone: "action", icon: Search, stay: true, run: () => replaceQuery(words) });
      }
      out.push({ label: picks.length ? "Answer" : "No answer - nothing here fits that question", items: picks });
    }

    const actionItems = narrowed ? [] : filterLocal(local.actions, text, frecent);
    const pages = narrowed ? [] : filterLocal(local.pages, text, frecent);
    const settings = narrowed ? [] : filterLocal(local.settings, text, frecent);
    if (actionItems.length) out.push({ label: "Actions", items: actionItems });
    if (people.length) out.push({ label: "People", items: people });
    if (pages.length) out.push({ label: "Pages", items: pages });
    if (settings.length) out.push({ label: "Settings", items: settings });
    for (const [collection, found] of byCollection) {
      const items = byFrecency(found);
      // Narrowed to this type already, the whole list is the point; otherwise the top few, and one row that
      // re-asks the same words of this type alone, which the server answers with up to SERVER_TOTAL of them.
      const capped = narrowed || items.length <= PER_SECTION ? items : items.slice(0, PER_SECTION);
      if (capped.length < items.length) {
        const plural = entityLabel(collection).toLowerCase();
        // Written in the box with the kind's own name (`in:tasks`), as the suggestions write it (inWordOf).
        const next = `in:${inWordOf(collection, kinds)} ${parsed.text}`.trim();
        capped.push({
          key: `see-all:${collection}`,
          label: `See all ${plural}`,
          detail: `${items.length}${hits.length >= SERVER_TOTAL ? "+" : ""} found`,
          badge: "Show",
          tone: "action",
          icon: ListFilter,
          stay: true,
          run: () => replaceQuery(next),
        });
      }
      out.push({ label: entityLabel(collection), items: capped });
    }
    // Whole, not capped: "See all" re-asks one kind, and these groups are not kinds.
    for (const [when, items] of byWhen) out.push({ label: when, items });
    if (related.length) out.push({ label: "Related", items: related });

    // The records half failed: say so, with the way to ask again. None of the "nothing found" offers below
    // apply - nothing was searched.
    if (failed) {
      out.push({
        label: `Couldn't search records: ${failure!.message}`,
        items: [{ key: "search-retry", label: "Search again", badge: "Retry", tone: "action", icon: Search, stay: true, run: () => setRefreshTick((t) => t + 1) }],
      });
    }

    // Nothing matched a name, and nothing at all came back: offer the people one slip away ("Kpoor").
    if (!narrowed && settled && !failed && people.length === 0 && byCollection.size === 0 && text.length >= 4) {
      const near = nearPeople(text, directory).map((d) => personItem(d.e));
      if (near.length) out.push({ label: "Did you mean", items: near });
    }

    // And when there is still nothing at all, the thing to do next is usually to ask a person: the caller's own
    // "raise a ticket" / "submit a suggestion", started with the words they searched for. Only the actions this
    // caller already has (resolveQuickActionList), so nothing is offered that they cannot do.
    if (!narrowed && settled && !failed && text.length >= 3 && out.every((s) => s.items.length === 0)) {
      const words = parsed.text.trim();
      const offers: Item[] = prefillable.map((a) => ({
        key: `nothing-found:${a.id}`,
        label: `${a.label}: "${words}"`,
        detail: a.id === "new-ticket" ? "Nothing here matched - ask the helpdesk" : "Nothing here matched - suggest it",
        badge: "Action",
        tone: "action",
        icon: a.icon,
        run: () => runQuickAction(a, a.id === "new-ticket" ? { subject: words } : { title: words }),
      }));
      if (offers.length) out.push({ label: "Nothing found", items: offers });
    }

    // Narrowed to nothing: the way out is one row, not a hunt for which pill or chip to take off. It says what
    // it lets go of, and keeps the words.
    if (narrowed && settled && !failed && out.every((s) => s.items.length === 0)) {
      const letGo = [
        ...(scope !== "all" && !typedKinds ? [scopes.find((s) => s.scope === scope)?.label ?? ""] : []),
        ...typedFilters.map((w) => w.label),
      ].filter(Boolean);
      out.push({
        label: "Nothing with these filters",
        items: [{
          key: "widen",
          label: parsed.text.trim() ? `Search everything for "${parsed.text.trim()}"` : "Search everything",
          detail: letGo.length ? `Without ${letGo.join(", ")}` : null,
          badge: "Widen",
          tone: "action",
          icon: ListFilter,
          stay: true,
          run: widen,
        }],
      });
    }

    // Ask, last and only when switched on: a question is not a search, so it never displaces the results.
    if (askOn && !narrowed && looksLikeQuestion(parsed.text) && ask.status !== "done") {
      out.push({
        label: "Ask",
        items: [{
          key: "ask",
          label: ask.status === "loading" ? "Asking…" : `Ask: "${parsed.text.trim()}"`,
          detail: ask.status === "error" ? ask.message : "Point me to where this is answered",
          badge: "Ask",
          tone: "action",
          icon: Sparkles,
          stay: true,
          run: () => void runAsk(),
        }],
      });
    }
    return withGuide(out);
    // `runAsk` and `acceptFilter` read the same state this memo does, so listing them would only rebuild the
    // list twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local, employees, directory, hits, query, searchText, parsed, narrowed, frecent, recentQueries, ask, askOn, settled, failed, failure, prefillable, actions, scope, filterOffers, typedKinds, typedFilters, scopes, kinds]);

  // What each category chip would show for these words. Counted against the answer WITHOUT the category -
  // the one All shows, asked alongside while a chip is on (countSeq above) - so pressing a chip never changes
  // the numbers on the others. Records by their tone; Pages by the pages and settings panels the words match (none once a
  // filter narrows to records). Nothing typed, or a reply not in yet, leaves the counts off rather than zero.
  // The records the words found WITHOUT the category - the main answer under All, the background one (countSeq)
  // under a category - or undefined while it is not in. What both the category chips and the `in:` suggestions
  // count. `countsIn` is that background answer landing in the cache, which a ref cannot announce.
  const unscopedRecords = useMemo(
    () => (!unscopedKey ? undefined : scope === "all" ? (settled ? hits : undefined) : cache.current.get(unscopedKey)),
    [unscopedKey, scope, settled, hits, countsIn], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const chipCounts = useMemo(() => {
    const text = unscoped.text.trim().toLowerCase();
    if (!text) return null;
    const pages = isNarrowed(unscoped) ? 0 : filterLocal(local.pages, text, frecent).length + filterLocal(local.settings, text, frecent).length;
    const records = unscopedRecords;
    if (!records) return { pages, byTone: null, total: undefined };
    const byTone = new Map<string, number>();
    for (const h of records) byTone.set(toneOf(h.collection), (byTone.get(toneOf(h.collection)) ?? 0) + 1);
    return { pages, byTone, total: pages + records.length };
  }, [unscoped, unscopedRecords, local, frecent]);

  // What the `in:` suggestions are ranked by and count (paletteQuery.ts rankKindOffers). With other words in the
  // box, how many of the results those words found are of each kind - free, it is the answer already loaded, and
  // "12+" when it reached the server's cap; with none, how many records of each kind words can find
  // (`kindTotals`). Plus the page behind the search, this person's use of each kind, and which kinds are
  // catalogs rather than records.
  const kindSignals = useMemo(() => {
    const words = !!unscoped.text.trim();
    let results: { by: Map<string, number>; capped: boolean } | undefined;
    if (words && unscopedRecords) {
      const by = new Map<string, number>();
      for (const h of unscopedRecords) by.set(h.collection, (by.get(h.collection) ?? 0) + 1);
      results = { by, capped: unscopedRecords.length >= SERVER_TOTAL };
    }
    return {
      results,
      totals: !words && kindTotals ? new Map(Object.entries(kindTotals)) : undefined,
      pageKinds,
      affinity: kindAffinity.affinity,
      reference: new Set((vocabulary ?? []).filter((v) => v.reference).map((v) => v.collection)),
    };
  }, [unscoped, unscopedRecords, kindTotals, pageKinds, kindAffinity.affinity, vocabulary]);
  const countOf = (s: Exclude<Scope, "all">) =>
    !chipCounts ? undefined : s === "pages" ? chipCounts.pages : chipCounts.byTone ? (chipCounts.byTone.get(s) ?? 0) : undefined;
  // Every category this caller can search, always and in the same order; one with nothing for these words is
  // greyed rather than dropped, so the row holds still while typing. Not while a record's actions are showing.
  // A typed `in:` decides the kinds instead (see `typedKinds`), so the categories stand aside for it: All is
  // shown on and the rest are greyed, with the reason on hover.
  const kindsTyped = "A kind typed in the box (in:) decides what is searched";
  const chips = actions
    ? null
    : [
        { value: "all" as Scope, label: "All", count: chipCounts?.total },
        ...scopes.map((s) => {
          const count = countOf(s.scope);
          return typedKinds
            ? { value: s.scope as Scope, label: s.label, disabled: true, title: kindsTyped }
            : { value: s.scope as Scope, label: s.label, count, disabled: count === 0 && scope !== s.scope };
        }),
      ];
  // Back to the box after a chip or a filter, so the arrows and Enter go on working on the rows.
  const setScope = (next: Scope) => {
    setScopeState(next);
    setActive(0);
    inputRef.current?.focus();
  };
  useEffect(() => {
    if (!open) {
      setScopeState("all");
      setFacet(null);
    }
  }, [open]);

  // ---- The filter bar (FilterBar) ----
  // Its keys show wherever records can be narrowed: not under Pages (pages are not records), not in a box that
  // starts with `?` (the list is the filter list then), and not while a record's actions stand in for the list.
  const barOn = !actions && scope !== "pages" && !isGuideQuery(query);
  useEffect(() => {
    if (!barOn) setFacet(null);
  }, [barOn]);
  // How many filters each key has on in the box, and whether the order is newest first.
  const facetCounts = useMemo(() => {
    const counts = new Map<Facet | "sort", number>();
    for (const w of typedFilters) {
      const f = facetOf(w.word);
      if (f) counts.set(f.facet, (counts.get(f.facet) ?? 0) + 1);
    }
    return counts;
  }, [typedFilters]);
  const newestOn = typedFilters.some((w) => w.word.toLowerCase() === "sort:new");
  // The keys, in one fixed order, less the ones that cannot narrow this search: Department for a caller who may
  // not list departments, Status once the vocabulary says none of the kinds in play has one. A key with a filter
  // on stays, whatever it is, so what is on can always be seen and changed where it was set.
  const statusless = useMemo(() => {
    if (!vocabulary) return false;
    const inPlay = parsed.in.length ? new Set(parsed.in.flatMap((w) => collectionsNamedBy(w, vocabulary.map((v) => v.collection)))) : null;
    return !vocabulary.some((v) => (!inPlay || inPlay.has(v.collection)) && v.statuses.length > 0);
  }, [vocabulary, parsed]);
  const facetKeys = !barOn ? [] : (["kind", "who", "dept", "status", "when"] as const)
    .filter((f) => (facetCounts.get(f) ?? 0) > 0
      || (f === "kind" ? kinds.length > 0 : f === "dept" ? !!me.scopes.read.departments : f === "status" ? !statusless : true))
    .map((f) => ({ facet: f, label: FACET_LABEL[f], count: facetCounts.get(f) ?? 0 }));
  // The open key's choices (lib/paletteQuery.ts facetOffers). Kinds come ranked as the `in:` completions are,
  // with their counts, and the ones already on first; When is counted from the loaded results while no date
  // filter is on (a count then would describe a set already cut down by one). Statuses are the category's too.
  const facetChoices = useMemo(() => {
    if (!facet || !barOn) return null;
    const raw = facet.facet === "status" && scopeWords ? `${query} ${scopeWords}` : query;
    const offers = facetOffers(facet.facet, raw, { ...filterCtx, leaveOut: facet.leaveOut });
    type Choice = { offer: (typeof offers)[number]; count?: string; muted?: boolean };
    if (facet.facet === "kind") {
      const ranked = rankKindOffers(offers.flatMap((o) => (o.suggestion.kind === "in" ? [{ collection: o.suggestion.collection, o }] : [])), kindSignals);
      const choices = ranked.map((r): Choice => ({ offer: r.offer.o, count: r.count, muted: r.muted }));
      return [...choices.filter((c) => c.offer.pressedBy.length), ...choices.filter((c) => !c.offer.pressedBy.length)];
    }
    if (facet.facet === "when" && settled && requestKey && !parsed.after && !parsed.before) {
      const counts = whenCounts(hits.flatMap((h) => (h.create_time ? [stampDay(h.create_time)] : [])), todayStr());
      const capped = hits.length >= SERVER_TOTAL;
      return offers.map((o): Choice => {
        const n = counts.get(o.suggestion.token) ?? 0;
        return { offer: o, count: `${n.toLocaleString()}${capped ? "+" : ""}`, muted: n === 0 };
      });
    }
    return offers.map((o): Choice => ({ offer: o }));
  }, [facet, barOn, query, scopeWords, filterCtx, kindSignals, settled, requestKey, parsed, hits]);
  // Whether the open key's choices are still being read: the vocabulary for Kind and Status, the departments.
  const facetLoading = facet?.facet === "kind" || facet?.facet === "status" ? !vocabulary
    : facet?.facet === "dept" ? departmentsState === "loading" && departments.length === 0 : false;
  // The filters the typed words name, for the bar's "Filter by" (lib/paletteQuery.ts filtersForWords).
  const wordFilters = useMemo(
    () => (barOn ? filtersForWords(query, { ...filterCtx, kinds, scope: scopeWords ? scopes.find((s) => s.scope === scope)?.collections : undefined }) : []),
    [barOn, query, filterCtx, kinds, scopeWords, scopes, scope],
  );
  // Every press in the bar edits the box as it is now - read off the input, as acceptFilter does - and leaves the
  // caret at the end, ready for the next word. `keys`: the press came from the keyboard, whose focus stays in the
  // bar (FilterBar); from a pointer, the box takes the focus back.
  const liveQuery = () => inputRef.current?.value ?? query;
  const editFromBar = (text: string, keys: boolean) => replaceQuery(text, text.length, { focus: !keys });
  const openFacet = (f: Facet, keys: boolean) => {
    setFacet((cur) => (cur?.facet === f ? null : { facet: f, leaveOut: false }));
    if (!keys) inputRef.current?.focus();
  };
  /** Presses one of the open key's choices; true when that closes the picker (a key that holds one value got it). */
  const pickFacet = (o: FacetOffer<(typeof directory)[number]>, keys: boolean): boolean => {
    const s = o.suggestion;
    editFromBar(applyFacetPick(liveQuery(), { token: s.token, pressedBy: o.pressedBy }), keys);
    if (s.kind === "in" && !s.negate && !o.pressedBy.length) kindAffinity.bump(s.collection);
    const f = facetOf(s.token);
    const done = !!f && !f.negate && f.facet !== "kind" && !o.pressedBy.length;
    if (done) setFacet(null);
    return done;
  };
  // Takes a "Filter by" offer: its filter goes in the place of the words that named it.
  const takeWordFilter = (w: WordFilter<(typeof directory)[number]>, keys: boolean) => {
    const raw = liveQuery();
    if (raw.slice(w.start, w.end) !== w.words) return; // the box changed under it; the next render offers afresh
    const after = raw.slice(w.end);
    editFromBar(`${raw.slice(0, w.start)}${w.suggestion.token}${after.trim() ? after : " "}`.replace(/\s+/g, " ").trimStart(), keys);
    if (w.suggestion.kind === "in" && !w.suggestion.named) kindAffinity.bump(w.suggestion.collection);
  };
  // A long list's last choice: the key itself, written at the end of the box with the caret after it, so its
  // completions take over as the person types (`-` first while leaving out).
  const handOff = (f: Facet) => {
    const key = HAND_OFF[f]?.key;
    if (!key) return;
    const raw = liveQuery().trimEnd();
    const word = `${facet?.leaveOut ? "-" : ""}${key}`;
    setFacet(null);
    replaceQuery(`${raw}${raw ? " " : ""}${word}`);
  };
  const toggleNewest = (keys: boolean) => {
    const raw = liveQuery();
    editFromBar(applyFacetPick(raw, { token: "sort:new", pressedBy: (raw.match(/\S+/g) ?? []).filter((w) => w.toLowerCase() === "sort:new") }), keys);
  };

  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  // Clamp the active row whenever the result set shrinks.
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, flat.length - 1)));
  }, [flat.length]);

  // Ask: the question and the destinations this palette offers (so the answer can only name places this person
  // can already open), sent on Enter only - never while typing.
  const runAsk = async () => {
    const question = parsed.text.trim();
    if (!askOn || !question || ask.status === "loading") return;
    setAsk({ status: "loading", question });
    const destinations = [...local.actions, ...local.pages, ...local.settings].map((i) => ({ key: i.key, label: i.label, group: i.detail ?? i.badge }));
    try {
      const answer = await api<AskAnswer>("/search:ask", { method: "POST", body: JSON.stringify({ question, destinations }) });
      setAsk({ status: "done", question, answer });
      setActive(0);
    } catch (e) {
      setAsk({ status: "error", question, message: (e as Error).message || "Ask could not answer just now" });
    }
  };

  // Load a result's record for its actions: one read, and what it says (`access.can`, its state) is the whole
  // basis for what is offered - the palette never guesses a verb is allowed.
  const openActions = async (item: Item) => {
    const rec = item.record;
    if (!rec || !hasPaletteActions(rec.collection)) return;
    setActions({ item, name: rec.name, collection: rec.collection, status: "loading", verbs: [] });
    setActive(0);
    try {
      const row = await readRecord(rec.name);
      const verbs = paletteVerbs(rec.collection, row, { selfEmployeeId: me.employee_id, allowSelfApproval });
      setActions((a) => (a && a.name === rec.name ? { ...a, status: "ready", verbs, etag: row.etag } : a));
    } catch (e) {
      setActions((a) => (a && a.name === rec.name ? { ...a, status: "error", message: (e as Error).message } : a));
    }
  };

  // A decision from the palette - from a record's actions (Tab), from the buttons on its row, or from the
  // preview: asked first, exactly as the page asks (lib/confirmDecision.ts - a reject asks for its reason), then
  // sent against the version that was read, so a request decided meanwhile by somebody else is refused, not
  // repeated. The record and the results are read again afterwards, so what is shown is what the decision left.
  const decideOn = async (target: { name: string; label: string; etag?: string }, verb: PaletteVerb) => {
    const body = await askDecision({ confirm, askReason }, verb, target.label);
    if (body === null) return;
    try {
      await invoke(target.name, verb, target.etag, body);
      toast({ title: verb === "approve" ? "Approved" : "Rejected", description: target.label, variant: "success" });
      setActions(null);
      records.current.delete(target.name);
      setPeek(null);
      cache.current.clear();
      setRefreshTick((t) => t + 1);
    } catch (e) {
      toast({ title: `Couldn't ${verb} that`, description: (e as Error).message, variant: "destructive" });
    }
  };
  const decide = (verb: PaletteVerb) =>
    actions && actions.status === "ready" ? decideOn({ name: actions.name, label: actions.item.label, etag: actions.etag }, verb) : undefined;

  const go = (item: Item | undefined) => {
    if (!item) return;
    if (item.stay) {
      item.run?.();
      return;
    }
    bumpFrecency(me.email, item.key);
    if (item.record) kindAffinity.bump(item.record.collection);
    // A search that led somewhere is worth offering again next time the box is empty.
    if (query.trim()) saveRecentQuery(query);
    // Counted, not logged: how it was found and where it sat, never what it was (services/searchInsights.ts).
    // Fire and forget - a counter is never worth delaying the navigation it describes.
    if (item.source) {
      api("/search:feedback", { method: "POST", body: JSON.stringify({ source: item.source, position: Math.max(0, flat.indexOf(item)) }) }).catch(() => {});
    }
    if (item.run) item.run();
    else if (item.route) navigate(item.route);
    close("done");
  };

  // ⌘/Ctrl-click or a middle click on a row with somewhere to go: open it in a new tab, the way a link would,
  // and leave the search as it is - the usual reason is to open several results from one search. Counted and
  // remembered like any other open. Rows that RUN something (a create flow, a filter) have no address, so they
  // are taken here as a plain click.
  const goNewTab = (item: Item) => {
    if (item.run || !item.route) return go(item);
    bumpFrecency(me.email, item.key);
    if (item.record) kindAffinity.bump(item.record.collection);
    if (query.trim()) saveRecentQuery(query);
    window.open(`/${item.route.replace(/^\//, "")}`, "_blank", "noopener");
  };

  // The suggestions for the filter word under the caret, which take over the chip row (PaletteChips) while it
  // is being typed: `in:` offers the kinds of record, `status:` the statuses, `@` the people, and so on.
  // `pick` is the one Tab or Enter would take. The highlight is in ONE place at a time - on a suggestion while
  // choosing, on a row once ↓ has gone down into the list (`onList`) - so what Enter does is always what is lit.
  // A new keystroke puts it back on the first suggestion.
  // The guide (`?`, a bare `-`) is not values but the filter words themselves, each with what it does and an
  // example - reading, not picking - so it stays in the list as rows (`guide`, in the sections) and only real
  // values become chips.
  // The kinds after `in:` come ranked by `rankKindOffers` (`kindSignals`), each with its count; a kind the words
  // found nothing of stays offered (it is still a narrowing) but last and muted. Taking one counts towards this
  // person's use of that kind, as opening a result of it does; leaving one out (`-in:`) does not.
  const completion = useMemo(() => {
    if (!filterOffers?.items.length || filterOffers.items[0]!.kind === "key") return null;
    if (filterOffers.items[0]!.kind !== "in") return filterOffers.items.map((s) => filterItem(s, acceptFilter));
    const kinds = filterOffers.items.flatMap((s) => (s.kind === "in" ? [s] : []));
    return rankKindOffers(kinds, kindSignals).map(({ offer, count, muted }) => ({
      ...filterItem(offer, (token) => {
        if (!offer.negate) kindAffinity.bump(offer.collection);
        acceptFilter(token);
      }),
      count,
      muted,
    }));
  }, [filterOffers, kindSignals]); // eslint-disable-line react-hooks/exhaustive-deps
  const [pick, setPick] = useState(0);
  const [onList, setOnList] = useState(false);
  useEffect(() => {
    setPick(0);
    setOnList(false);
  }, [query]);
  const choosing = !!completion && !actions && !onList;
  const listActive = choosing ? -1 : active;

  // What Tab would do - finish a filter word (a suggestion chip, or a row of the guide), or open the highlighted
  // record's actions. The key handler and the hints read the same answers.
  const canComplete = choosing || !!flat[listActive]?.completes;
  const collection = flat[listActive]?.record?.collection;
  const canOpenActions = !actions && !!collection && hasPaletteActions(collection);

  // The lit row's record, read a moment after the highlight settles on it - not per row walked past - and only
  // when something will show it: decision buttons (a record that can be decided) or the preview pane (when the
  // shell has room for one). Read once per record per opening (`records`).
  const lit = flat[listActive];
  const litRecord = !actions ? lit?.record : undefined;
  useEffect(() => {
    if (!open || !litRecord) return;
    if (!previewable && !hasPaletteActions(litRecord.collection)) return;
    const known = records.current.get(litRecord.name);
    if (known) {
      setPeek({ name: litRecord.name, row: known });
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      readRecord(litRecord.name).then((row) => live && setPeek({ name: litRecord.name, row })).catch(() => {});
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open, litRecord?.name, previewable]); // eslint-disable-line react-hooks/exhaustive-deps
  const litPeek = litRecord && peek?.name === litRecord.name ? peek : null;
  const litVerbs = litPeek && litRecord ? paletteVerbs(litRecord.collection, litPeek.row, { selfEmployeeId: me.employee_id, allowSelfApproval }) : [];
  const preview = useMemo(
    () =>
      litPeek
        ? previewOf(litPeek.row, (ref) => {
            const who = directory.find((d) => d.id === idOf(ref));
            return who ? `${who.first} ${who.last}`.trim() : null;
          })
        : null,
    [litPeek, directory],
  );

  const onInputKey = (e: React.KeyboardEvent) => {
    if (choosing && completion && ((e.key === "Tab" && !e.shiftKey) || (e.key === "Enter" && !e.metaKey && !e.ctrlKey))) {
      e.preventDefault();
      completion[Math.min(pick, completion.length - 1)]!.run?.();
    } else if (choosing && completion && e.key === "ArrowRight" && caretAtEnd(e)) {
      // → at the end of the text has nothing else to do, so it walks the suggestions; ← walks back, and moves
      // the caret again once it is back on the first, so editing the word is never taken away.
      e.preventDefault();
      setPick((i) => (i + 1) % completion.length);
    } else if (choosing && e.key === "ArrowLeft" && pick > 0 && caretAtEnd(e)) {
      e.preventDefault();
      setPick((i) => i - 1);
    } else if (canComplete && e.key === "Tab" && !e.shiftKey) {
      // A row of the guide: Tab puts its word in the box, as Enter does.
      e.preventDefault();
      go(flat[active]);
    } else if (e.key === "ArrowUp" && !query && active === 0 && recentQueries[0]) {
      // ↑ in the empty box, with nowhere higher to go: the last search back, as in a shell.
      e.preventDefault();
      replaceQuery(recentQueries[0]);
    } else if (choosing && e.key === "ArrowDown") {
      // Down into the list, onto its first row.
      e.preventDefault();
      setOnList(true);
      setActive(0);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, flat.length - 1));
    } else if (e.key === "ArrowUp" && completion && onList && active === 0) {
      // Up off the list's first row, back to the suggestions.
      e.preventDefault();
      setOnList(false);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (canOpenActions && (e.key === "Tab" || (e.key === "ArrowRight" && caretAtEnd(e)))) {
      // Tab (or → at the end of the text) opens the highlighted record's actions.
      e.preventDefault();
      void openActions(flat[active]!);
    } else if (actions && (e.key === "Escape" || (e.key === "ArrowLeft" && caretAtEnd(e)))) {
      // Back to the results rather than closing the palette.
      e.preventDefault();
      setActions(null);
      setActive(0);
    } else if (facet && e.key === "Escape") {
      // The filter bar's picker goes first; the next Esc closes the search.
      e.preventDefault();
      setFacet(null);
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && askOn) {
      // ⌘↵ asks whatever is typed, wherever the highlight is.
      e.preventDefault();
      void runAsk();
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(flat[active]);
    } else if (e.key === "Escape") {
      // Closed here rather than left to the dismissable layer. The layer's Escape handler lives on the
      // content node, and this content re-renders every time a search result lands - so a press that arrives
      // in that window was sometimes swallowed, leaving the palette open over a page the person had already
      // moved on from. Closing on the input, which is where the focus always is, has no such window.
      e.preventDefault();
      close("dismiss");
    }
  };

  // Keep the highlighted row in view during keyboard navigation.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // The typed words, for marking where each row matched them (not while a record's actions are showing).
  const marks = actions ? [] : highlightTokens(parsed.text);

  // The box's wiring, the same in both shells: each adds only its own size and styling.
  const inputProps = {
    ref: inputRef,
    value: query,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      setQuery(e.target.value);
      setCaret(e.target.selectionStart ?? e.target.value.length);
      setActive(0);
    },
    // The caret moving without the text changing (← →, a click) moves which word is being completed.
    onSelect: (e: React.SyntheticEvent<HTMLInputElement>) => setCaret(e.currentTarget.selectionStart ?? 0),
    onKeyDown: onInputKey,
    // Its name in both shells, and what the dialog is titled: one name for one search, wherever it is drawn.
    "aria-label": "Search everything",
    // The combobox pattern: focus never leaves the box, and the highlighted row is announced through
    // `aria-activedescendant`, so a screen reader follows the arrow keys the way the eye does.
    role: "combobox",
    "aria-expanded": open && (flat.length > 0 || !!completion),
    // The results, and the suggestions while a filter word is being typed - two listboxes, one highlight.
    "aria-controls": completion ? `${listId} ${listId}-suggest` : listId,
    "aria-autocomplete": "list" as const,
    "aria-activedescendant": !open ? undefined
      : choosing ? `${listId}-suggest-${pick}`
      : flat[active] ? `${listId}-opt-${active}` : undefined,
    // Names, codes and page titles - not prose. Left to itself a phone capitalises the first letter and
    // autocorrects the rest, which is how "Anaya" becomes "Anya" and the search finds nothing.
    autoCapitalize: "none",
    autoCorrect: "off",
    spellCheck: false,
    enterKeyHint: "go" as const,
  };

  // The filter guide, from the filter bar's `?`.
  const showGuide = () => {
    const raw = query.trim();
    replaceQuery(raw ? `${raw} ${GUIDE_WORD}` : GUIDE_WORD);
  };

  return {
    inputProps, query, searching, settled, sections, flat, active, setActive, go, goNewTab, listId, listRef, marks, canComplete, canOpenActions, askOn, showGuide,
    // ↑ in the empty box brings back the last search (onInputKey); the hint bar says so while it would.
    canRecall: !query && recentQueries.length > 0,
    // The lit row's record: its decisions (buttons on the row and in the preview), and its preview - null
    // until it has been read. The shell says whether it has room for the preview pane.
    lit, litVerbs, preview, previewable, setPreviewable,
    // Saved searches: the chips, running one, and saving what is on screen now under a name.
    saved: savedSearches.saved,
    applySaved,
    canSave: query.trim() !== "" || scope !== "all",
    suggestedName,
    // Saved unpinned: it goes into the Saved menu, which the toast points to, rather than into the chip row.
    saveCurrent: async (name: string) => {
      await savedSearches.save({ name, query: query.trim(), scope, refine: EMPTY_REFINE });
      toast({ title: `Saved "${name}"`, description: "It's in the Saved menu - pin it there to keep it in the chip row." });
    },
    renameSaved: savedSearches.rename,
    pinSaved: savedSearches.pin,
    // Asked first, as every delete in the app is.
    removeSaved: async (s: SavedSearch) => {
      const ok = await confirm({ title: `Remove "${s.name}"?`, description: "The saved search goes from every device you use.", confirmLabel: "Remove", destructive: true });
      if (ok) await savedSearches.remove(s.id);
      inputRef.current?.focus();
    },
    decideLit: (verb: PaletteVerb) =>
      lit?.record && litPeek ? decideOn({ name: lit.record.name, label: lit.label, etag: litPeek.row.etag }, verb) : undefined,
    clear: () => replaceQuery(""),
    // The filter suggestions, and which one would be taken; and the row lit in the list (-1 while choosing).
    completion, pick, choosing, listActive,
    completionLabel: filterOffers?.items[0] ? COMPLETING[filterOffers.items[0].kind] : "",
    // A pointer moves the one highlight too: over a row it goes to the list, over a suggestion back to them.
    hoverRow: (i: number) => {
      setOnList(true);
      setActive(i);
    },
    hoverSuggestion: (i: number) => {
      setOnList(false);
      setPick(i);
    },
    chips, scope: typedKinds ? ("all" as Scope) : scope, setScope, focusBox: () => inputRef.current?.focus(),
    // The filter words in the box as pills; taking one out removes the word, and the space after it.
    typedFilters,
    // The same words styled in the box itself (QueryHighlight), while there are any; null otherwise.
    runs: runs.some((r) => r.filter) ? runs : null,
    removeTyped: (w: { start: number; end: number }) => {
      const raw = inputRef.current?.value ?? query;
      replaceQuery(`${raw.slice(0, w.start)}${raw.slice(w.end)}`.replace(/\s+/g, " ").trimStart());
    },
    removeAllTyped: () => replaceQuery(withoutTyped()),
    // The filter bar: whether its keys show, the keys, the open picker and its choices, the filters the typed
    // words name, and what each press does. `escSteps`: Esc has something to go back from (the picker, or a
    // record's actions) before it closes the search, which the modal's own Esc handling must leave alone.
    barOn, facetKeys, facet, facetChoices, facetLoading, wordFilters, newestOn,
    openFacet, pickFacet, takeWordFilter, handOff, toggleNewest,
    closeFacet: () => setFacet(null),
    setLeaveOut: (leaveOut: boolean) => setFacet((f) => (f ? { ...f, leaveOut } : f)),
    escSteps: !!facet || !!actions,
  };
}

type PaletteSearch = ReturnType<typeof usePaletteSearch>;

// The results: a spoken count once they settle, then the listbox of sections. Shared by both shells.
function PaletteResults({ p, className }: { p: PaletteSearch; className?: string }) {
  let idx = -1; // running index across sections, so keyboard selection and rendering agree
  return (
    <>
      {/* Said once the results settle, not on every keystroke: how many there are, or that there are none. */}
      <p className="sr-only" aria-live="polite">
        {!p.settled || p.query.trim().length < 2 ? "" : p.flat.length ? `${p.flat.length} result${p.flat.length === 1 ? "" : "s"}` : "No matches"}
      </p>
      <div ref={p.listRef} id={p.listId} role="listbox" aria-label="Search results" className={cn("min-h-0 overflow-y-auto overscroll-contain p-2", className)}>
        {p.flat.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">
            {isGuideQuery(p.query)
              ? `No filter matches "${p.query.trimStart().slice(1).trim()}".`
              : p.query.trim().length < 2
                ? "Keep typing to search your data…"
                : !p.settled
                  ? "Searching…"
                  : `No matches for "${p.query}".`}
          </p>
        ) : (
          p.sections.map((section, si) => (
            <div key={section.label} role="group" aria-labelledby={`${p.listId}-sec-${si}`} className="mb-1 last:mb-0">
              <p id={`${p.listId}-sec-${si}`} className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{section.label}</p>
              {section.items.map((item) => {
                const Icon = item.icon;
                const i = ++idx;
                // The lit row's decisions, once its record is read (usePaletteSearch `litVerbs`).
                const verbs = i === p.listActive && item === p.lit ? p.litVerbs : [];
                return (
                  // `presentation`, so the listbox still holds only options: the decision buttons beside one
                  // are laid over its right edge rather than nested in it (a button inside a button is not a
                  // button). They are for a pointer, and hidden from a screen reader - for which Tab on the
                  // row opens the same decisions as options it can reach (`openActions`).
                  <div key={item.key} role="presentation" className="relative">
                    {/* A button, so a pointer and a touch still press it, with the ROLE of an option in the
                        listbox (a role HTML allows on a button). Out of the Tab order: the box keeps focus. */}
                    <button
                      id={`${p.listId}-opt-${i}`}
                      role="option"
                      aria-selected={i === p.listActive}
                      tabIndex={-1}
                      data-idx={i}
                      type="button"
                      onMouseMove={() => p.hoverRow(i)}
                      onClick={(e) => (e.metaKey || e.ctrlKey ? p.goNewTab(item) : p.go(item))}
                      // A middle click opens a new tab, as on a link; preventing the mousedown stops the browser's
                      // autoscroll cursor from taking it first.
                      onMouseDown={(e) => e.button === 1 && e.preventDefault()}
                      onAuxClick={(e) => e.button === 1 && p.goNewTab(item)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                        i === p.listActive ? "bg-accent text-accent-foreground" : "text-foreground",
                      )}
                    >
                      <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-md", TONE_CLS[item.tone])}>
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium"><Marked text={item.label} tokens={p.marks} /></span>
                        {item.detail && <span className="block truncate text-xs text-muted-foreground"><Marked text={item.detail} tokens={p.marks} /></span>}
                      </span>
                      {/* The type badge gives way to the decisions while they are shown; the space stays. */}
                      <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium", TONE_CLS[item.tone], verbs.length > 0 && "invisible")}>{item.badge}</span>
                    </button>
                    {verbs.length > 0 && <DecisionButtons verbs={verbs} decide={p.decideLit} className="absolute right-2 top-1/2 -translate-y-1/2" />}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </>
  );
}

// Approve / Reject for the lit result - on its row and in the preview. Hidden from a screen reader (Tab on the
// row opens the same decisions as options it can reach), out of the Tab order, and never taking focus from the
// box, which is where typing and the arrow keys go on.
// `size`: compact on a row, full-size in the preview pane's footer.
function DecisionButtons({ verbs, decide, className, size = "sm" }: {
  verbs: PaletteVerbOption[];
  decide: (verb: PaletteVerb) => unknown;
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <span aria-hidden className={cn("flex", size === "md" ? "gap-2" : "gap-1", className)}>
      {verbs.map((v) => (
        <button
          key={v.verb}
          type="button"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void decide(v.verb)}
          className={cn(
            "rounded-md border font-medium transition-colors",
            size === "md" ? "h-8 px-3 text-sm" : "px-2 py-0.5 text-xs",
            v.verb === "approve" ? "border-success/40 bg-success/10 text-success hover:bg-success/20" : "bg-card text-foreground hover:bg-accent",
          )}
        >
          {v.label}
        </button>
      ))}
    </span>
  );
}

// The preview of the lit result, beside the list on a drop-down wide enough for it (InlineSearch measures it):
// what the record IS - its status, its person, its dates, its text - and its decisions and Open, so choosing
// between three rows called "Laptop request" does not mean opening all three. Laid out to be READ rather than
// scanned: a heading, the facts in a two-column list with room between them, the text at body size under its
// own label, and the actions in a footer that stays put while the body scrolls. The pane holds its width with
// nothing lit, so the list beside it does not jump; a record still being read shows its heading over a few
// placeholder lines.
function PalettePreview({ p }: { p: PaletteSearch }) {
  const item = p.lit;
  if (!item) {
    return (
      <aside aria-label="Preview" className="flex w-96 shrink-0 flex-col items-center justify-center gap-2 border-l bg-muted/20 p-8 text-center">
        <Search className="h-6 w-6 text-muted-foreground/60" />
        <p className="text-sm text-muted-foreground">Highlight a result to see it here.</p>
      </aside>
    );
  }
  const canOpen = !item.stay;
  return (
    <aside aria-label="Preview" className="flex w-96 shrink-0 flex-col border-l bg-muted/20">
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
        <div className="flex items-start gap-3">
          <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg", TONE_CLS[item.tone])}>
            <item.icon className="h-5 w-5" />
          </span>
          <div className="min-w-0 space-y-1.5">
            <p className="break-words text-base font-semibold leading-snug">{item.label}</p>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", TONE_CLS[item.tone])}>{item.badge}</span>
              {p.preview?.status && <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium">{p.preview.status}</span>}
            </div>
          </div>
        </div>
        {item.detail && <p className="text-sm text-muted-foreground">{item.detail}</p>}
        {item.record && !p.preview && (
          <div aria-hidden className="space-y-3">
            <div className="h-3.5 w-2/3 animate-pulse rounded bg-muted" />
            <div className="h-3.5 w-1/2 animate-pulse rounded bg-muted" />
            <div className="h-3.5 w-5/6 animate-pulse rounded bg-muted" />
          </div>
        )}
        {p.preview && p.preview.facts.length > 0 && (
          <dl className="grid grid-cols-[6.5rem_1fr] gap-x-4 gap-y-2.5 text-sm">
            {p.preview.facts.map((f) => (
              <div key={f.label} className="contents">
                <dt className="text-muted-foreground">{f.label}</dt>
                <dd className="min-w-0 break-words font-medium">{f.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {p.preview?.text && (
          <section className="space-y-1.5">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Details</h3>
            <p className="whitespace-pre-line text-sm leading-relaxed">{p.preview.text}</p>
          </section>
        )}
      </div>
      {(p.litVerbs.length > 0 || canOpen) && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t bg-popover px-5 py-3">
          {p.litVerbs.length > 0 && <DecisionButtons verbs={p.litVerbs} decide={p.decideLit} size="md" />}
          {canOpen && (
            <button
              type="button"
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => p.go(item)}
              className="ml-auto h-8 rounded-md border bg-card px-3 text-sm font-medium hover:bg-accent"
            >
              Open
            </button>
          )}
        </div>
      )}
    </aside>
  );
}

// A stretch of the box's text for QueryHighlight: plain words, or one filter word split into its key (`in:`,
// `@`, `-@`) and its value, with why it names nothing when it does not.
type HighlightRun = { text: string; filter?: { key: string; value: string; problem: string | null } };

/**
 * The box's text drawn again behind the input, with every filter word styled in place: a soft pill, its key
 * muted and its value in the primary colour, and a wavy destructive underline on a word that names nothing
 * (the pill under the chip row says why). The input's own text is transparent while this is drawn - its caret
 * and selection stay - so what is read is this layer, and what is edited is the input.
 *
 * Nothing here may move a glyph, or the caret would sit beside the letters instead of on them: same font, size
 * and letter spacing (inherited from the shell's wrapper), no padding, no weight change - the pill's shape is a
 * box-shadow spread and a radius - and inline text rather than flex items, so it flows exactly as the input's
 * does. It follows the input's horizontal scroll, so a query longer than the box stays aligned. `lineClass`
 * matches the input's height, which is what centres its text. Drawn only while there is a filter word to
 * style: plain typing is the input's own.
 */
function QueryHighlight({ runs, input, lineClass }: { runs: HighlightRun[]; input: React.RefObject<HTMLInputElement | null>; lineClass: string }) {
  const layer = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = input.current;
    const drawn = layer.current;
    if (!el || !drawn) return;
    const sync = () => {
      drawn.style.transform = `translateX(${-el.scrollLeft}px)`;
    };
    sync();
    // The input scrolls as the caret moves past its edge, which fires `scroll`; the key and selection events
    // cover the browsers that move it without one.
    const events = ["scroll", "input", "keydown", "keyup", "select", "click"] as const;
    for (const ev of events) el.addEventListener(ev, sync);
    document.addEventListener("selectionchange", sync);
    return () => {
      for (const ev of events) el.removeEventListener(ev, sync);
      document.removeEventListener("selectionchange", sync);
    };
  });
  return (
    // data-query-highlight: search.spec.ts measures that the layer's text lines up with the input's.
    <div aria-hidden data-query-highlight className="pointer-events-none absolute inset-0 overflow-hidden">
      <div ref={layer} className={cn("whitespace-pre", lineClass)}>
        {runs.map((r, i) =>
          r.filter ? (
            <span
              key={i}
              className={cn("rounded-sm", r.filter.problem ? "bg-destructive/10 underline decoration-destructive decoration-wavy underline-offset-4" : "bg-primary/10")}
              style={{ boxShadow: `0 0 0 1px hsl(var(--${r.filter.problem ? "destructive" : "primary"}) / 0.1)` }}
            >
              <span className="text-muted-foreground">{r.filter.key}</span>
              <span className={r.filter.problem ? "text-destructive" : "text-primary"}>{r.filter.value}</span>
            </span>
          ) : (
            <span key={i} className="text-foreground">{r.text}</span>
          ),
        )}
      </div>
    </div>
  );
}

// Every saved search, in a menu at the end of the chip row: a row each, its name to run it, a pin to keep it in
// the chip row (or take it out), and a submenu with Rename and Remove. Three menu items side by side rather than
// buttons inside one, so the arrow keys reach all of them in order and a screen reader names each.
function SavedMenu({ p, onRename }: { p: PaletteSearch; onRename: (s: SavedSearch) => void }) {
  // Renaming hands the focus to the name field, so the close that follows must not take it back to the box.
  const renaming = useRef(false);
  if (p.saved.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn(filterChipClass(false), "inline-flex shrink-0 items-center gap-1")}>
          <Bookmark className="h-3 w-3" />
          Saved{" "}<span className="tabular-nums opacity-70">{p.saved.length}</span>
          <ChevronDown className="h-3 w-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-72"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          if (renaming.current) renaming.current = false;
          else p.focusBox();
        }}
      >
        <DropdownMenuLabel className="text-xs text-muted-foreground">Saved searches</DropdownMenuLabel>
        {p.saved.map((s) => (
          <div key={s.id} className="flex items-center gap-0.5">
            <DropdownMenuItem className="min-w-0 flex-1" onSelect={() => p.applySaved(s)}>
              <span className="truncate">{s.name}</span>
            </DropdownMenuItem>
            {/* Stays open on a press: pinning a few in a row is one visit to the menu, not several. */}
            <DropdownMenuItem
              aria-label={s.pinned ? `Unpin ${s.name}` : `Pin ${s.name}`}
              title={s.pinned ? "Unpin from the chip row" : "Pin to the chip row"}
              onSelect={(e) => {
                e.preventDefault();
                void p.pinSaved(s.id, !s.pinned);
              }}
              className={cn("shrink-0 px-2", s.pinned ? "text-primary" : "text-muted-foreground")}
            >
              {s.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger aria-label={`Options for ${s.name}`} className="shrink-0 px-1.5" />
              <DropdownMenuSubContent>
                <DropdownMenuItem
                  onSelect={() => {
                    renaming.current = true;
                    onRename(s);
                  }}
                >
                  Rename…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void p.removeSaved(s)} className="text-destructive">
                  Remove
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// A PINNED saved search at the front of the chip row: the chip runs it; its chevron opens Unpin, Rename and
// Remove. Two buttons side by side in one pill, never one inside the other.
function SavedChip({ s, p, onRename }: { s: SavedSearch; p: PaletteSearch; onRename: () => void }) {
  const renaming = useRef(false);
  return (
    <span className={cn(filterChipClass(false), "inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap p-0")}>
      <button type="button" onClick={() => p.applySaved(s)} className="inline-flex items-center gap-1 rounded-l-full py-1 pl-3 pr-1">
        <Pin className="h-3 w-3" />
        {s.name}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label={`Options for ${s.name}`} className="rounded-r-full py-1 pl-0.5 pr-2">
            <ChevronDown className="h-3 w-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            if (renaming.current) renaming.current = false;
            else p.focusBox();
          }}
        >
          <DropdownMenuItem onSelect={() => void p.pinSaved(s.id, false)}>
            <PinOff className="h-4 w-4" />
            Unpin
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              renaming.current = true;
              onRename();
            }}
          >
            Rename…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void p.removeSaved(s)} className="text-destructive">
            Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

// Naming a saved search - a new one, or a rename - in place of the chip row, so it never leaves the search it
// is about. Enter saves, Esc puts it away; either way the box gets the focus back. It takes the pointer's focus
// itself, which the field's drop-down otherwise keeps on the box (InlineSearch).
function NameSearch({ label, initial, onDone }: { label: string; initial: string; onDone: (name: string | null) => void }) {
  const [name, setName] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const done = (save: boolean) => onDone(save && name.trim() ? name.trim() : null);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2" onMouseDown={(e) => e.stopPropagation()}>
      <label htmlFor="name-search" className="shrink-0 text-xs font-medium text-muted-foreground">{label}</label>
      <input
        id="name-search"
        ref={input}
        value={name}
        maxLength={60}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            done(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            done(false);
          }
        }}
        className="h-7 min-w-0 flex-1 rounded-md border bg-card px-2 text-sm outline-hidden focus:border-ring"
      />
      <button type="button" onClick={() => done(true)} disabled={!name.trim()} className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50">
        Save
      </button>
      <button type="button" onClick={() => done(false)} className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground">
        Cancel
      </button>
    </div>
  );
}

// A row of chips that scrolls sideways, with its edges faded where there are more chips out of view - so a
// row that runs on past the panel says so, instead of ending in a chip cut in half. `watch` is whatever
// changes what is in the row. This stands in for `.scroll-shadow-x`, which paints a shadow in the row's
// background and leaves the chip at the edge cut in half on top of it (and hidden under a selected chip's fill).
function useScrollEdges<T extends HTMLElement>(watch: unknown) {
  const ref = useRef<T>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const left = el.scrollLeft > 1;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [watch]);
  const fade = `linear-gradient(to right, ${edges.left ? "transparent, black 1.5rem" : "black"}, ${edges.right ? "black calc(100% - 1.5rem), transparent" : "black"})`;
  return { ref, edgeFade: { maskImage: fade, WebkitMaskImage: fade } as React.CSSProperties };
}

// Across the top of the results, Azure-portal style, one line that scrolls sideways rather than wrapping, so the
// list below starts at the same height whatever is typed:
//  - the categories (All, People, Pages, Time, ...): every one this caller can search, in a fixed order, each
//    with how many results it has for the words typed and greyed when that is none;
//  - or, while a filter word is being typed, what can come after it - the kinds after `in:`, the statuses
//    after `status:`, the people after `@` - for a click, or Tab / Enter / → from the box (usePaletteSearch);
//  - the saved searches menu, and a button to save the search on screen under a name.
// Under that, while any are on, every filter word in the box as a pill that says what it means and takes it out
// of the box, with Clear all for the lot. The filters themselves are offered to press in the filter bar under the
// results (FilterBar).
function PaletteChips({ p }: { p: PaletteSearch }) {
  // Only the saved searches pinned to the row; every one is in the Saved menu.
  const pinned = p.saved.filter((s) => s.pinned);
  const row = useScrollEdges<HTMLDivElement>(p.completion ? `s:${p.completionLabel}:${p.completion.length}` : `c:${pinned.length}`);
  // Naming a search to save it (no `id`), or renaming a saved one: the name field takes the row's place.
  const [naming, setNaming] = useState<{ id?: string; name: string } | null>(null);
  const finishNaming = (name: string | null) => {
    if (name && naming) void (naming.id ? p.renameSaved(naming.id, name) : p.saveCurrent(name));
    setNaming(null);
    p.focusBox();
  };
  // The suggestion → has walked to stays in view.
  useEffect(() => {
    if (p.choosing) document.getElementById(`${p.listId}-suggest-${p.pick}`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [p.choosing, p.pick, p.listId]);
  if (!p.chips) return null;
  const on = p.typedFilters.map((w) => ({ key: `typed:${w.start}`, label: w.label, problem: w.problem, remove: () => p.removeTyped(w) }));
  return (
    <div className="shrink-0 border-b">
      <div className="flex items-center gap-2 px-3 py-2">
        {naming ? (
          <NameSearch label={naming.id ? "Rename" : "Save as"} initial={naming.name} onDone={finishNaming} />
        ) : p.completion ? (
          <>
            <span className="shrink-0 text-xs font-medium text-muted-foreground">{p.completionLabel}</span>
            <div ref={row.ref} style={row.edgeFade} className="no-scrollbar min-w-0 flex-1 overflow-x-auto">
              <div id={`${p.listId}-suggest`} role="listbox" aria-label={`${p.completionLabel} suggestions`} className="flex w-max items-center gap-1.5">
                {p.completion.map((item, i) => {
                  const lit = p.choosing && i === p.pick;
                  return (
                    // Out of the Tab order and the box keeps focus, as in the results list: the input's
                    // aria-activedescendant points here while choosing.
                    <button
                      key={item.key}
                      id={`${p.listId}-suggest-${i}`}
                      role="option"
                      aria-selected={lit}
                      tabIndex={-1}
                      type="button"
                      title={item.detail ?? undefined}
                      onMouseMove={() => p.hoverSuggestion(i)}
                      onClick={() => item.run?.()}
                      className={cn(
                        filterChipClass(false),
                        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap",
                        item.muted && !lit && "opacity-60",
                        lit && "border-primary bg-accent text-accent-foreground",
                      )}
                    >
                      {/* Text only, like every other chip: the row's label already says what kind of value these are. */}
                      {item.label}
                      {/* As FilterChip draws a count: a SPACE before it, so the name reads "Tickets 12", not "Tickets12". */}
                      {item.count !== undefined && <>{" "}<span className="tabular-nums opacity-70">{item.count}</span></>}
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        ) : (
          // Pinned saved searches first - one press each, and the reason to pin them - then the categories. The
          // rest of the saved searches are in the Saved menu at the end of the row.
          <div ref={row.ref} style={row.edgeFade} className="no-scrollbar min-w-0 flex-1 overflow-x-auto">
            <div className="flex w-max items-center gap-1.5">
              {pinned.map((s) => (
                <SavedChip key={s.id} s={s} p={p} onRename={() => setNaming({ id: s.id, name: s.name })} />
              ))}
              {pinned.length > 0 && <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border" />}
              <FilterChips value={p.scope} onChange={p.setScope} clearTo="all" options={p.chips} className="w-max flex-nowrap [&>button]:shrink-0" />
            </div>
          </div>
        )}
        {!naming && <SavedMenu p={p} onRename={(s) => setNaming({ id: s.id, name: s.name })} />}
        {/* Hidden rather than disabled while there is nothing to save yet: the empty box. */}
        {!naming && p.canSave && (
          <button
            type="button"
            aria-label="Save this search"
            title="Save this search"
            onClick={() => setNaming({ name: p.suggestedName })}
            className={cn(filterChipClass(false), "inline-flex shrink-0 items-center px-2")}
          >
            <BookmarkPlus className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {on.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
          {on.map((f) => (
            // A filter word that names nothing is said to here: the box only underlines it.
            <span
              key={f.key}
              title={f.problem ?? undefined}
              className={cn(
                "inline-flex items-center gap-1 rounded-full py-0.5 pl-2.5 pr-1 text-xs font-medium",
                f.problem ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary",
              )}
            >
              {f.problem && <span className="sr-only">Names nothing: </span>}
              {f.label}
              <button
                type="button"
                aria-label={`Remove filter: ${f.label}`}
                onClick={() => {
                  f.remove();
                  p.focusBox();
                }}
                className="flex h-4 w-4 items-center justify-center rounded-full hover:bg-primary/20"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          {on.length > 1 && (
            <button
              type="button"
              onClick={() => {
                p.removeAllTyped();
                p.focusBox();
              }}
              className="rounded-sm px-1 text-xs text-muted-foreground hover:text-foreground"
            >
              Clear all
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// The filter bar under the results: every filter as something to press, for whoever does not type filter words -
// and on a phone, where it sits just above the keyboard, for everyone. A press writes a real filter word into the
// box, so the box stays the one record of what is searched, and shows the word that would have done it:
//  - "Filter by": the filters the typed words name - `pending` is Status: Pending, `priya` is Priya Shah - each
//    taking its words' place (lib/paletteQuery.ts filtersForWords). Above the keys, so the keys never move as
//    these come and go.
//  - the keys - Kind, Who, Department, Status, When - each with how many of its filters are on, then Newest
//    first, a toggle, and `?` for the guide that spells out every filter word. A key that cannot narrow this
//    search is not shown (hide, never disable).
//  - a key's picker, in the keys' place: its choices, the ones already in the box pressed (pressing one again
//    takes it out), Keep / Leave out where the key has a `-` form, and for the long lists a last choice that
//    hands over to typing the key, whose completions narrow as letters are typed. Esc puts it away.
// The keyboard hints ride at the end of the row, on a device with a keyboard: the conventions every list shares
// (arrows, Enter, Esc) go unsaid, and the Tab hint shows only while Tab does something on the highlighted row.
// A press from a pointer leaves the focus in the box (the field's drop-down keeps it there anyway); one from the
// keyboard - a click no pointer made, `detail` 0 - keeps it in the bar, on the next thing to press.
function FilterBar({ p }: { p: PaletteSearch }) {
  const bar = useRef<HTMLDivElement>(null);
  const open = p.facet;
  const offersRow = useScrollEdges<HTMLDivElement>(`${!!open}:${p.wordFilters.length}`);
  const keysRow = useScrollEdges<HTMLDivElement>(`${!!open}:${p.facetKeys.length}:${p.newestOn}`);
  const choicesRow = useScrollEdges<HTMLDivElement>(`${open?.facet}:${open?.leaveOut}:${p.facetChoices?.length}:${p.facetLoading}`);
  // Where the keyboard's focus goes once a press has re-rendered the bar: the first of these selectors that finds
  // something, since what they point at is only drawn by that render.
  const refocus = useRef<string[] | null>(null);
  useLayoutEffect(() => {
    const wanted = refocus.current;
    if (!wanted) return;
    refocus.current = null;
    for (const selector of wanted) {
      const el = bar.current?.querySelector<HTMLElement>(selector);
      if (el) return el.focus();
    }
  });
  const keyed = (e: React.MouseEvent) => e.detail === 0;
  const keyOf = (f: Facet) => `[data-facet-key="${f}"]`;
  const hints = (
    <>
      {p.canComplete && <span className="shrink-0">⇥ complete · → next</span>}
      {p.canRecall && <span className="shrink-0">↑ last search</span>}
      {p.canOpenActions && <span className="shrink-0">⇥ actions</span>}
      {p.askOn && <span className="shrink-0">⌘↵ ask</span>}
    </>
  );
  const hasHints = p.canComplete || p.canRecall || p.canOpenActions || p.askOn;
  // Nothing to narrow here - Pages, the `?` guide, a record's actions - so the hints alone, where there are any.
  if (!p.barOn) {
    return hasHints ? <div className="hidden shrink-0 items-center gap-4 border-t px-4 py-2 text-xs text-muted-foreground sm:flex">{hints}</div> : null;
  }
  const handOff = open ? HAND_OFF[open.facet] : undefined;
  return (
    <div
      ref={bar}
      className="shrink-0 border-t"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !open) return;
        // The picker goes first, wherever in the bar the focus is; the box's own Esc would close the search.
        e.preventDefault();
        e.stopPropagation();
        refocus.current = [keyOf(open.facet)];
        p.closeFacet();
      }}
    >
      {!open && p.wordFilters.length > 0 && (
        <div className="flex items-center gap-2 px-3 pt-2">
          <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground">
            <WandSparkles aria-hidden className="h-3 w-3" />
            Filter by
          </span>
          <div ref={offersRow.ref} style={offersRow.edgeFade} className="no-scrollbar min-w-0 flex-1 overflow-x-auto">
            <div role="group" aria-label="Filter by" className="flex w-max items-center gap-1.5">
              {p.wordFilters.map((w) => (
                // Dashed: an offer, not a filter in force. Its title says which words it takes the place of.
                <button
                  key={`${w.start}:${w.suggestion.token}`}
                  type="button"
                  data-word-filter
                  title={`"${w.words}" as ${w.suggestion.token}`}
                  onClick={(e) => {
                    if (keyed(e)) refocus.current = ["[data-word-filter]", "[data-facet-key]"];
                    p.takeWordFilter(w, keyed(e));
                  }}
                  className={cn(filterChipClass(false), "inline-flex shrink-0 items-center whitespace-nowrap border-dashed")}
                >
                  {wordFilterLabel(w.suggestion)}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className="flex items-center gap-2 px-3 py-2">
        {open ? (
          <>
            <button
              type="button"
              data-facet-back
              aria-label="Back to filters"
              title="Back to filters (Esc)"
              onClick={(e) => {
                if (keyed(e)) refocus.current = [keyOf(open.facet)];
                else p.focusBox();
                p.closeFacet();
              }}
              className="-ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </button>
            <span className="shrink-0 text-xs font-medium">{FACET_LABEL[open.facet]}</span>
            {/* Leave out: the key's - form. The dates have none - before: is already the other side of after:. */}
            {open.facet !== "when" && (
              <div role="group" aria-label="Keep or leave out" className="flex shrink-0 items-center gap-1">
                {([false, true] as const).map((leaveOut) => (
                  <button
                    key={String(leaveOut)}
                    type="button"
                    aria-pressed={open.leaveOut === leaveOut}
                    onClick={(e) => {
                      if (!keyed(e)) p.focusBox();
                      p.setLeaveOut(leaveOut);
                    }}
                    className={cn(filterChipClass(open.leaveOut === leaveOut), "shrink-0 whitespace-nowrap")}
                  >
                    {leaveOut ? "Leave out" : "Keep"}
                  </button>
                ))}
              </div>
            )}
          </>
        ) : (
          <div ref={keysRow.ref} style={keysRow.edgeFade} className="no-scrollbar min-w-0 flex-1 overflow-x-auto">
            <div role="group" aria-label="Narrow the results" className="flex w-max items-center gap-1.5">
              {p.facetKeys.map((k) => (
                <button
                  key={k.facet}
                  type="button"
                  data-facet-key={k.facet}
                  onClick={(e) => {
                    if (keyed(e)) refocus.current = ["[data-facet-choice]", "[data-facet-back]"];
                    p.openFacet(k.facet, keyed(e));
                  }}
                  className={cn(filterChipClass(k.count > 0), "inline-flex shrink-0 items-center gap-1 whitespace-nowrap")}
                >
                  {k.label}
                  {/* As FilterChip draws a count: a SPACE before it, so the name reads "Status 1", not "Status1". */}
                  {k.count > 0 && <>{" "}<span className="tabular-nums opacity-70">{k.count}</span></>}
                  <ChevronDown aria-hidden className="h-3 w-3" />
                </button>
              ))}
              <button
                type="button"
                aria-pressed={p.newestOn}
                onClick={(e) => p.toggleNewest(keyed(e))}
                className={cn(filterChipClass(p.newestOn), "shrink-0 whitespace-nowrap")}
              >
                Newest first
              </button>
              <button
                type="button"
                aria-label="Every filter word"
                title="Every filter word, with an example of each"
                onClick={p.showGuide}
                className={cn(filterChipClass(false), "shrink-0 px-2.5")}
              >
                ?
              </button>
            </div>
          </div>
        )}
        {hasHints && <div className="ml-auto hidden shrink-0 items-center gap-3 pl-1 text-xs text-muted-foreground sm:flex">{hints}</div>}
      </div>
      {open && (
        <div className="px-3 pb-2">
          {p.facetLoading ? (
            <ChipsSkeleton />
          ) : (
            // One row that scrolls sideways on a phone, as every chip row does there; wrapped from sm, so a long
            // list (every kind) can be read at a glance rather than scrolled through.
            <div ref={choicesRow.ref} style={choicesRow.edgeFade} className="no-scrollbar overflow-x-auto sm:max-h-36 sm:overflow-x-hidden sm:overflow-y-auto">
              <div role="group" aria-label={`${FACET_LABEL[open.facet]} choices`} className="flex w-max items-center gap-1.5 sm:w-auto sm:flex-wrap">
                {(p.facetChoices ?? []).map((c) => {
                  const on = c.offer.pressedBy.length > 0;
                  const token = c.offer.suggestion.token;
                  return (
                    // Its title is the word it writes, for whoever would rather type it next time.
                    <button
                      key={token}
                      type="button"
                      data-facet-choice={token}
                      aria-pressed={on}
                      title={token}
                      onClick={(e) => {
                        const keys = keyed(e);
                        const closed = p.pickFacet(c.offer, keys);
                        if (keys) refocus.current = closed ? [keyOf(open.facet)] : [`[data-facet-choice="${CSS.escape(token)}"]`];
                      }}
                      className={cn(filterChipClass(on), "inline-flex shrink-0 items-center gap-1 whitespace-nowrap", c.muted && !on && "opacity-60")}
                    >
                      {choiceLabel(c.offer.suggestion)}
                      {c.count !== undefined && <>{" "}<span className="tabular-nums opacity-70">{c.count}</span></>}
                    </button>
                  );
                })}
                {handOff && (
                  <button
                    type="button"
                    onClick={() => p.handOff(open.facet)}
                    className={cn(filterChipClass(false), "shrink-0 whitespace-nowrap border-dashed")}
                  >
                    {handOff.label}
                  </button>
                )}
                {!p.facetChoices?.length && !handOff && <span className="text-xs text-muted-foreground">Nothing to choose from here</span>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// How wide the field's drop-down has to be for the preview pane (w-96, 24rem) to go beside the results and leave
// the list 28rem. The open field reaches 64rem where the bar has the room (TopBar OPEN_FIELD_REM); on a 1440
// screen with the full sidebar the left edge holds it to about 53rem (852px, measured), which this admits.
const PREVIEW_ROOM_REM = 52;

// The search field in the top bar is marked with this, so ⌘K can find it and tell whether it is on screen.
const INLINE_SEARCH_ATTR = "data-inline-search";

// The modal palette: the search on a phone, on a bar too narrow for the field (TopBar shows the compact button
// there), and wherever ⌘K is pressed while the field is not on screen. Also owns ⌘K itself, being mounted once
// for the whole app: when the top bar's field is showing, ⌘K goes to the field - one search on screen, not a
// second one stacked over it - and opens this only when it is not.
export function CommandPalette({
  me,
  open,
  onOpenChange,
}: {
  me: Me;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const p = usePaletteSearch({ me, open, close: () => onOpenChange(false) });
  // How much of the screen the on-screen keyboard covers, so the panel can stop above it (phone only).
  const keyboard = useKeyboardInset();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        // `getClientRects` is empty for an element that is not rendered (`display: none` below the field's
        // container width), which is the question here: is the field on screen right now.
        const field = document.querySelector<HTMLInputElement>(`[${INLINE_SEARCH_ATTR}]`);
        if (field && field.getClientRects().length > 0) field.focus();
        else onOpenChange(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpenChange]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        {/* data-search-panel: the open results surface in either shell, for the specs (e2e/fixtures.ts searchPanel). */}
        <DialogPrimitive.Content
          data-search-panel
          aria-describedby={undefined}
          // The dialog hears Esc first (a document listener, in the capture phase); while Esc has a step to go back
          // from - the filter bar's picker, a record's actions - it is left to the box and the bar to take it.
          onEscapeKeyDown={(e) => {
            if (p.escSteps) e.preventDefault();
          }}
          style={keyboard ? ({ "--kb": `${keyboard}px` } as React.CSSProperties) : undefined}
          className={cn(
            // Phone: docked to the top edge, full width, giving up height to the on-screen keyboard - which
            // is always open here, because the palette exists to be typed into. A centred 15vh panel would
            // put its results behind the keys.
            "fixed inset-x-0 top-0 z-50 flex max-h-[calc(100dvh-var(--kb,0px))] flex-col overflow-hidden border-b bg-card shadow-2xl duration-150 standalone:pt-safe-t",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-4",
            // sm and up: the familiar centred command palette, unchanged.
            "sm:inset-x-auto sm:left-1/2 sm:top-[15vh] sm:max-h-none sm:w-[calc(100%-2rem)] sm:max-w-xl sm:-translate-x-1/2 sm:rounded-xl sm:border sm:data-[state=open]:zoom-in-95 sm:data-[state=open]:slide-in-from-top-0",
          )}
        >
          <DialogPrimitive.Title className="sr-only">Search everything</DialogPrimitive.Title>
          <div className="flex shrink-0 items-center gap-3 border-b px-4">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            {/* The text size is on the wrapper too, so the filter-word highlight behind the input matches it. */}
            <div className="relative min-w-0 flex-1 text-base sm:text-sm">
              {p.runs && <QueryHighlight runs={p.runs} input={p.inputProps.ref} lineClass="leading-[3rem]" />}
              <input
                {...p.inputProps}
                placeholder="Search people, docs, tasks and more…"
                // text-base on a phone: at 14px iOS zooms the page on focus and leaves it zoomed, so the
                // results you were about to read are off screen. (index.css enforces the same floor globally;
                // stated here too because this is the one input in the app that is always focused on open.)
                className={cn(
                  "relative h-12 w-full bg-transparent text-base outline-hidden placeholder:text-muted-foreground sm:text-sm",
                  p.runs && "text-transparent caret-foreground selection:bg-primary/25",
                )}
              />
            </div>
            {p.searching && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />}
            {/* Esc closes it on a keyboard; a phone has no Esc, so it gets a button. */}
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label="Close search"
              className="-mr-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent sm:hidden"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <PaletteChips p={p} />
          <PaletteResults p={p} className="flex-1 sm:max-h-[55vh] sm:flex-none" />
          <FilterBar p={p} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

// The search as a field in the top bar, Azure-portal style: the field IS the box, and its results drop down
// under it - no overlay, the page stays where it was. Opens on focus, a click, or typing; ⌘K focuses it while
// it is on screen (see CommandPalette). The same search as the palette (usePaletteSearch) in a different shell.
//
// Put away by Esc, by opening a result, by a press anywhere outside it, and by focus leaving it (Tab). Two
// exceptions keep it open: a press inside a dialog or a popover, because approving a request from its result
// asks first in a confirm dialog and the answer comes back to these results; and the panel itself, which
// keeps focus in the box on a press (mousedown is cancelled) so the combobox never loses its caret.
//
// The placeholder is drawn rather than set: it has a long and a short wording chosen by the width of the
// container around it (TopBar's search room), which a `placeholder` attribute cannot do.
//
// Open, the field can be wider than its place in the bar (`openWidth`, worked out by TopBar). It grows out of
// that place evenly on both sides: the field and its drop-down are laid over the place (absolute, centred on
// it) rather than in it, so the place itself - and with it everything else in the bar - never moves, and
// closing shrinks the field back onto the same centre. Where the bar has faded out around it, TopBar also moves
// it to the bar's own middle (`openShift`), and closing slides it back.
export function InlineSearch({ me, isMac, className, onOpenChange, openWidth, openShift }: {
  me: Me;
  isMac: boolean;
  className?: string;
  /** Told when the results open and close, so the bar can work out how wide the open field may be. */
  onOpenChange?: (open: boolean) => void;
  /** The field's width while open, in px; its place's width when not given. */
  openWidth?: number;
  /** How far, in px, the open field's middle sits from its place's middle; none when not given. */
  openShift?: number;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => onOpenChange?.(open), [open, onOpenChange]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const p = usePaletteSearch({
    me,
    open,
    close: (how) => {
      setOpen(false);
      if (how === "done") (document.activeElement as HTMLElement | null)?.blur();
    },
  });

  // The preview pane goes beside the results when the drop-down is wide enough to give the list its usual width
  // AND the pane its own - PREVIEW_ROOM_REM - which the open field reaches wherever the bar has the room
  // (TopBar useOpenSearchFit). Measured, not a breakpoint: the drop-down's width is the field's, not the
  // window's. The same answer gates the hook's record reads, so nothing is read for a pane that is not shown.
  const panelRef = useRef<HTMLDivElement>(null);
  const setPreviewable = p.setPreviewable;
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) {
      setPreviewable(false);
      return;
    }
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const measure = () => setPreviewable(panel.getBoundingClientRect().width >= PREVIEW_ROOM_REM * rem);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [open, setPreviewable]);

  // A press inside a dialog, an alert dialog or a popover (a confirm, a menu) is not "outside" - see above.
  const keepsOpen = (el: Element | null) => !!el?.closest('[role="dialog"],[role="alertdialog"],[data-radix-popper-content-wrapper]');
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (wrapRef.current?.contains(target) || keepsOpen(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // ⌘K while the box already has focus (after an Esc put the results away) opens them again.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      setOpen(true);
      return;
    }
    // Put away, the results are not there to act on: the keys that would act on them open them instead,
    // rather than opening a row nobody can see.
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    p.inputProps.onKeyDown(e);
  };

  return (
    // The field's place in the bar, which never changes size; the field itself is laid over it, centred.
    // data-search-place: TopBar measures the open field's room from its centre.
    <div data-search-place className={cn("relative h-9", className)}>
      <div
        ref={wrapRef}
        style={{
          width: open && openWidth ? `${openWidth}px` : "100%",
          transform: `translateX(calc(-50% + ${open && openShift ? openShift : 0}px))`,
        }}
        className={cn("absolute left-1/2 top-0 transition-[width,transform] duration-200", open && "z-40")}
        onBlur={(e) => {
          const next = e.relatedTarget as Element | null;
          if (next && !wrapRef.current?.contains(next) && !keepsOpen(next)) setOpen(false);
        }}
      >
        {/* data-search-field: wide.spec.ts measures where the field sits. A <label>, so a press anywhere on the
            field focuses the input natively; the input's own aria-label still names it. The onClick reopens the
            results when the box already has focus (Esc closes them and leaves the caret where it was). */}
        <label
          data-search-field
          onClick={() => {
            p.inputProps.ref.current?.focus();
            setOpen(true);
          }}
          className={cn(
            "flex h-9 w-full cursor-text items-center gap-2 rounded-lg border bg-card px-3 text-sm text-muted-foreground transition-colors hover:border-ring/50",
            open && "border-ring/60 ring-2 ring-ring/20",
          )}
        >
          <Search className="h-4 w-4 shrink-0" />
          <div className="relative flex min-w-0 flex-1 items-center">
            {p.runs && <QueryHighlight runs={p.runs} input={p.inputProps.ref} lineClass="leading-8" />}
            <input
              {...p.inputProps}
              {...{ [INLINE_SEARCH_ATTR]: "" }}
              onChange={(e) => {
                p.inputProps.onChange(e);
                setOpen(true);
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={onKeyDown}
              // Positioned so it sits over the highlight layer: the caret and the selection are the input's.
              className={cn(
                "relative h-8 w-full min-w-0 bg-transparent text-sm text-foreground outline-hidden",
                p.runs && "text-transparent caret-foreground selection:bg-primary/25",
              )}
            />
            {!p.query && (
              // The long wording from 22.5rem of room, "Search…" below that - the measured widths, with the
              // field's padding, icon, gaps and the wider "Ctrl K" chip around them (354px and 167px), so a new
              // wording needs re-measuring. It names what EVERY caller can find (the directory, company docs,
              // board tasks), not admin-only results such as settings.
              <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center">
                <span className="hidden truncate @min-[22.5rem]:inline">Search people, docs, tasks and more</span>
                <span className="truncate @min-[22.5rem]:hidden">Search…</span>
              </span>
            )}
          </div>
          {p.searching ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
          ) : p.query ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={(e) => {
                e.stopPropagation();
                p.clear();
              }}
              className="-mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : (
            <kbd className="shrink-0 rounded border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {isMac ? "⌘" : "Ctrl"} K
            </kbd>
          )}
        </label>
        {open && (
          <div
            ref={panelRef}
            data-search-panel
            // Keeps focus in the box when a row, a heading or the hint bar is pressed (see above).
            onMouseDown={(e) => e.preventDefault()}
            className="absolute left-1/2 top-full z-50 mt-1.5 flex max-h-[min(70vh,40rem)] w-[max(100%,32rem)] max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-pop"
          >
            <PaletteChips p={p} />
            <div className="flex min-h-0 flex-1">
              <PaletteResults p={p} className="min-w-0 flex-1" />
              {p.previewable && <PalettePreview p={p} />}
            </div>
            <FilterBar p={p} />
          </div>
        )}
      </div>
    </div>
  );
}
