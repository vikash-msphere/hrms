import { useEffect, useMemo, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Search, CornerDownLeft, ArrowUp, ArrowDown, User, Loader2, KeyRound } from "lucide-react";
import { useAccessMode } from "@/components/access/AccessModeProvider";
import { NAV, itemVisible, navPerm } from "@/nav";
import { SETTINGS_REGISTRY } from "@/settings/registry";
import { hasCapability } from "@/lib/perm";
import { navigate } from "@/router";
import { cn, idOf } from "@/lib/utils";
import { useCollection } from "@/hooks/useCollection";
import { resolveQuickActionList, runQuickAction } from "@/lib/quickActions";
import { useOrg } from "@/lib/org";
import { api } from "@/api";
import { resourceRoute } from "@/lib/resourceRoute";
import { entityLabel, entityLabelSingular, iconOf, toneOf, TONE_CLS, type Tone } from "@/lib/entityKinds";
import type { OrgSettings } from "@/lib/org";
import type { LucideIcon } from "lucide-react";
import type { Employee, Me, SearchHit, SearchPage } from "@/types";

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
  route?: string; // hash route to navigate to
  run?: () => void; // ...or an action to fire instead
};
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
          .filter((t) => { const p = navPerm(t); return !p || hasCapability(me.capabilities, p); })
          .map((t) => ({ key: t.key, label: `${i.label}: ${t.label}`, detail: g.label, badge: "Page", tone: "page", icon: i.icon, route: t.key }));
      }
      if (!itemVisible(i, (p) => hasCapability(me.capabilities, p))) return [];
      return [{ key: i.key, label: i.label, detail: g.label, badge: "Page", tone: "page", icon: i.icon, route: i.key }];
    }),
  );
  // Every settings panel is a jump target ("Leave types"), gated exactly like the Settings page: the page-level
  // capability plus the panel's own, so nobody is offered a door they can't open.
  const settings: Item[] = hasCapability(me.capabilities, "settings.write")
    ? SETTINGS_REGISTRY.filter((s) => !s.perm || hasCapability(me.capabilities, s.perm)).map((s) => ({
        key: `settings/${s.key}`,
        label: s.title,
        detail: s.group,
        badge: "Setting",
        tone: "setting",
        icon: s.icon,
        route: `settings/${s.key}`,
      }))
    : [];
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

