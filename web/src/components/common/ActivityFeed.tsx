import { useEffect, useMemo, useRef, useState } from "react";
import { Search, History, ChevronLeft, ChevronRight } from "lucide-react";
import { batchGet, get } from "@/api";
import { navigate } from "@/router";
import { useCollection } from "@/hooks/useCollection";
import { formatDate, formatDateTime, formatTime, idOf } from "@/lib/utils";
import { resourceRoute, opensExactRecord } from "@/lib/resourceRoute";
import type { Activity, ActivityPage, Employee } from "@/types";
import { actionIcon, actionLabel, actionTone, TONE_ICON, TONE_LABEL, timeAgo, type ActionTone } from "@/lib/activity";
import { entityLabel, iconOf } from "@/lib/entityKinds";
import { BASE_COLLECTIONS } from "@/components/access/permMatrix";
import { PhotoAvatar } from "./PhotoAvatar";
import { PersonAvatar } from "./PersonAvatar";
import { CardsSkeleton } from "@/components/common/Skeletons";
import { SearchInput } from "@/components/common/SearchInput";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// On-demand audit trail for one resource. Mount only when opened (never eager). A table - who / action /
// record / details / when - because every row answers the same questions and a column is what lets the eye run
// down one of them; it folds into labelled blocks on a phone (`table-stack`). Filtering: a single-page log
// filters CLIENT-SIDE (instant, no reads); a paginated log filters SERVER-SIDE (so search spans all history,
// not just loaded pages). IP/UA in the timestamp tooltip. Names resolve from cached employees.
// Human field label: drop storage suffixes (columnsJson → columns, employeeId → employee), de-camel, de-snake.
// A sensitive-read row names the custom method as `:bankFile` — drop the leading colon so it reads "bank file".
const fieldLabel = (k: string) => k.replace(/^:/, "").replace(/(Id|Json)$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_(id|json)$/i, "").replace(/_/g, " ").trim().toLowerCase();
// Collection -> the user-facing word for the org-wide feed's type chip/filter, shared with global search so
// both name a collection the same way.
// A date or timestamp column diffs as an ISO string (lib/audit fieldDiff normalizes every Date through
// toISOString), which is both unreadable at a glance and long enough to crowd every other change out of the
// row. Returns undefined for anything that is not an ISO date, so the caller falls through to plain text.
//
// Midnight UTC is how this app stores a DATE (an effective_from, a leave day, a holiday) - so it is formatted
// in UTC, or a browser east of Greenwich would render 2026-01-01 as "31 Dec 2025". Anything carrying a real
// time of day is an INSTANT and is shown in the reader's own zone, where that is the only reading that means
// anything. A zone-less `T00:00:00` is neither reliably, so it is left alone.
const ISO_RE = /^(\d{4}-\d{2}-\d{2})(?:T([\d:.]+)Z)?$/;
function fmtIso(v: string): string | undefined {
  const m = ISO_RE.exec(v);
  if (!m) return undefined;
  const d = new Date(m[2] ? v : `${m[1]}T00:00:00Z`);
  if (isNaN(+d)) return undefined;
  return !m[2] || /^00:00(:00(\.0+)?)?$/.test(m[2])
    ? formatDate(m[1]!)
    : formatDateTime(v);
}

// One "field: old → new" as a self-contained chip.
//
// The VALUES carry the mask, not the chip: this feed spans every collection, so a change chip is as likely to
// hold a salary or an account number as a ticket status, and /activity is not one of the masked routes (it is
// mostly labels - masking the page would be the over-masking instrument.ts argues against). The field NAME
// stays readable, so a session replay still shows which field moved without showing what it moved to.
function ChangeChip({ label, from, to, fmt }: { label: string; from: unknown; to: unknown; fmt: (v: unknown) => string }) {
  return (
    <span className="inline-flex max-w-full items-baseline gap-1 rounded border bg-muted/40 px-1.5 py-0.5 text-[11px] leading-5">
      {/* A legacy `{from, to}` meta carries no field name; the chip is then just the two values. */}
      {label && <span className="shrink-0 capitalize text-muted-foreground">{label}</span>}
      <span data-sentry-mask className="text-muted-foreground line-through decoration-muted-foreground/60">{fmt(from)}</span>
      <span className="shrink-0 text-muted-foreground/70">→</span>
      <span data-sentry-mask className="font-medium">{fmt(to)}</span>
    </span>
  );
}

// A `<collection>/<token>` value in an audit entry - the server writes every foreign key that way so an
// internal id never reaches the wire and the reader's client has something it can resolve.
const REF_RE = /^([a-z][a-z-]+)\/([A-Za-z0-9_-]{6,})$/;
const refOf = (v: unknown) => (typeof v === "string" ? REF_RE.exec(v) : null);

// What acted, when the actor is the system principal: `via_automation` names the rule, `via_cron` the schedule.
// Stamped by lib/audit from `deps.actingAs`.
function actedBy(a: Activity): { kind: "automation" | "cron"; name: string; ref?: string } | null {
  const m = (a.meta ?? {}) as Record<string, { name?: string; ref?: string } | undefined>;
  for (const kind of ["automation", "cron"] as const) {
    const v = m[`via_${kind}`];
    if (v?.name) return { kind, name: v.name, ref: v.ref };
  }
  return null;
}

