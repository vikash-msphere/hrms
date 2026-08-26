import { useEffect, useMemo, useRef, useState } from "react";
import { Search, History } from "lucide-react";
import { get } from "@/api";
import { navigate } from "@/router";
import { useCollection } from "@/hooks/useCollection";
import { idOf } from "@/lib/utils";
import { resourceRoute, opensExactRecord } from "@/lib/resourceRoute";
import type { Activity, ActivityPage, Employee } from "@/types";
import { actionIcon, actionLabel, actionTone, TONE_ICON, TONE_LABEL, timeAgo, type ActionTone } from "@/lib/activity";
import { entityLabel, iconOf } from "@/lib/entityKinds";
import { BASE_COLLECTIONS } from "@/components/access/permMatrix";
import { PhotoAvatar } from "./PhotoAvatar";
import { PersonAvatar } from "./PersonAvatar";
import { CardsSkeleton } from "@/components/common/Skeletons";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// On-demand audit trail for one resource. Mount only when opened (never eager). Rows read as a sentence with a
// color-coded action pill + the change INLINE. Filtering: a single-page log filters CLIENT-SIDE (instant, no
// reads); a paginated log filters SERVER-SIDE (so search spans all history, not just loaded pages). IP/UA in
// the timestamp tooltip. Names resolve from cached employees.
// Human field label: drop storage suffixes (columnsJson → columns, employeeId → employee), de-camel, de-snake.
// A sensitive-read row names the custom method as `:bankFile` — drop the leading colon so it reads "bank file".
const fieldLabel = (k: string) => k.replace(/^:/, "").replace(/(Id|Json)$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_(id|json)$/i, "").replace(/_/g, " ").trim().toLowerCase();
// Collection -> the user-facing word for the org-wide feed's type chip/filter, shared with global search so
// both name a collection the same way.
const TONE_CLS: Record<ActionTone, string> = {
  create: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  update: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  move: "bg-violet-500/15 text-violet-700 dark:text-violet-400",
  assign: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  remove: "bg-destructive/15 text-destructive",
  positive: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  comment: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  read: "bg-brand-neutral-500/15 text-brand-neutral-700 dark:text-brand-neutral-300",
  denied: "bg-red-500/20 text-red-700 dark:text-red-400 ring-1 ring-red-500/30",
  other: "bg-muted text-muted-foreground",
};

