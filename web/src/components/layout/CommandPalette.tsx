import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Search, ArrowLeft, User, Loader2, KeyRound, X, Sparkles, ListFilter, Lock, History, Check, Ban, CalendarDays } from "lucide-react";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";
import { confirmDecision } from "@/lib/confirmDecision";
import { useSelfApprovalAllowed } from "@/lib/approvals";
import { hasPaletteActions, paletteVerbs, type ActionableRow, type PaletteVerb, type PaletteVerbOption } from "@/lib/paletteActions";
import { readLocal, userKey, writeLocal } from "@/lib/localPref";
import { useAppLock, lockNow } from "@/lib/appLock";
import { openAppLockSettings } from "@/components/lock/AppLockSheet";
import { useKeyboardInset } from "@/hooks/useKeyboardInset";
import { useAccessMode } from "@/components/access/AccessModeProvider";
import { NAV, itemVisible, navAdmits } from "@/nav";
import { SETTINGS_REGISTRY, settingsEntryVisible } from "@/settings/registry";
import { hasCapability } from "@/lib/perm";
import { navigate } from "@/router";
import { cn, idOf } from "@/lib/utils";
import { useCollection } from "@/hooks/useCollection";
import { resolveQuickActionList, runQuickAction } from "@/lib/quickActions";
import { useOrg } from "@/lib/org";
import { api, invoke } from "@/api";
import { resourceRoute } from "@/lib/resourceRoute";
import { entityLabel, entityLabelSingular, iconOf, toneOf, TONE_CLS, type Tone } from "@/lib/entityKinds";
import type { OrgSettings } from "@/lib/org";
import type { LucideIcon } from "lucide-react";
import type { Employee, Me, SearchHit, SearchPage } from "@/types";
import { useAiFeature } from "@/lib/aiFeatures";
import { applySuggestion, highlightParts, highlightTokens, isNarrowed, looksLikeQuestion, nearPeople, parsePaletteQuery, pushRecent, searchParams, suggestFilters, tokenAt, type FilterSuggestion, type FilterVocabulary } from "@/lib/paletteQuery";
import { orgDayFromToday, todayStr } from "@/lib/orgDay";

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
};

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
// What this user actually opens from the palette, kept in localStorage per user: use-count decayed by
// recency. Ranks the empty-query view ("Recent" on top) and breaks match-score ties while typing, so the
// palette learns the handful of destinations each person lives in.
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
function frecencyScore(e?: { n: number; t: number }): number {
  if (!e) return 0;
  const days = (Date.now() - e.t) / 86_400_000;
  return e.n / (1 + days); // linear recency decay: recent + frequent floats up, stale entries fade
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

const filterLocal = (items: Item[], q: string, fre: FrecencyMap): Item[] =>
  items
    .map((c) => ({ c, s: score(c, q) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || frecencyScore(fre[b.c.key]) - frecencyScore(fre[a.c.key]))
    .map((x) => x.c);

const statusLabel = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");

// One filter suggestion as a palette row. The detail always leads with the token itself, so picking from the
// list teaches the syntax that typing it would have needed.
function filterItem(s: FilterSuggestion<{ id: string; first: string; last: string; e: Employee }>, accept: (token: string) => void): Item {
  const base = { key: `filter:${s.token}`, badge: "Filter", tone: "action" as const, icon: ListFilter, stay: true, completes: true, run: () => accept(s.token) };
  switch (s.kind) {
    case "in":
      return { ...base, label: entityLabel(s.collection), detail: s.token };
    case "status": {
      const names = s.collections.slice(0, 3).map(entityLabel).join(", ");
      const more = s.collections.length > 3 ? ` +${s.collections.length - 3}` : "";
      return { ...base, label: statusLabel(s.status), detail: `${s.token} · ${names}${more}` };
    }
    case "person":
      return { ...base, label: `${s.person.first} ${s.person.last}`, detail: [s.token, s.person.e.job_title].filter(Boolean).join(" · "), icon: User };
    case "is":
      return { ...base, label: "Mine", detail: `${s.token} · records that belong to you` };
    case "date":
      return { ...base, label: s.label, detail: s.token, icon: CalendarDays };
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

export function CommandPalette({
  me,
  open,
  onOpenChange,
}: {
  me: Me;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // Where the caret is, so the filter word it sits in can be completed. `pendingCaret` is where a completion
  // puts it once the new text has rendered.
  const inputRef = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(0);
  const pendingCaret = useRef<number | null>(null);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  // How much of the screen the on-screen keyboard covers, so the panel can stop above it (phone only).
  const keyboard = useKeyboardInset();
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
  const parsed = useMemo(() => parsePaletteQuery(query, directory), [query, directory]);
  const narrowed = isNarrowed(parsed);
  const askOn = useAiFeature("search.ask");
  const [ask, setAsk] = useState<AskState>({ status: "idle" });
  // An answer is about the question it was asked; editing the box makes it an answer to something else.
  useEffect(() => setAsk({ status: "idle" }), [query]);

  // What `in:` and `status:` can be completed with - the collections this caller may search, and their status
  // values. Asked for the first time somebody types one of those two words, not on open: most searches never
  // narrow, and the answer does not change within a session. A failure is asked again the next time.
  const [vocabulary, setVocabulary] = useState<FilterVocabulary | null>(null);
  const vocabularyAsked = useRef(false);
  useEffect(() => {
    setVocabulary(null);
    vocabularyAsked.current = false;
  }, [me.email]);
  const wantsVocabulary = /^(in|status):/i.test(tokenAt(query, caret).text);
  useEffect(() => {
    if (!wantsVocabulary || vocabulary || vocabularyAsked.current) return;
    vocabularyAsked.current = true;
    api<{ collections?: FilterVocabulary }>("/search:vocabulary")
      .then((r) => setVocabulary(r.collections ?? []))
      .catch(() => {
        vocabularyAsked.current = false;
      });
  }, [wantsVocabulary, vocabulary]);
  const filterOffers = useMemo(
    () => suggestFilters(query, caret, { people: directory, vocabulary, labelOf: entityLabel, today: todayStr(), daysAgo30: orgDayFromToday(-30) }),
    [query, caret, directory, vocabulary],
  );
  // New text for the box that the person did not type (a completion, a recent search, See all), with the caret
  // put where it belongs - the end, unless said otherwise - so the word being completed is the right one.
  const replaceQuery = (text: string, at = text.length) => {
    pendingCaret.current = at;
    setQuery(text);
    setCaret(at);
    setActive(0);
  };
  // Accepting a suggestion swaps the word under the caret for it and leaves the caret after it, ready for the
  // next word. Read off the input itself so a row built a render ago still edits what is in the box now.
  const acceptFilter = (token: string) => {
    const raw = inputRef.current?.value ?? query;
    const next = applySuggestion(raw, tokenAt(raw, inputRef.current?.selectionStart ?? caret), token);
    replaceQuery(next.query, next.caret);
  };
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (pendingCaret.current === null || !el) return;
    el.focus();
    el.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [query]);

  // Global ⌘K / Ctrl+K to open from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenChange(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpenChange]);

  // Reset query + selection whenever the palette opens.
  useEffect(() => {
    if (open) {
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
  const requestKey = parsed.text.trim().length >= 2 ? searchParams(parsed) : "";
  // WHICH request the hits on screen answer. Between a keystroke and the effect below flipping `searching`
  // there is a render where the hits are still the last query's (or none), and anything that concludes
  // "nothing was found" from that render - Did you mean, the nothing-found offers, the spoken count - flashed
  // for a result that had not arrived yet. `settled` is the honest version of "the answer is in".
  const [hitsKey, setHitsKey] = useState("");
  const settled = !searching && hitsKey === requestKey;
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
        .catch(() => {
          if (seq.current === mine) {
            setHits([]); // never cached: a failure says nothing about the data
            setHitsKey(key);
          }
        })
        .finally(() => {
          if (seq.current === mine) setSearching(false);
        });
    }, 220);
    return () => clearTimeout(timer);
  }, [requestKey, open, refreshTick]);

  // Tab on a result: the decisions this caller can make on it, loaded from the record itself (its `access.can`
  // and state), so what is offered is what the server would allow.
  const [actions, setActions] = useState<ActionsState | null>(null);
  const confirm = useConfirm();
  const { toast } = useToast();
  const allowSelfApproval = useSelfApprovalAllowed();
  useEffect(() => setActions(null), [query, open]);

  // Drop the cache when the palette closes: a write made between two openings must not be masked by a stale
  // "no results" from the previous session.
  useEffect(() => {
    if (!open) cache.current.clear();
  }, [open]);

  // Re-read frecency each time the palette opens (another tab may have bumped it since).
  const frecent = useMemo(() => (open ? loadFrecency(me.email) : {}), [open, me.email]);
  // And the last few searches that led somewhere, for the empty box.
  const recentQueries = useMemo(() => (open ? loadRecentQueries() : []), [open]);

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
    const q = query.trim().toLowerCase();
    if (!q) {
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
      return [
        { label: "Recent searches", items: searches },
        { label: "Recent", items: recent },
        { label: "Actions", items: local.actions },
        { label: "Go to", items: local.pages },
        { label: "Settings", items: local.settings },
      ].filter((s) => s.items.length > 0);
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
      const bucket = byCollection.get(h.collection);
      if (bucket) bucket.push(item);
      else byCollection.set(h.collection, [item]);
    }

    const out: Section[] = [];
    // Completions for the filter word under the caret lead: the person is mid-word, and Enter or Tab should
    // finish it before anything else.
    if (filterOffers) out.push({ label: "Filters", items: filterOffers.items.map((s) => filterItem(s, acceptFilter)) });
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
    if (pages.length) out.push({ label: "Go to", items: pages });
    if (settings.length) out.push({ label: "Settings", items: settings });
    for (const [collection, found] of byCollection) {
      const items = byFrecency(found);
      // Narrowed to this type already, the whole list is the point; otherwise the top few, and one row that
      // re-asks the same words of this type alone, which the server answers with up to SERVER_TOTAL of them.
      const capped = narrowed || items.length <= PER_SECTION ? items : items.slice(0, PER_SECTION);
      if (capped.length < items.length) {
        const plural = entityLabel(collection).toLowerCase();
        const next = `in:${collection} ${parsed.text}`.trim();
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
    if (related.length) out.push({ label: "Related", items: related });

    // Nothing matched a name, and nothing at all came back: offer the people one slip away ("Kpoor").
    if (!narrowed && settled && people.length === 0 && byCollection.size === 0 && text.length >= 4) {
      const near = nearPeople(text, directory).map((d) => personItem(d.e));
      if (near.length) out.push({ label: "Did you mean", items: near });
    }

    // And when there is still nothing at all, the thing to do next is usually to ask a person: the caller's own
    // "raise a ticket" / "submit a suggestion", started with the words they searched for. Only the actions this
    // caller already has (resolveQuickActionList), so nothing is offered that they cannot do.
    if (!narrowed && settled && text.length >= 3 && out.every((s) => s.items.length === 0)) {
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
    return out;
    // `runAsk` and `acceptFilter` read the same state this memo does, so listing them would only rebuild the
    // list twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local, employees, directory, hits, query, parsed, narrowed, frecent, recentQueries, ask, askOn, settled, prefillable, actions, filterOffers]);

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
      const row = await api<ActionableRow & { etag?: string }>(`/${rec.name}`);
      const verbs = paletteVerbs(rec.collection, row, { selfEmployeeId: me.employee_id, allowSelfApproval });
      setActions((a) => (a && a.name === rec.name ? { ...a, status: "ready", verbs, etag: row.etag } : a));
    } catch (e) {
      setActions((a) => (a && a.name === rec.name ? { ...a, status: "error", message: (e as Error).message } : a));
    }
  };

  // A decision from the palette: asked first, exactly as the page asks (lib/confirmDecision.ts), then sent
  // against the version that was read, so a request decided meanwhile by somebody else is refused, not repeated.
  const decide = async (verb: PaletteVerb) => {
    if (!actions || actions.status !== "ready") return;
    const subject = actions.item.label;
    if (!(await confirmDecision(confirm, verb, subject))) return;
    try {
      await invoke(actions.name, verb, actions.etag);
      toast({ title: verb === "approve" ? "Approved" : "Rejected", description: subject, variant: "success" });
      setActions(null);
      cache.current.clear();
      setRefreshTick((t) => t + 1);
    } catch (e) {
      toast({ title: `Couldn't ${verb} that`, description: (e as Error).message, variant: "destructive" });
    }
  };

  const go = (item: Item | undefined) => {
    if (!item) return;
    if (item.stay) {
      item.run?.();
      return;
    }
    bumpFrecency(me.email, item.key);
    // A search that led somewhere is worth offering again next time the box is empty.
    if (query.trim()) saveRecentQuery(query);
    // Counted, not logged: how it was found and where it sat, never what it was (services/searchInsights.ts).
    // Fire and forget - a counter is never worth delaying the navigation it describes.
    if (item.source) {
      api("/search:feedback", { method: "POST", body: JSON.stringify({ source: item.source, position: Math.max(0, flat.indexOf(item)) }) }).catch(() => {});
    }
    if (item.run) item.run();
    else if (item.route) navigate(item.route);
    onOpenChange(false);
  };

  // What Tab would do on the highlighted row - finish a filter word, or open a record's actions. The key
  // handler and the hints read the same answers.
  const canComplete = !!flat[active]?.completes;
  const collection = flat[active]?.record?.collection;
  const canOpenActions = !actions && !!collection && hasPaletteActions(collection);

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (canComplete && e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      go(flat[active]);
    } else if (canOpenActions && (e.key === "Tab" || (e.key === "ArrowRight" && caretAtEnd(e)))) {
      // Tab (or → at the end of the text) opens the highlighted record's actions.
      e.preventDefault();
      void openActions(flat[active]!);
    } else if (actions && (e.key === "Escape" || (e.key === "ArrowLeft" && caretAtEnd(e)))) {
      // Back to the results rather than closing the palette.
      e.preventDefault();
      setActions(null);
      setActive(0);
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
      onOpenChange(false);
    }
  };

  // Keep the highlighted row in view during keyboard navigation.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  let idx = -1; // running index across sections, so keyboard selection and rendering agree
  // The typed words, for marking where each row matched them (not while a record's actions are showing).
  const marks = actions ? [] : highlightTokens(parsed.text);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-foreground/40 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
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
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); setActive(0); }}
              // The caret moving without the text changing (← →, a click) moves which word is being completed.
              onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
              onKeyDown={onInputKey}
              placeholder="Search people, records, pages and settings…"
              // The combobox pattern: focus never leaves the box, and the highlighted row is announced through
              // `aria-activedescendant`, so a screen reader follows the arrow keys the way the eye does.
              role="combobox"
              aria-expanded={flat.length > 0}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={flat[active] ? `${listId}-opt-${active}` : undefined}
              // Names, codes and page titles - not prose. Left to itself a phone capitalises the first letter
              // and autocorrects the rest, which is how "Anaya" becomes "Anya" and the search finds nothing.
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              // text-base on a phone: at 14px iOS zooms the page on focus and leaves it zoomed, so the
              // results you were about to read are off screen. (index.css enforces the same floor globally;
              // stated here too because this is the one input in the app that is always focused on open.)
              className="h-12 w-full bg-transparent text-base outline-none placeholder:text-muted-foreground sm:text-sm"
            />
            {searching && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />}
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
          {/* Said once the results settle, not on every keystroke: how many there are, or that there are none. */}
          <p className="sr-only" aria-live="polite">
            {!settled || query.trim().length < 2 ? "" : flat.length ? `${flat.length} result${flat.length === 1 ? "" : "s"}` : "No matches"}
          </p>
          <div ref={listRef} id={listId} role="listbox" aria-label="Search results" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2 sm:max-h-[55vh] sm:flex-none">
            {flat.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                {query.trim().length < 2
                  ? "Keep typing to search your data…"
                  : !settled
                    ? "Searching…"
                    : `No matches for "${query}".`}
              </p>
            ) : (
              sections.map((section, si) => (
                <div key={section.label} role="group" aria-labelledby={`${listId}-sec-${si}`} className="mb-1 last:mb-0">
                  <p id={`${listId}-sec-${si}`} className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{section.label}</p>
                  {section.items.map((item) => {
                    const Icon = item.icon;
                    const i = ++idx;
                    return (
                      // A button, so a pointer and a touch still press it, with the ROLE of an option in the
                      // listbox (a role HTML allows on a button). Out of the Tab order: the box keeps focus.
                      <button
                        key={item.key}
                        id={`${listId}-opt-${i}`}
                        role="option"
                        aria-selected={i === active}
                        tabIndex={-1}
                        data-idx={i}
                        type="button"
                        onMouseMove={() => setActive(i)}
                        onClick={() => go(item)}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                          i === active ? "bg-accent text-accent-foreground" : "text-foreground",
                        )}
                      >
                        <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-md", TONE_CLS[item.tone])}>
                          <Icon className="h-4 w-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium"><Marked text={item.label} tokens={marks} /></span>
                          {item.detail && <span className="block truncate text-xs text-muted-foreground"><Marked text={item.detail} tokens={marks} /></span>}
                        </span>
                        <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium", TONE_CLS[item.tone])}>{item.badge}</span>
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
          {/* Hints for what this box does beyond a plain search list, for devices with a keyboard. The
              conventions every list shares (arrows, Enter, Esc) go unsaid, and the Tab hint shows only while Tab
              does something on the highlighted row. Below md the filter syntax is hidden, so with none of the
              others to say the row goes too rather than leave an empty bar. */}
          <div className={cn("hidden shrink-0 items-center gap-4 border-t px-4 py-2 text-[11px] text-muted-foreground", canComplete || canOpenActions || askOn ? "sm:flex" : "md:flex")}>
            {canComplete && <span>⇥ complete</span>}
            {canOpenActions && <span>⇥ actions</span>}
            {askOn && <span>⌘↵ ask</span>}
            <span className="hidden md:inline">in:tickets · @name · is:mine · status:pending · after:2026-01</span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