// SCREAMING_SNAKE and lower_snake are how a state machine writes to a column, not how a person reads one.
// Only touched when the whole string IS one token of that shape: a sentence with a space in it is prose
// somebody typed, and mangling its capitalisation would be worse than leaving it alone.
const ENUMISH = /^(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)$/;
const humanizeEnum = (v: string) => {
  const words = v.toLowerCase().split("_");
  return words[0]!.charAt(0).toUpperCase() + words[0]!.slice(1) + (words.length > 1 ? ` ${words.slice(1).join(" ")}` : "");
};

// A user agent is a machine's self-description; a reader wants the two facts in it. Best-effort by design -
// an unrecognised string is shown as it came rather than guessed at, because "unknown browser" is worse than
// the raw truth when the question is which client did something.
function deviceOf(ua: string): string {
  const browser = /Edg\/(\d+)/.exec(ua) ? `Edge ${/Edg\/(\d+)/.exec(ua)![1]}`
    : /OPR\/(\d+)/.exec(ua) ? `Opera ${/OPR\/(\d+)/.exec(ua)![1]}`
    : /Chrome\/(\d+)/.exec(ua) ? `Chrome ${/Chrome\/(\d+)/.exec(ua)![1]}`
    : /Firefox\/(\d+)/.exec(ua) ? `Firefox ${/Firefox\/(\d+)/.exec(ua)![1]}`
    : /Version\/(\d+).*Safari/.exec(ua) ? `Safari ${/Version\/(\d+).*Safari/.exec(ua)![1]}`
    : null;
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS"
    : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : null;
  return browser && os ? `${browser} on ${os}` : browser ?? os ?? ua;
}

// The fields an entry touched. Some services predate `meta.diff` and stamp a bare top-level `{from, to}` with
// no field name; normalized to the same shape here so the row preview and the detail view share ONE reading of
// what changed and can never disagree about it.
function changesOf(a: Activity): [string, { from: unknown; to: unknown }][] {
  const m = (a.meta ?? {}) as Record<string, unknown>;
  if (a.meta?.diff && Object.keys(a.meta.diff).length) return Object.entries(a.meta.diff);
  if ("from" in m || "to" in m) return [["", { from: m.from, to: m.to }]];
  return [];
}

// The row's Details cell: one chip per change. A chip per change reads as a list - run together as prose,
// "a → b c → d e → f" gave the reader no boundary between one change and the next.
//
// Past three it says how many it is not showing, and stops. This is a PREVIEW, not a disclosure: the cell is
// itself a button onto the full before/after view, so an expander inside it would be a second affordance for
// the same question, and the smaller one at that.
const CHANGE_PREVIEW = 3;
function ChangePreview({ items, fmt }: { items: [string, { from: unknown; to: unknown }][]; fmt: (v: unknown) => string }) {
  const hidden = Math.max(0, items.length - CHANGE_PREVIEW);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {items.slice(0, CHANGE_PREVIEW).map(([k, v]) => (
        <ChangeChip key={k} label={fieldLabel(k)} from={v.from} to={v.to} fmt={fmt} />
      ))}
      {hidden > 0 && <span className="px-0.5 text-[11px] font-medium text-muted-foreground">+{hidden} more</span>}
    </div>
  );
}