const filterLocal = (items: Item[], q: string, fre: FrecencyMap): Item[] =>
  items
    .map((c) => ({ c, s: score(c, q) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || frecencyScore(fre[b.c.key]) - frecencyScore(fre[a.c.key]))
    .map((x) => x.c);

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
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const { org } = useOrg();
  const quickCfg = org.quick_actions;
  const am = useAccessMode();
  const local = useMemo(() => {
    const built = buildLocal(me, quickCfg);
    // Access mode used to be reachable only from the user menu - a mode you had to know about to find. It is
    // an action like any other, so it belongs in ⌘K for the people who may use it.
    if (am.available) {
      built.actions = [
        ...built.actions,
        { key: "action:access-mode", label: am.enabled ? "Turn off access mode" : "Turn on access mode (manage who can see what)", badge: "Action", tone: "action", icon: KeyRound, run: am.toggle },
      ];
    }
    return built;
  }, [me, quickCfg, am.available, am.enabled, am.toggle]);
  // Directory is server-scoped to who the caller may see, so people results never leak hidden employees. It is
  // already cached for the rest of the app, so matching it locally gives instant people hits while the
  // cross-collection search is still in flight; identical server hits are deduped below.
  const { rows: employees } = useCollection<Employee>("employees");

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
      setActive(0);
      setHits([]);
    }
  }, [open]);

  // Cross-collection search. The server side is an FTS index lookup, so a query is cheap and the guards here
  // are about not sending pointless requests rather than about cost:
  //   1. debounce + a 2-character floor, matching the server's minimum (pages, actions and cached people
  //      still match from the first character, with no request at all),
  //   2. a per-session result cache, so backspacing to a query already run re-renders instead of refetching,
  //   3. a dead-prefix skip: search matches token prefixes, so if "abc" found nothing, no extension of it can.
  // Responses are sequence-guarded, so a slow reply can never overwrite a newer one.
  const seq = useRef(0);
  const cache = useRef(new Map<string, SearchHit[]>());
  const empties = useRef<string[]>([]);
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }
    const cached = cache.current.get(q);
    if (cached) {
      seq.current++;
      setHits(cached);
      setSearching(false);
      return;
    }
    // Prefix matching is monotone: if no indexed token starts with "abc", none starts with "abcd" either. So
    // a query extending one already known to match nothing is answered locally, with no request.
    if (empties.current.some((dead) => q.startsWith(dead))) {
      seq.current++;
      setHits([]);
      setSearching(false);
      return;
    }
    const mine = ++seq.current;
    setSearching(true);
    const timer = setTimeout(() => {
      api<SearchPage>(`/search?q=${encodeURIComponent(q)}`)
        .then((r) => {
          const results = r.results ?? [];
          cache.current.set(q, results);
          if (results.length === 0) empties.current.push(q);
          if (seq.current === mine) setHits(results);
        })
        .catch(() => {
          if (seq.current === mine) setHits([]); // never cached: a failure says nothing about the data
        })
        .finally(() => {
          if (seq.current === mine) setSearching(false);
        });
    }, 220);
    return () => clearTimeout(timer);
  }, [query, open]);

  // Drop the caches when the palette closes: a write made between two openings must not be masked by a stale
  // "no results" from the previous session.
  useEffect(() => {
    if (!open) {
      cache.current.clear();
      empties.current = [];
    }
  }, [open]);

  // Re-read frecency each time the palette opens (another tab may have bumped it since).
  const frecent = useMemo(() => (open ? loadFrecency(me.email) : {}), [open, me.email]);

  const sections = useMemo((): Section[] => {
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
      return [
        { label: "Recent", items: recent },
        { label: "Actions", items: local.actions },
        { label: "Go to", items: local.pages },
        { label: "Settings", items: local.settings },
      ].filter((s) => s.items.length > 0);
    }

    // People from the cached directory — instant, and the route matches the server's `employees/<id>` hit
    // exactly, so the dedupe below keeps whichever arrives without ever showing the person twice.
    const people: Item[] = employees
      .filter((e) => `${e.first_name} ${e.last_name} ${e.work_email ?? ""} ${e.job_title ?? ""}`.toLowerCase().includes(q))
      .slice(0, 6)
      .map((e) => ({
        key: `employees/${idOf(e.path)}`,
        label: `${e.first_name} ${e.last_name}`,
        detail: e.job_title,
        badge: "Person",
        tone: "people",
        icon: User,
        route: `employees/${idOf(e.path)}`,
      }));

    // Records from the server, grouped by collection so a list of 40 mixed rows stays scannable.
    const seen = new Set(people.map((p) => p.route));
    const byCollection = new Map<string, Item[]>();
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
      };
      const bucket = byCollection.get(h.collection);
      if (bucket) bucket.push(item);
      else byCollection.set(h.collection, [item]);
    }

    const out: Section[] = [];
    const actions = filterLocal(local.actions, q, frecent);
    const pages = filterLocal(local.pages, q, frecent);
    const settings = filterLocal(local.settings, q, frecent);
    if (actions.length) out.push({ label: "Actions", items: actions });
    if (people.length) out.push({ label: "People", items: people });
    if (pages.length) out.push({ label: "Go to", items: pages });
    if (settings.length) out.push({ label: "Settings", items: settings });
    for (const [collection, items] of byCollection) out.push({ label: entityLabel(collection), items });
    return out;
  }, [local, employees, hits, query, frecent]);

  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  // Clamp the active row whenever the result set shrinks.
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, flat.length - 1)));
  }, [flat.length]);

  const go = (item: Item | undefined) => {
    if (!item) return;
    bumpFrecency(me.email, item.key);
    if (item.run) item.run();
    else if (item.route) navigate(item.route);
    onOpenChange(false);
  };

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(flat[active]);
    }
  };

  // Keep the highlighted row in view during keyboard navigation.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  let idx = -1; // running index across sections, so keyboard selection and rendering agree

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-foreground/40 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[15vh] z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border bg-card shadow-2xl duration-150 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <DialogPrimitive.Title className="sr-only">Search everything</DialogPrimitive.Title>
          <div className="flex items-center gap-3 border-b px-4">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => { setQuery(e.target.value); setActive(0); }}
              onKeyDown={onInputKey}
              placeholder="Search people, records, pages and settings…"
              className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            {searching && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />}
          </div>
          <div ref={listRef} className="max-h-[55vh] overflow-y-auto p-2">
            {flat.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                {searching
                  ? "Searching…"
                  : query.trim().length < 2
                    ? "Keep typing to search your data…"
                    : `No matches for "${query}".`}
              </p>
            ) : (
              sections.map((section) => (
                <div key={section.label} className="mb-1 last:mb-0">
                  <p className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{section.label}</p>
                  {section.items.map((item) => {
                    const Icon = item.icon;
                    const i = ++idx;
                    return (
                      <button
                        key={item.key}
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
                          <span className="block truncate font-medium">{item.label}</span>
                          {item.detail && <span className="block truncate text-xs text-muted-foreground">{item.detail}</span>}
                        </span>
                        <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium", TONE_CLS[item.tone])}>{item.badge}</span>
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
          <div className="flex items-center gap-4 border-t px-4 py-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <ArrowUp className="h-3 w-3" />
              <ArrowDown className="h-3 w-3" /> navigate
            </span>
            <span className="flex items-center gap-1">
              <CornerDownLeft className="h-3 w-3" /> open
            </span>
            <span className="ml-auto">esc to close</span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