// `resource` = one entity's trail (`<collection>/<id>`). `global` = the org-wide feed (every collection;
// gated by the `audit` capability) — it adds an entity-type filter and shows each row's touched record.
// `initialEntity` pre-selects the object-type filter (the Activity page's "Permission changes" view opens the
// feed already narrowed to access-rules); the filter itself stays fully editable afterwards.
export function ActivityFeed({ resource, global = false, initialEntity, apiKey }: { resource?: string; global?: boolean; initialEntity?: string; /** Narrow the org-wide feed to everything ONE credential did (`api-keys/<id>`). */ apiKey?: string }) {
  const { rows: employees } = useCollection<Employee>("employees");
  const [rows, setRows] = useState<Activity[] | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [q, setQ] = useState(""); // typed text
  const [submittedQ, setSubmittedQ] = useState(""); // committed query (applied on Enter / search button)
  const [tone, setTone] = useState<string>("all");
  const [entity, setEntity] = useState<string>(initialEntity ?? "all"); // global feed: narrow to one collection
  const [actor, setActor] = useState<string>("all"); // global feed: narrow to one actor (employee path)
  const [drill, setDrill] = useState<{ resource: string; label: string | null } | null>(null); // global feed: open one record's own trail
  const [nextToken, setNextToken] = useState<string | undefined>();
  const [paginated, setPaginated] = useState(false); // true once the unfiltered log is known to have >1 page
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageSize, setPageSize] = useState(25);
  const fetchKey = useRef(""); // dedupes the server-filter effect against the initial load
  const sizeInited = useRef(false);
  const scope = resource ?? apiKey ?? "*"; // stable key for the initial-load effect (undefined for the global feed)

  const params = (extra: Record<string, string | undefined>) => {
    const u = new URLSearchParams(resource ? { resource } : apiKey ? { api_key: apiKey } : {});
    for (const [k, v] of Object.entries(extra)) if (v) u.set(k, v);
    return `activity?${u.toString()}`;
  };
  const filterQuery = () => ({ q: submittedQ.trim() || undefined, tone: tone !== "all" ? tone : undefined, entity: global && entity !== "all" ? entity : undefined, actor: global && actor !== "all" ? actor : undefined });

  // Initial (unfiltered) load. Establishes whether the log is paginated.
  useEffect(() => {
    let live = true;
    setState("loading"); setRows(null); setNextToken(undefined); setPaginated(false); setQ(""); setSubmittedQ(""); setTone("all"); setEntity(initialEntity ?? "all"); setActor("all");
    fetchKey.current = `${scope}||all|all|all|`;
    get<ActivityPage>(params({ max_page_size: String(pageSize) }))
      .then((p) => { if (!live) return; setRows(p.results); setNextToken(p.next_page_token); setPaginated(!!p.next_page_token); fetchKey.current = `${scope}||all|all|all|${!!p.next_page_token}`; setState("ready"); })
      .catch(() => { if (live) setState("error"); });
    return () => { live = false; };
  }, [scope]);

  // Server-side re-filter, but ONLY when paginated (a single page filters client-side below). Debounced.
  useEffect(() => {
    if (!paginated) return;
    const key = `${scope}|${submittedQ.trim()}|${tone}|${entity}|${actor}|${paginated}`;
    if (key === fetchKey.current) return; // matches the state already loaded (incl. right after initial) → skip
    let live = true;
    const h = setTimeout(() => {
      fetchKey.current = key;
      setState("loading");
      get<ActivityPage>(params({ max_page_size: String(pageSize), ...filterQuery() }))
        .then((p) => { if (!live) return; setRows(p.results); setNextToken(p.next_page_token); setState("ready"); })
        .catch(() => { if (live) setState("error"); });
    }, 300);
    return () => { live = false; clearTimeout(h); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submittedQ, tone, entity, actor, paginated, scope]);

  // Page-size change: reload page 1 at the new size (preserving filters); recompute pagination.
  useEffect(() => {
    if (!sizeInited.current) { sizeInited.current = true; return; }
    let live = true;
    setState("loading");
    get<ActivityPage>(params({ max_page_size: String(pageSize), ...filterQuery() }))
      .then((p) => { if (!live) return; setRows(p.results); setNextToken(p.next_page_token); setPaginated(!!p.next_page_token); fetchKey.current = `${scope}|${submittedQ.trim()}|${tone}|${entity}|${actor}|${!!p.next_page_token}`; setState("ready"); })
      .catch(() => { if (live) setState("error"); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageSize]);

  async function loadMore() {
    if (!nextToken || loadingMore) return;
    setLoadingMore(true);
    try {
      const p = await get<ActivityPage>(params({ page_token: nextToken, max_page_size: String(pageSize), ...(paginated ? filterQuery() : {}) }));
      setRows((r) => [...(r ?? []), ...p.results]);
      setNextToken(p.next_page_token);
    } catch { /* leave what we have */ }
    finally { setLoadingMore(false); }
  }

  const empName = (ref?: string) => { const e = ref ? employees.find((x) => idOf(x.path) === idOf(ref)) : undefined; return e ? `${e.first_name} ${e.last_name}` : undefined; };
  const empOf = (a: Activity) => (a.actor ? employees.find((e) => idOf(e.path) === idOf(a.actor!)) : undefined);
  // Prefer the server-resolved actor name (works even for actors not in the loaded employees page); then the
  // cached employee; finally the email (system/unlinked actors have no name).
  const nameOf = (a: Activity) => { if (a.actor_name) return a.actor_name; const e = empOf(a); return e ? `${e.first_name} ${e.last_name}` : a.actor_email; };

  const clip = (s: string) => (s.length > 48 ? s.slice(0, 48) + "…" : s);
  const fmt = (v: unknown): string => {
    if (v === null || v === undefined || v === "") return "—";
    if (typeof v === "boolean") return v ? "yes" : "no";
    if (typeof v === "string") {
      if (/^employees\//.test(v)) return empName(v) ?? "someone";
      if (/^[a-z-]+\//.test(v)) return v.split("/").pop() ?? v;
      return clip(v);
    }
    // Objects/arrays (nested settings blobs, e.g. quick_actions): summarize compactly rather than
    // rendering "[object Object]". Arrays of scalars join; anything deeper collapses to short JSON.
    if (Array.isArray(v)) {
      if (v.every((x) => typeof x !== "object" || x === null)) return clip(v.map((x) => fmt(x)).join(", ")) || "empty";
      return `${v.length} item${v.length === 1 ? "" : "s"}`;
    }
    if (typeof v === "object") return clip(JSON.stringify(v));
    return String(v);
  };
  const fromTo = (from: unknown, to: unknown, key: number, label?: string) => (
    <span key={key} className="inline-flex flex-wrap items-baseline gap-1">
      {label && <span className="capitalize text-muted-foreground">{label}</span>}
      <span className="text-muted-foreground line-through">{fmt(from)}</span>
      <span className="text-muted-foreground">→</span>
      <span className="font-medium">{fmt(to)}</span>
    </span>
  );
  const inline = (a: Activity): React.ReactNode[] => {
    const m = a.meta ?? {};
    const bits: React.ReactNode[] = [];
    if (m.diff && Object.keys(m.diff).length) Object.entries(m.diff).forEach(([k, v], i) => bits.push(fromTo(v.from, v.to, i, `${fieldLabel(k)}:`)));
    else if ("from" in m || "to" in m) bits.push(fromTo((m as Record<string, unknown>).from, (m as Record<string, unknown>).to, 0));
    if (typeof m.reason === "string" && m.reason) bits.push(<span key="r" className="text-muted-foreground">— {m.reason}</span>);
    // Progress-update notes (goal.updateProgress meta): same dash treatment as reasons.
    if (typeof m.note === "string" && m.note) bits.push(<span key="n" className="text-muted-foreground">— {m.note}</span>);
    if (typeof m.blockedBy === "string") bits.push(<span key="b" className="text-muted-foreground">by {fmt(m.blockedBy)}</span>);
    if (Array.isArray(m.changed) && m.changed.length) bits.push(<span key="c" className="text-muted-foreground">{m.changed.map((k) => fieldLabel(String(k))).join(", ")}</span>);
    // Write-backstop rows (services with no inline diff): the touched field NAMES, so a bare update/create still
    // reads as "updated · title, status". Suppressed when a real diff/changed is present (avoid duplication).
    if (Array.isArray(m.fields) && m.fields.length && !m.diff && !Array.isArray(m.changed)) bits.push(<span key="fl" className="text-muted-foreground">{(m.fields as string[]).map((k) => fieldLabel(String(k))).join(", ")}</span>);
    // Subject + day, for rows about someone else's record on a given date (e.g. an attendance regularization:
    // "for Asha Rao on 2026-07-14"). `employee` is a ref → resolved to a name; `date` is a plain YYYY-MM-DD.
    // Name the subject employee, unless they ARE the actor (a self-filed row) - "Asha requested for Asha" is noise.
    if (typeof m.employee === "string" && m.employee && !(a.actor && idOf(m.employee) === idOf(a.actor))) bits.push(<span key="emp" className="text-muted-foreground">for {fmt(m.employee)}</span>);
    if (typeof m.date === "string" && m.date) bits.push(<span key="dt" className="text-muted-foreground">on {m.date}</span>);
    // A set of in/out session pairs (e.g. an attendance correction's requested times) → "09:00–13:00, 14:00–18:10".
    if (Array.isArray(m.sessions)) {
      const hm = (iso: unknown) => (typeof iso === "string" ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "?");
      const pairs = m.sessions as { clock_in?: string; clock_out?: string }[];
      const label = pairs.length ? pairs.map((p) => `${hm(p.clock_in)}–${hm(p.clock_out)}`).join(", ") : "no punches";
      bits.push(<span key="ses" className="text-muted-foreground tabular-nums">{label}</span>);
    }
    // Access-audit rows: a sensitive read names the field/sub-resource; a denial names the attempted path.
    if (typeof m.field === "string" && m.field) bits.push(<span key="f" className="text-muted-foreground">{fieldLabel(m.field)}</span>);
    // Raw request path: only for a denial / an unresolved (no-target) row — there the attempted path IS the
    // signal. For a normal mutation the action pill + resolved target already say it, so the path is pure noise.
    const showPath = a.action === "access.denied" || (!a.entity_name && !a.entity_ref);
    if (showPath && typeof m.path === "string" && m.path) bits.push(<span key="p" className="font-mono text-xs text-muted-foreground">{String(m.method ?? "")} {m.path}</span>);
    return bits;
  };

  // Single-page log: filter client-side. Paginated: rows already server-filtered.
  const clientMatch = (a: Activity) => {
    if (tone !== "all" && actionTone(a.action) !== tone) return false;
    if (global && entity !== "all" && a.entity !== entity) return false;
    if (global && actor !== "all" && !(a.actor && idOf(a.actor) === idOf(actor))) return false;
    const needle = submittedQ.trim().toLowerCase();
    // Same haystack the server LIKEs (actor + action + the touched OBJECT), plus the object's user-facing type
    // word and its resolved employee name — so "leave request" / "Asha Rao" match here as well as server-side.
    const hay = [nameOf(a), a.actor_email, actionLabel(a.action), a.entity, a.entity && entityLabel(a.entity), targetLabel(a), a.entity_ref, JSON.stringify(a.meta ?? {})];
    if (needle && !hay.filter(Boolean).join(" ").toLowerCase().includes(needle)) return false;
    return true;
  };
  const tonesPresent = useMemo(() => [...new Set((rows ?? []).map((a) => actionTone(a.action)))], [rows]);
  // Object-type options. A single-page log filters client-side, so only the types actually present are offerable.
  // A paginated log filters SERVER-side across all history — there the whole collection catalog is selectable
  // (union'd with whatever the page shows, so an unlisted collection still appears if it has activity).
  const entitiesPresent = useMemo(() => [...new Set((rows ?? []).map((a) => a.entity).filter(Boolean) as string[])].sort(), [rows]);
  const entityOptions = useMemo(() => {
    // BASE_COLLECTIONS ends with the VIRTUAL capabilities (`activity`, `export`) — they gate affordances and are
    // never a touched record, so they'd be dead filter options.
    const catalog = BASE_COLLECTIONS.filter((c) => c !== "activity" && c !== "export");
    const base = paginated ? [...new Set([...catalog, ...entitiesPresent])] : entitiesPresent;
    return base.map((c) => ({ value: c, label: entityLabel(c) })).sort((a, b) => a.label.localeCompare(b.label));
  }, [paginated, entitiesPresent]);
  // Actor options for the global filter: every non-disabled employee, by name (the audit anchors on employee id).
  const actorOptions = useMemo(() => employees.filter((e) => !e.disabled).map((e) => ({ path: e.path, name: `${e.first_name} ${e.last_name}`.trim() })).sort((a, b) => a.name.localeCompare(b.name)), [employees]);
  // The touched record for a global row: employee -> name, else "<Type> · <short id>" (no per-collection reads).
  const targetLabel = (a: Activity): string | null => {
    if (!a.entity) return null;
    // Always lead with the resource TYPE, then the descriptive record name (server-resolved; employees also
    // resolved from the cached list). No id fallback — when nothing resolves, the type alone reads cleaner than
    // a random-looking id fragment.
    const type = entityLabel(a.entity);
    const name = a.entity_name ?? (a.entity === "employees" && a.entity_ref ? empName(a.entity_ref) : undefined);
    return name ? `${type} · ${name}` : type;
  };
  const visible = paginated ? (rows ?? []) : (rows ?? []).filter(clientMatch);

  if (state === "loading" && !rows) return <CardsSkeleton count={4} />;
  if (state === "error") return <p className="py-6 text-center text-sm text-destructive">Couldn't load activity.</p>;
  if (rows && rows.length === 0 && !q && tone === "all" && entity === "all" && actor === "all") return <p className="py-6 text-center text-sm text-muted-foreground">No activity yet.</p>;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <button type="button" aria-label="Search" onClick={() => setSubmittedQ(q)} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
            <Search className="h-3.5 w-3.5" />
          </button>
          <Input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") setSubmittedQ(q); }} placeholder={global ? "Search action, person or record… (Enter)" : "Search activity or record… (Enter)"} className="h-8 pl-7" />
        </div>
        {global && (
          <Select value={entity} onValueChange={setEntity}>
            <SelectTrigger className="h-8 w-40"><SelectValue placeholder="All types" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {entityOptions.map((o) => {
                const Icon = iconOf(o.value);
                return <SelectItem key={o.value} value={o.value}><span className="inline-flex items-center gap-2"><Icon className="h-3.5 w-3.5 opacity-70" />{o.label}</span></SelectItem>;
              })}
            </SelectContent>
          </Select>
        )}
        {global && (
          <Select value={actor} onValueChange={setActor}>
            <SelectTrigger className="h-8 w-44"><SelectValue placeholder="Anyone" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Anyone</SelectItem>
              {actorOptions.map((o) => <SelectItem key={o.path} value={o.path}>{o.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <Select value={tone} onValueChange={setTone}>
          <SelectTrigger className="h-8 w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All actions</SelectItem>
            {(paginated ? (["create", "update", "move", "assign", "remove", "positive", "comment", "read", "denied", "other"] as ActionTone[]) : tonesPresent).map((t) => {
              const Icon = TONE_ICON[t];
              return <SelectItem key={t} value={t}><span className="inline-flex items-center gap-2"><Icon className="h-3.5 w-3.5 opacity-70" />{TONE_LABEL[t]}</span></SelectItem>;
            })}
          </SelectContent>
        </Select>
        <Select value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v))}>
          <SelectTrigger className="h-8 w-[104px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[10, 25, 50, 100].map((n) => <SelectItem key={n} value={String(n)}>{n}/page</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {visible.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{state === "loading" ? "Searching…" : "No matching activity."}</p>
      ) : (
        <ul className={`${global ? "max-h-[68dvh]" : "max-h-[50dvh]"} divide-y overflow-y-auto`}>
          {visible.map((a) => {
            const e = empOf(a);
            const name = nameOf(a);
            const t = actionTone(a.action);
            const ActionIcon = actionIcon(a.action);
            const title = [new Date(a.create_time).toLocaleString(), a.ip, a.user_agent].filter(Boolean).join(" · ");
            // The touched record's destination page (deep record page where supported, else the list page).
            const route = global && a.entity ? resourceRoute(a.entity, a.entity_ref) : null;
            // Type glyph for the touched record — the same icon its nav entry / Settings panel uses (via iconOf),
            // so the feed never drifts from the sidebar. Rendered inside all three chip variants.
            const TargetIcon = a.entity ? iconOf(a.entity) : null;
            const targetChip = (
              <>
                {TargetIcon && <TargetIcon className="h-3 w-3 shrink-0 opacity-70" />}
                {targetLabel(a)}
              </>
            );
            return (
              <li key={a.path} className="flex items-start gap-2 py-2">
                {e ? <PhotoAvatar employeeId={idOf(e.path)} name={name} className="mt-0.5 h-6 w-6 text-[10px]" /> : <PersonAvatar name={name} className="mt-0.5 h-6 w-6 text-[10px]" />}
                <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-sm">
                  <span className="font-medium">{name}</span>
                  <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${TONE_CLS[t]}`}>
                    <ActionIcon className="h-3 w-3 shrink-0" />
                    {actionLabel(a.action)}
                  </span>
                  {/* Org-wide feed: which record was touched. Clicking the name opens its page (the exact record
                      where the page deep-links, else the list); a trailing icon drills into its own trail. */}
                  {global && a.entity && (
                    <span className="inline-flex items-center gap-0.5">
                      {route ? (
                        <button type="button" onClick={() => navigate(route)} title={opensExactRecord(a.entity) ? "Open record" : "Open page"} className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                          {targetChip}
                        </button>
                      ) : a.entity_ref ? (
                        <button type="button" onClick={() => setDrill({ resource: a.entity_ref!, label: targetLabel(a) })} className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                          {targetChip}
                        </button>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{targetChip}</span>
                      )}
                      {a.entity_ref && (
                        <button type="button" onClick={() => setDrill({ resource: a.entity_ref!, label: targetLabel(a) })} title="Record activity" aria-label="Record activity" className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground">
                          <History className="h-3 w-3" />
                        </button>
                      )}
                    </span>
                  )}
                  {inline(a)}
                </div>
                <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground" title={title}>{timeAgo(a.create_time)}</span>
              </li>
            );
          })}
        </ul>
      )}
      {nextToken && <Button variant="ghost" size="sm" className="w-full text-muted-foreground" onClick={loadMore} loading={loadingMore}>Load older</Button>}
      {/* Drill into one record's own trail (global feed). The nested feed reads lazily, only while open. The
          record identity lives in the title, so the rows don't repeat it. */}
      <Dialog open={!!drill} onOpenChange={(o) => !o && setDrill(null)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader><DialogTitle>{drill?.label || "Activity"}</DialogTitle></DialogHeader>
          {drill && <ActivityFeed resource={drill.resource} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