// The whole of one audit entry, opened from its Details cell.
//
// It exists because the row is a preview: chips there are capped and their values clipped to keep a hundred
// rows scannable, so there has to be one place that shows the entry entire. Every changed field, in full, as
// before/after columns - then the identity facts (IP, device) that were only ever in a tooltip, and finally the
// raw meta behind a disclosure, so a key the feed has no renderer for is visible rather than silently dropped.
// A trail that quietly omits part of itself is worse than none, because it is trusted.
function ActivityDetail({ row, who, record, extras, fmt, onShowAct, onShowSession, onShowCase }: {
  row: Activity;
  who: string;
  record: string | null;
  extras: React.ReactNode[];
  fmt: (v: unknown) => string;
  /** Open the whole ACT this entry belongs to - every entry the same request or cron tick wrote. */
  onShowAct?: (correlationId: string) => void;
  /** Open the whole SITTING - every act of the login this entry was written under. */
  onShowSession?: (sessionId: string) => void;
  /** Open the whole STORY this entry's record belongs to, by that record's ref. */
  onShowCase?: (rootRef: string) => void;
}) {
  const changes = changesOf(row);
  const via = actedBy(row);
  // A case can only be rooted at a record that HAS a story - see CASE_ROOTS server-side. Offering the link on
  // anything else would be offering a 400.
  const caseRootable = ["applications", "candidates", "offers", "transitions", "employees", "payroll-runs", "org-documents", "personal-documents"];
  const zoom = [
    ...(row.correlation_id && onShowAct ? [{ label: "Show everything this action changed", onClick: () => onShowAct(row.correlation_id!) }] : []),
    ...(row.session_id && onShowSession ? [{ label: "Show the rest of this sitting", onClick: () => onShowSession(row.session_id!) }] : []),
    ...(row.entity && row.entity_ref && caseRootable.includes(row.entity) && onShowCase
      ? [{ label: "Show the whole story", onClick: () => onShowCase(row.entity_ref!) }]
      : []),
  ];
  const fact = (label: string, value: React.ReactNode) => (
    <>
      <dt className="whitespace-nowrap text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </>
  );
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        {fact("Who", <>{who} <span className="text-muted-foreground">· {row.actor_email}</span></>)}
        {/* The authority the act was performed under, not whatever the actor holds today - "who approved this"
            reads differently as payroll_admin than as super_admin, and roles move. */}
        {row.actor_role && fact("Acting as", humanizeEnum(row.actor_role))}
        {via && fact(via.kind === "cron" ? "Scheduled job" : "Automation", via.name)}
        {/* WHICH grant allowed it. A denial has always explained itself; this is the same answer on the other
            side. The pattern, not a rule - it narrows "which rule was this?" to a handful. */}
        {typeof row.meta?.authorized_by === "string" && fact("Authorized by", <code className="rounded bg-muted px-1 py-0.5 text-xs">{row.meta.authorized_by}</code>)}
        {fact("Action", actionLabel(row.action))}
        {record && fact("Record", record)}
        {fact("When", formatDateTime(row.create_time))}
        {/* Where from, on what: only ever in a tooltip before this view existed, which is no place for the two
            facts an incident review needs. Masked from replay - an IP locates a person. */}
        {row.ip && fact("IP address", <span data-sentry-mask className="font-mono text-xs">{row.ip}</span>)}
        {row.user_agent && fact("Device", <span data-sentry-mask className="text-xs" title={row.user_agent}>{deviceOf(row.user_agent)}</span>)}
      </dl>

      {changes.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Changes</p>
          {/* On the dialog's ground, not the page's - see the `--scroll-ground` note in index.css. */}
          <div className="scroll-shadow-x overflow-x-auto [--scroll-ground:hsl(var(--card))]">
            <table className="table-stack w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-1.5 pr-3 font-medium">Field</th>
                  <th className="py-1.5 pr-3 font-medium">Before</th>
                  <th className="py-1.5 font-medium">After</th>
                </tr>
              </thead>
              <tbody>
                {changes.map(([k, v]) => (
                  <tr key={k} className="border-b align-top last:border-0">
                    {/* Values masked, field names not - see ChangeChip. */}
                    <td className="py-1.5 pr-3 capitalize">{fieldLabel(k) || "value"}</td>
                    <td data-label="Before" data-sentry-mask className="py-1.5 pr-3 text-muted-foreground line-through decoration-muted-foreground/50">{fmt(v.from)}</td>
                    <td data-label="After" data-sentry-mask className="py-1.5 font-medium">{fmt(v.to)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {extras.length > 0 && <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-sm">{extras}</div>}

      {row.meta && Object.keys(row.meta).length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground">Raw entry</summary>
          {/* Blanket mask: this is the unrendered remainder of the entry, so by definition nothing here has
              been vetted for what it might contain. */}
          <pre data-sentry-mask className="mt-1 max-h-64 overflow-auto rounded border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">{JSON.stringify(row.meta, null, 2)}</pre>
        </details>
      )}

      {/* Three ways to widen out from one entry, in order of how far they reach: the ACT it was part of (one
          request - accepting an offer creates the employee, their compensation and the hire), the SITTING it
          was written in (one login), and the STORY its record belongs to (one hire, over weeks). Reading a
          single entry without any of them is reading a fraction of what happened. */}
      {(zoom.length > 0) && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t pt-3">
          {zoom.map((z) => (
            <button
              key={z.label}
              type="button"
              onClick={z.onClick}
              className="text-xs font-medium text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
            >
              {z.label} →
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

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
export function ActivityFeed({ resource, global = false, initialEntity, apiKey, correlation, subject, session, caseRoot }: {
  resource?: string;
  global?: boolean;
  initialEntity?: string;
  /** Narrow the org-wide feed to everything ONE credential did (`api-keys/<id>`). */
  apiKey?: string;
  /** Narrow to ONE act: every entry a single request or cron tick wrote. */
  correlation?: string;
  /** Narrow to everything that happened TO one person, across every collection (`employees/<id>`). */
  subject?: string;
  /** Narrow to one SITTING: every act of a single login. */
  session?: string;
  /** Narrow to one long-running STORY, by its root record (`applications/<id>`, `transitions/<id>`, ...). */
  caseRoot?: string;
}) {
  const { rows: employees } = useCollection<Employee>("employees", { all: true });
  const [rows, setRows] = useState<Activity[] | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [q, setQ] = useState(""); // typed text
  const [submittedQ, setSubmittedQ] = useState(""); // committed query (applied on Enter / search button)
  const [tone, setTone] = useState<string>("all");
  const [entity, setEntity] = useState<string>(initialEntity ?? "all"); // global feed: narrow to one collection
  const [actor, setActor] = useState<string>("all"); // global feed: narrow to one actor (employee path)
  const [drill, setDrill] = useState<{ resource: string; label: string | null } | null>(null); // global feed: open one record's own trail
  const [detail, setDetail] = useState<Activity | null>(null); // one entry, entire (opened from its Details cell)
  const [act, setAct] = useState<string | null>(null); // the whole act one entry belongs to (its correlation id)
  const [sitting, setSitting] = useState<string | null>(null); // the whole login one entry belongs to
  const [story, setStory] = useState<string | null>(null); // the whole case one entry belongs to (root ref)
  const [refNames, setRefNames] = useState<Record<string, string>>({}); // `<collection>/<token>` -> record name
  const [nextToken, setNextToken] = useState<string | undefined>();
  // Page tokens this walk has already followed - see `loadMore`. Cleared whenever the feed is re-read from the
  // top, since that is a new walk.
  const seenTokens = useRef(new Set<string>());
  const [paginated, setPaginated] = useState(false); // true once the unfiltered log is known to have >1 page
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageSize, setPageSize] = useState(25);
  const fetchKey = useRef(""); // dedupes the server-filter effect against the initial load
  const sizeInited = useRef(false);
  const scope = resource ?? apiKey ?? (correlation ? `act:${correlation}` : subject ? `subject:${subject}` : session ? `session:${session}` : caseRoot ? `case:${caseRoot}` : "*"); // stable key for the initial-load effect

  const params = (extra: Record<string, string | undefined>) => {
    const u = new URLSearchParams(resource ? { resource } : apiKey ? { api_key: apiKey } : correlation ? { correlation } : subject ? { subject } : session ? { session } : caseRoot ? { case: caseRoot } : {});
    for (const [k, v] of Object.entries(extra)) if (v) u.set(k, v);
    return `activity?${u.toString()}`;
  };
  const filterQuery = () => ({ q: submittedQ.trim() || undefined, tone: tone !== "all" ? tone : undefined, entity: global && entity !== "all" ? entity : undefined, actor: global && actor !== "all" ? actor : undefined });

  // Initial (unfiltered) load. Establishes whether the log is paginated.
  //
  // KEYED ON `scope` ALONE, deliberately. This effect is the RESET - it clears the rows, the search box, every
  // filter and the pagination flag - and the only thing that should cause it is the feed being pointed at a
  // different subject. `pageSize` and `initialEntity` are read for their value AT THAT MOMENT and have their
  // own paths: changing the page size reloads page 1 in the effect below (without wiping the filters), and
  // `initialEntity` is a starting position, not a live input. Listing them here would turn "show 50 per page"
  // into "throw away what I had filtered". `params` reads only the props `scope` is derived from, so it is
  // covered by `scope` already. The array is narrower than what the body reads, and that is the intent.
  useEffect(() => {
    let live = true;
    setState("loading"); setRows(null); setNextToken(undefined); setPaginated(false); setQ(""); setSubmittedQ(""); setTone("all"); setEntity(initialEntity ?? "all"); setActor("all");
    fetchKey.current = `${scope}||all|all|all|`;
    get<ActivityPage>(params({ max_page_size: String(pageSize) }))
      .then((p) => { if (!live) return; setRows(p.results); seenTokens.current.clear(); setNextToken(p.next_page_token); setPaginated(!!p.next_page_token); fetchKey.current = `${scope}||all|all|all|${!!p.next_page_token}`; setState("ready"); })
      .catch(() => { if (live) setState("error"); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset-on-scope-change; see the note above
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
        .then((p) => { if (!live) return; setRows(p.results); seenTokens.current.clear(); setNextToken(p.next_page_token); setState("ready"); })
        .catch(() => { if (live) setState("error"); });
    }, 300);
    return () => { live = false; clearTimeout(h); };
    // The array is the FILTER STATE this refetch is for; `params`/`filterQuery` are read inside and are pure
    // over exactly these values plus the scope props, and `pageSize` has its own effect below. `fetchKey`
    // dedupes against whatever the initial load already fetched.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- filter-change refetch; see above
  }, [submittedQ, tone, entity, actor, paginated, scope]);

  // Page-size change: reload page 1 at the new size (preserving filters); recompute pagination.
  useEffect(() => {
    if (!sizeInited.current) { sizeInited.current = true; return; }
    let live = true;
    setState("loading");
    get<ActivityPage>(params({ max_page_size: String(pageSize), ...filterQuery() }))
      .then((p) => { if (!live) return; setRows(p.results); seenTokens.current.clear(); setNextToken(p.next_page_token); setPaginated(!!p.next_page_token); fetchKey.current = `${scope}|${submittedQ.trim()}|${tone}|${entity}|${actor}|${!!p.next_page_token}`; setState("ready"); })
      .catch(() => { if (live) setState("error"); });
    return () => { live = false; };
    // Page size ONLY: the current filters are read inside so the reload preserves them, and depending on them
    // here would re-run this on every filter change - which is the effect above's job.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- page-size reload; see above
  }, [pageSize]);

  async function loadMore() {
    if (!nextToken || loadingMore) return;
    setLoadingMore(true);
    try {
      const p = await get<ActivityPage>(params({ page_token: nextToken, max_page_size: String(pageSize), ...(paginated ? filterQuery() : {}) }));
      setRows((r) => [...(r ?? []), ...p.results]);
      // A cursor that fails to advance is the failure `api.ts#listAll` and `#getAllPages` keep a `seen` set
      // for; this walk is user-driven, so the worst case was a pile of duplicated rows (with duplicate `path`
      // keys in the list) rather than a hang - but a token we have already followed is the end of the walk.
      seenTokens.current.add(nextToken);
      setNextToken(p.next_page_token && !seenTokens.current.has(p.next_page_token) ? p.next_page_token : undefined);
    } catch { /* leave what we have */ }
    finally { setLoadingMore(false); }
  }

  const empName = (ref?: string) => { const e = ref ? employees.find((x) => idOf(x.path) === idOf(ref)) : undefined; return e ? `${e.first_name} ${e.last_name}` : undefined; };
  const empOf = (a: Activity) => (a.actor ? employees.find((e) => idOf(e.path) === idOf(a.actor!)) : undefined);
  // Prefer the server-resolved actor name (works even for actors not in the loaded employees page); then the
  // cached employee; finally the email (system/unlinked actors have no name).
  const nameOf = (a: Activity) => {
    // An automation or a cron tick runs as the system principal, so the actor columns can only say "System".
    // The meta names the rule (or the schedule) that actually did it, and that is what the reader came for.
    const via = actedBy(a);
    if (via) return via.name;
    if (a.actor_name) return a.actor_name;
    const e = empOf(a);
    return e ? `${e.first_name} ${e.last_name}` : a.actor_email;
  };

  const clip = (s: string) => (s.length > 48 ? s.slice(0, 48) + "…" : s);
  const fmt = (v: unknown): string => {
    if (v === null || v === undefined || v === "") return "—";
    if (typeof v === "boolean") return v ? "yes" : "no";
    // Thousands separators from 10,000 up, where a bare run of digits stops being readable at a glance. The
    // floor is what keeps a year out of it: no year is ever five digits, so "2026" can never come out "2,026"
    // and this needs no guess about what the column means.
    if (typeof v === "number") return Math.abs(v) >= 10000 ? v.toLocaleString() : String(v);
    if (typeof v === "string") {
      if (/^employees\//.test(v)) return empName(v) ?? "someone";
      // A ref the caller may read resolves to the record's NAME (see `useRefNames`); until it does - or when
      // they may not read it - the TYPE is the honest answer, and a raw token was never any answer at all.
      const ref = refOf(v);
      if (ref) return refNames[v] ?? entityLabel(ref[1]!);
      if (ENUMISH.test(v)) return humanizeEnum(v);
      return fmtIso(v) ?? clip(v);
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
  // Everything about the row that is NOT a field change: the reason, the subject, the attempted path. Shown
  // under the change chips in the same cell, since both answer "what actually happened here".
  const inline = (a: Activity): React.ReactNode[] => {
    const m = a.meta ?? {};
    const bits: React.ReactNode[] = [];
    if (typeof m.reason === "string" && m.reason) bits.push(<span key="r" className="text-muted-foreground">— {m.reason}</span>);
    // Progress-update notes (goal.updateProgress meta): same dash treatment as reasons.
    if (typeof m.note === "string" && m.note) bits.push(<span key="n" className="text-muted-foreground">— {m.note}</span>);
    if (typeof m.blockedBy === "string") bits.push(<span key="b" className="text-muted-foreground">by {fmt(m.blockedBy)}</span>);
    if (Array.isArray(m.changed) && m.changed.length) bits.push(<span key="c" className="text-muted-foreground">{m.changed.map((k) => fieldLabel(String(k))).join(", ")}</span>);
    // Write-backstop rows (services with no inline diff): the touched field NAMES, so a bare update/create still
    // reads as "updated · title, status". Suppressed when a real diff/changed is present (avoid duplication).
    // A `fields` entry is usually a column name, but a few verbs list the RECORDS they touched instead (the
    // peers nominated onto a review, the reviewees added to a cycle) - those arrive as `<collection>/<token>`
    // refs, and running them through `fieldLabel` would print the token. Resolve those to a name.
    if (Array.isArray(m.fields) && m.fields.length && !m.diff && !Array.isArray(m.changed)) bits.push(<span key="fl" className="text-muted-foreground">{(m.fields as string[]).map((k) => (refOf(k) ? fmt(k) : fieldLabel(String(k)))).join(", ")}</span>);
    // Subject + day, for rows about someone else's record on a given date (e.g. an attendance regularization:
    // "for Asha Rao on 2026-07-14"). `employee` is a ref → resolved to a name; `date` is a plain YYYY-MM-DD.
    // Name the subject employee, unless they ARE the actor (a self-filed row) - "Asha requested for Asha" is noise.
    if (typeof m.employee === "string" && m.employee && !(a.actor && idOf(m.employee) === idOf(a.actor))) bits.push(<span key="emp" className="text-muted-foreground">for {fmt(m.employee)}</span>);
    if (typeof m.date === "string" && m.date) bits.push(<span key="dt" className="text-muted-foreground">on {m.date}</span>);
    // A set of in/out session pairs (e.g. an attendance correction's requested times) → "09:00–13:00, 14:00–18:10".
    if (Array.isArray(m.sessions)) {
      const hm = (iso: unknown) => (typeof iso === "string" ? formatTime(iso) : "?");
      const pairs = m.sessions as { clock_in?: string; clock_out?: string }[];
      const label = pairs.length ? pairs.map((p) => `${hm(p.clock_in)}–${p.clock_out ? hm(p.clock_out) : "still clocked in"}`).join(", ") : "no punches";
      bits.push(<span key="ses" className="text-muted-foreground tabular-nums">{label}</span>);
    }
    // Permission changes (`access-rule.*`): the rule itself, in words, plus who it is for.
    //
    // A rule write has no field diff - the whole of what happened is WHICH access moved for WHOM - so this cell
    // was empty for every one of them, and the row said only that somebody had touched an access rule. The
    // server stamps the plain-language sentence and the subject on every rule event (it also hard-deletes the
    // row on the delete / reject / expiry paths, so the meta is the only place left to read it from).
    // `access-rule.clone` has no rule of its own (it is the copy, not one of the rules it wrote), so the
    // branch keys on the action as well as on the rule id.
    const isRuleEvent = typeof m.rule_id === "string" || a.action.startsWith("access-rule.");
    if (isRuleEvent) {
      // The subject as a person where the meta carries their employee ref, else the label the server wrote
      // (their email, or "the hr role"). A user rule's stored subject is a users uuid and names nobody.
      const who = typeof m.subject_employee === "string" ? empName(m.subject_employee) : undefined;
      const subject = who ?? (typeof m.subject_label === "string" ? m.subject_label : null);
      // A four-eyes decision approves either a grant or a REMOVAL - opposite outcomes under one action code.
      const removal = m.decided === "removal" ? "removal of " : "";
      const sentence = typeof m.sentence === "string" && m.sentence ? `${removal}${m.sentence}` : null;
      if (subject || sentence) bits.push(<span key="rule" className="text-muted-foreground">{[subject, sentence].filter(Boolean).join(" · ")}</span>);
      // A pending row is a request, not a live grant; an expiry is the one fact that says a grant is temporary.
      if (m.status === "pending" || m.status === "pending_delete") bits.push(<span key="rst" className="text-muted-foreground">awaiting approval</span>);
      if (typeof m.expire_time === "string") bits.push(<span key="rex" className="text-muted-foreground">expires {fmtIso(m.expire_time) ?? m.expire_time}</span>);
      if (typeof m.requested_by === "string") bits.push(<span key="rrq" className="text-muted-foreground">requested by {fmt(m.requested_by)}</span>);
      // A copy that refused part of itself says so here; the per-rule entries under the same act say which.
      if (typeof m.failed === "number" && m.failed > 0) bits.push(<span key="rfl" className="text-muted-foreground">{m.failed} rejected</span>);
    }
    // Access-audit rows: a sensitive read names the field/sub-resource; a denial names the attempted path. Not
    // for a rule row: there the field is part of the rule, and the sentence above already reads it out.
    if (typeof m.field === "string" && m.field && !isRuleEvent) bits.push(<span key="f" className="text-muted-foreground">{fieldLabel(m.field)}</span>);
    // Facts a service stamps in place of a diff, which were stored and then never shown, so the cell read as
    // empty: the plain-language sentence on a row that is not a rule event (an access request), how a lifecycle
    // step was reached, how many sign-ins it closed, the file slot an upload filled, a card re-ordered within its
    // column, and the length of a comment whose text is deliberately not kept.
    if (!isRuleEvent && typeof m.sentence === "string" && m.sentence) bits.push(<span key="snt" className="text-muted-foreground">{m.sentence}</span>);
    if (typeof m.via === "string" && m.via) bits.push(<span key="via" className="text-muted-foreground">via {m.via.replace(/[-_]/g, " ")}</span>);
    if (typeof m.users === "number" && m.users > 0) bits.push(<span key="usr" className="text-muted-foreground">{m.users} sign-in{m.users === 1 ? "" : "s"} closed</span>);
    if (typeof m.slot === "string" && m.slot) bits.push(<span key="slt" className="text-muted-foreground">{fieldLabel(m.slot)}</span>);
    if (m.reordered === true) bits.push(<span key="ro" className="text-muted-foreground">reordered in its column</span>);
    if (typeof m.note_chars === "number" && m.note_chars > 0) bits.push(<span key="nc" className="text-muted-foreground">{m.note_chars} character{m.note_chars === 1 ? "" : "s"}</span>);
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

  // Name the records an OPEN entry points at. A foreign key is stored as `<collection>/<token>`, which is
  // resolvable but not readable - "Leave type · Annual leave" is the answer, "leave-types/AbCdEf" is not.
  //
  // Resolved for the open entry ALONE, not the page: it costs one batched request against a handful of paths
  // instead of one per row of a hundred-row feed, and it is only in the detail view that the reader is asking
  // about this record rather than scanning past it. Employees are skipped - the cached directory already
  // answers those for free. A ref the caller may not read comes back 403 and keeps its type name, so this
  // resolves nothing the reader could not have opened themselves.
  useEffect(() => {
    if (!detail) return;
    const paths = [...new Set(
      Object.values(detail.meta?.diff ?? {})
        .flatMap((v) => [v.from, v.to])
        // Flattened one level: a few verbs list the records they touched as an ARRAY of refs (`fields` on a
        // review nomination), and those need naming exactly as much as a scalar ref does.
        .concat(Object.values(detail.meta ?? {}).flatMap((v) => (Array.isArray(v) ? v : [v])))
        .map((v) => refOf(v))
        .filter((m): m is RegExpExecArray => !!m && m[1] !== "employees")
        .map((m) => m[0]),
    )].filter((p) => !(p in refNames)).slice(0, 12);
    if (!paths.length) return;
    let live = true;
    batchGet(paths)
      .then((rs) => {
        if (!live) return;
        const found: Record<string, string> = {};
        rs.forEach((r, i) => {
          const b = r.status === 200 ? (r.body as Record<string, unknown> | null) : null;
          const name = b && [b.display_name, b.name, b.title, b.subject, b.label].find((x) => typeof x === "string" && x.trim());
          if (name) found[paths[i]!] = String(name);
        });
        if (Object.keys(found).length) setRefNames((prev) => ({ ...prev, ...found }));
      })
      .catch(() => { /* an unresolvable ref keeps its type name; nothing to report */ });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.path]);

  // Stepping through the log from inside the detail dialog. An audit read is nearly always "what happened
  // AROUND this" - the entry before it is half the answer - and closing the dialog to click the next row loses
  // the place every time.
  //
  // Resolved by PATH, not by a stored index: `visible` moves under the dialog (a "Load older", a filter change
  // while it is open), and an index would then point at a different entry than the one on screen.
  const detailIdx = detail ? visible.findIndex((r) => r.path === detail.path) : -1;
  // Left/right follow the LIST, not the clock: the list is newest-first, so the row above (left) is the newer
  // one. Naming the buttons "Newer"/"Older" rather than "Previous"/"Next" is the point - "previous entry" in a
  // reverse-chronological log is genuinely ambiguous about which way it means.
  const stepDetail = (delta: number) => {
    const to = detailIdx < 0 ? undefined : visible[detailIdx + delta];
    if (to) setDetail(to);
  };

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
          <SearchInput value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") setSubmittedQ(q); }} placeholder={global ? "Search action, person or record… (Enter)" : "Search activity or record… (Enter)"} className="h-8 pl-7" />
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
        /* A log is a table: every row answers the same five questions, and columns are what let the eye run
           DOWN one of them ("everything Priya did", "every deletion") instead of re-reading each sentence to
           find where the answer sits. `table-stack` (index.css) folds it back into labelled blocks on a
           phone, where columns have nowhere to go. The header sticks so a 100-row page keeps its labels. */
        <div className={`${global ? "max-h-[68dvh]" : "max-h-[50dvh]"} scroll-shadow-x overflow-auto [--scroll-ground:hsl(var(--card))]`}>
          {/* No min-width: this feed renders everywhere from a full page to a record dialog, and any floor
              picked for the page turns into a scrollbar in the dialogs. Auto table layout sizes the four short
              columns to their content and lets Details take the slack, so it degrades by wrapping rather than
              by scrolling. `overflow-auto` is the backstop for the cases where even that is not enough. */}
          <table className="table-stack w-full text-sm">
            <thead className="sticky top-0 z-10 bg-card">
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Who</th>
                <th className="py-2 pr-3 font-medium">Action</th>
                {global && <th className="py-2 pr-3 font-medium">Record</th>}
                {/* Not "Change": the column also carries a denial's attempted path and a sensitive read's
                    field, and those rows changed nothing. */}
                <th className="py-2 pr-3 font-medium">Details</th>
                <th className="py-2 text-right font-medium">When</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((a) => {
                const e = empOf(a);
                const name = nameOf(a);
                const t = actionTone(a.action);
                const ActionIcon = actionIcon(a.action);
                const title = [formatDateTime(a.create_time), a.ip, a.user_agent].filter(Boolean).join(" · ");
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
                const changes = changesOf(a);
                const extras = inline(a);
                return (
                  <tr key={a.path} className="border-b align-top last:border-0 sm:hover:bg-muted/30">
                    {/* First cell = the row's title on a phone, so it carries no data-label. */}
                    <td className="py-2 pr-3">
                      <span className="flex items-center gap-2">
                        {e ? <PhotoAvatar employeeId={idOf(e.path)} name={name} photo={e.photo} className="h-6 w-6 shrink-0 text-[10px]" /> : <PersonAvatar name={name} className="h-6 w-6 shrink-0 text-[10px]" />}
                        <span className="font-medium">{name}</span>
                      </span>
                    </td>
                    <td data-label="Action" className="whitespace-nowrap py-2 pr-3">
                      <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${TONE_CLS[t]}`}>
                        <ActionIcon className="h-3 w-3 shrink-0" />
                        {actionLabel(a.action)}
                      </span>
                    </td>
                    {/* Org-wide feed: which record was touched. Clicking the name opens its page (the exact record
                        where the page deep-links, else the list); a trailing icon drills into its own trail. A
                        per-record feed drops the column outright - it would repeat one value down every row. */}
                    {global && (
                      <td data-label="Record" className="py-2 pr-3">
                        {a.entity && (
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
                      </td>
                    )}
                    {/* No data-label: the chips are a wrapped LIST, and the stacked label/value pair would squash
                        them into a right-aligned column. index.css renders an unlabelled cell as a plain block.
                        The whole cell is the button onto the full entry - the chips are a clipped preview, so
                        the thing the reader wants to click is exactly the thing that is not showing everything.
                        A row with nothing to detail stays inert rather than offering a door onto an empty room. */}
                    <td className="py-0 pr-3">
                      {changes.length || extras.length ? (
                        <button
                          type="button"
                          onClick={() => setDetail(a)}
                          title="Show the full entry"
                          className="-mx-1 w-full space-y-1 rounded px-1 py-2 text-left transition-colors hover:bg-accent/60 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {changes.length > 0 && <ChangePreview items={changes} fmt={fmt} />}
                          {extras.length > 0 && <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">{extras}</div>}
                        </button>
                      ) : (
                        // Desktop only: it keeps an empty column reading as a column. Stacked on a phone there
                        // is no column to hold together, and a lone dash in its own block is just litter.
                        <span className="hidden py-2 text-muted-foreground/60 sm:inline">—</span>
                      )}
                    </td>
                    <td data-label="When" className="whitespace-nowrap py-2 text-xs text-muted-foreground sm:text-right" title={title}>{timeAgo(a.create_time)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
      {/* Every entry one act wrote, as a feed of its own. The nested feed fetches by ?correlation, so it shows
          the act WHOLE - including the entries on records this dialog was not opened from. */}
      <Dialog open={!!act} onOpenChange={(o) => !o && setAct(null)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Everything this action changed</DialogTitle>
            <DialogDescription>Every record written by the same request or scheduled run.</DialogDescription>
          </DialogHeader>
          {act && <ActivityFeed global correlation={act} />}
        </DialogContent>
      </Dialog>
      {/* Every act of one login. The question an incident review opens with, which a per-request trace cannot
          answer: what else did this person do while signed in? */}
      <Dialog open={!!sitting} onOpenChange={(o) => !o && setSitting(null)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>The rest of this sitting</DialogTitle>
            <DialogDescription>Everything this person did while signed in on this session.</DialogDescription>
          </DialogHeader>
          {sitting && <ActivityFeed global session={sitting} />}
        </DialogContent>
      </Dialog>
      {/* One long-running story, assembled from the records that make it up (services/activityCase.ts). */}
      <Dialog open={!!story} onOpenChange={(o) => !o && setStory(null)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>The whole story</DialogTitle>
            <DialogDescription>Every record that makes up this case, from first to last.</DialogDescription>
          </DialogHeader>
          {story && <ActivityFeed global caseRoot={story} />}
        </DialogContent>
      </Dialog>
      {/* One entry, entire. The title says what happened; the body is the before/after table. */}
      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent
          className="sm:max-w-2xl"
          scrollBody
          // Arrow keys walk the log. Radix traps focus inside the panel, so a keydown anywhere in it bubbles
          // here - no window listener to register and tear down, and no stale closure over `visible`.
          // preventDefault stops the browser scrolling the raw-entry block sideways instead.
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            const el = e.target as HTMLElement | null;
            // A text field owns its own arrow keys (there is none here today; the guard is so adding one
            // later does not silently break typing in it).
            if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
            e.preventDefault();
            stepDetail(e.key === "ArrowLeft" ? -1 : 1);
          }}
        >
          <DialogHeader>
            <DialogTitle>{detail ? `${nameOf(detail)} ${actionLabel(detail.action)}` : "Activity"}</DialogTitle>
            {detail && <DialogDescription>{targetLabel(detail) ?? "This record"} · {timeAgo(detail.create_time)}</DialogDescription>}
          </DialogHeader>
          <DialogBody>
            {detail && <ActivityDetail row={detail} who={nameOf(detail)} record={targetLabel(detail)} extras={inline(detail)} fmt={fmt} onShowAct={(id) => { setDetail(null); setAct(id); }} onShowSession={(id) => { setDetail(null); setSitting(id); }} onShowCase={(rootRef) => { setDetail(null); setStory(rootRef); }} />}
          </DialogBody>
          <DialogFooter className="sm:items-center sm:justify-between">
            <span className="text-xs text-muted-foreground">{detailIdx >= 0 ? `${detailIdx + 1} of ${visible.length}` : "No longer in this view"}</span>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={detailIdx <= 0} onClick={() => stepDetail(-1)} title="Newer entry (←)">
                <ChevronLeft className="h-4 w-4" /> Newer
              </Button>
              <Button variant="outline" size="sm" disabled={detailIdx < 0 || detailIdx >= visible.length - 1} onClick={() => stepDetail(1)} title="Older entry (→)">
                Older <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
