import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ScanLine, ArrowLeft, Flag, Play, Trash2, ShieldCheck, CircleSlash, Clock, CheckCircle2, AlertTriangle, ExternalLink, TrendingDown, TrendingUp } from "lucide-react";
import { get, invoke, remove } from "@/api";
import { navigate, useRoute } from "@/router";
import { useCollection, useCollectionHasMore } from "@/hooks/useCollection";
import { TruncationNotice } from "@/components/common/TruncationNotice";
import { cn, formatDate, idOf } from "@/lib/utils";
import type { Asset, AssetCategory, Employee, Me, Stocktake, StocktakeMissing, StocktakeSighted } from "@/types";
import type { AssetTagSettings } from "@/lib/assetTags";
import { ASSET_STATUS_LABEL } from "@/lib/assetTags";
import { confidenceBand, daysSince, inScopeWire, inventoryConfidence, presetOf, reconcileMissing, sightedIn, type ConfidenceBand } from "@/lib/stocktake";
import { PageHeader } from "@/components/common/PageHeader";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { DataState } from "@/components/common/DataState";
import { DataTable, type Column } from "@/components/common/DataTable";
import { FoldSection } from "@/components/common/FoldSection";
import { ActivitySection } from "@/components/common/ActivitySection";
import { PageSettings } from "@/components/common/SettingsButton";
import { AccessAction } from "@/components/access/AccessAction";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { exportTable } from "@/lib/exportTable";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";
import { getSetting } from "@/lib/settingsStore";

// Stocktakes: the RECORD half of the counting loop. The walk itself is the scanning modal on the Assets page
// (that is where the camera and the tag secrets are); this page is where counts are read afterwards, and where
// the one question a single count cannot answer gets answered.
//
// Two ideas carry the page:
//
//  1. INVENTORY CONFIDENCE. A count says what happened in one walk. What an org actually wants to know is how
//     much of its inventory can currently be PROVED, so the top of the page scores every asset against the
//     org's own staleness window (settings/asset-tags custody.verify_stale_days) rather than against the last
//     count's scope. That is the number that tells you whether it is time to walk again.
//  2. RECONCILIATION. A frozen missing list is the honest record of a walk, but left alone it ages into a list
//     of things that were probably found the next morning. Every missing row is therefore re-read against the
//     asset's CURRENT last sighting: turned up since, or still unaccounted for. Free - the assets are loaded.
//
// A count's own numbers stay exactly as they were signed off (result_json); reconciliation is shown alongside
// them, never folded into them.

const DEFAULT_STALE_DAYS = 180;

export default function Stocktakes({ me }: { me: Me }) {
  const route = useRoute();
  const { rows: counts, setRows: setCounts, state, error, reload } = useCollection<Stocktake>("stocktakes");
  // `all`, like the two reads below it and like Assets.tsx: every consumer here is in the "wrong rather than
  // merely short" class. The confidence score divides by the rows it was handed and is offered as how much of
  // the inventory can be PROVED; `reconcileMissing` treats an asset it cannot find in these rows as still
  // missing, which re-reports found kit as lost; and `progressOf` feeds the numbers on an irreversible close.
  const { rows: assets } = useCollection<Asset>("assets", { all: true });
  const assetsTruncated = useCollectionHasMore("assets");
  const { rows: employees } = useCollection<Employee>("employees", { all: true });
  const { rows: categories } = useCollection<AssetCategory>("asset-categories", { all: true });
  const [staleDays, setStaleDays] = useState(DEFAULT_STALE_DAYS);
  const { toast } = useToast();
  const confirm = useConfirm();

  // The org's own staleness window, so "stale" means what the org said it means. One read, on page open, and
  // the default stands if the blob is absent or unreadable.
  useEffect(() => {
    getSetting<AssetTagSettings>("asset-tags")
      .then((r) => setStaleDays(r.value?.custody?.verify_stale_days ?? DEFAULT_STALE_DAYS))
      .catch(() => setStaleDays(DEFAULT_STALE_DAYS));
  }, []);

  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (p?: string) => (p ? (m.get(idOf(p)) ?? "someone") : "someone");
  }, [employees]);
  const catName = useMemo(() => {
    const m = new Map(categories.map((c) => [c.path, c.display_name ?? ""]));
    return (p?: string) => (p ? (m.get(p) ?? "") : "");
  }, [categories]);

  const open = useMemo(() => counts.filter((c) => c.status === "open"), [counts]);
  const closed = useMemo(
    () => counts.filter((c) => c.status === "closed").sort((a, b) => (b.closed_time ?? "").localeCompare(a.closed_time ?? "")),
    [counts],
  );
  const selected = useMemo(() => (route.id ? counts.find((c) => idOf(c.path) === route.id) : undefined), [counts, route.id]);
  const confidence = useMemo(() => inventoryConfidence(assets, staleDays), [assets, staleDays]);
  // Which confidence band the reader asked to SEE. A percentage nobody can open is a number they have to take
  // on trust; the answer to "4% never sighted" is the list of those things, and it is already loaded.
  const [band, setBand] = useState<ConfidenceBand | null>(null);
  const banded = useMemo(
    () => (band ? assets.filter((a) => confidenceBand(a, staleDays) === band) : []),
    [assets, band, staleDays],
  );

  // Live progress for an OPEN count, from the same rule the walk uses: somebody at a desk can follow a
  // colleague's walk without a second copy of anything.
  const progressOf = (c: Stocktake) => {
    const scope = assets.filter((a) => inScopeWire(c.scope, a));
    const seen = scope.filter((a) => sightedIn(c, a));
    return { total: scope.length, seen: seen.length, missing: scope.length - seen.length, scope };
  };

  async function closeCount(c: Stocktake) {
    // Refused while the inventory is only partly loaded: the server scores the close over every asset in the
    // stored scope, so the numbers below would be a claim about a quarter of the register and the "will be
    // notified to go and look" promise would be made about a count of zero while hundreds are chased.
    if (assetsTruncated) {
      toast({
        variant: "destructive",
        title: "Too many assets to close this count here",
        description: "Not every asset in scope could be loaded, so anything not listed would be frozen as missing. Narrow the count's scope and walk it again.",
      });
      return;
    }
    const p = progressOf(c);
    const held = p.scope.filter((a) => !sightedIn(c, a) && a.assigned_to).length;
    const ok = await confirm({
      title: `Close "${c.label}"?`,
      description:
        `${p.seen} of ${p.total} sighted, ${p.missing} missing. The result is frozen as it stands now and cannot be reopened` +
        (held ? `, and the ${held} missing item${held === 1 ? "" : "s"} that someone is holding will be notified to go and look.` : "."),
      confirmLabel: "Close count",
    });
    if (!ok) return;
    try {
      const updated = await invoke<Stocktake>(c.path, "close");
      setCounts((prev) => prev.map((r) => (r.path === updated.path ? updated : r)));
      toast({ title: `Count closed: ${updated.result?.counts?.missing ?? 0} missing`, variant: "success" });
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't close the count", description: (e as Error).message });
    }
  }

  // Abandoning is for a count started by mistake. A count with sightings in it is history, so the ask says so.
  async function abandon(c: Stocktake) {
    const p = progressOf(c);
    const ok = await confirm({
      title: `Abandon "${c.label}"?`,
      description: p.seen
        ? `${p.seen} sighting${p.seen === 1 ? "" : "s"} stay on the assets themselves (they were real), but this count produces no report. Close it instead if you want the numbers.`
        : "Nothing has been sighted in it, so nothing is lost.",
      destructive: true,
      confirmLabel: "Abandon",
    });
    if (!ok) return;
    try {
      await remove(c.path, c.etag);
      setCounts((prev) => prev.filter((r) => r.path !== c.path));
      if (selected?.path === c.path) navigate("stocktakes");
      toast({ title: "Count abandoned", variant: "success" });
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't abandon the count", description: (e as Error).message });
    }
  }

  const startBtn = (
    <div className="flex gap-2">
      <AccessAction collection="stocktakes" create label="Start a count">
        {/* The walk needs the camera and the tag secrets, which live on the Assets page: send them there with
            the modal already open rather than building a second scanner here. */}
        <Button onClick={() => navigate("assets?stocktake=new")}><ScanLine className="h-4 w-4" /> Start a count</Button>
      </AccessAction>
      <PageSettings me={me} host="stocktakes" />
    </div>
  );

  if (selected) {
    return (
      <CountDetail
        count={selected}
        assets={assets}
        empName={empName}
        catName={catName}
        progressOf={progressOf}
        onBack={() => navigate("stocktakes")}
        onClose={() => closeCount(selected)}
        onAbandon={() => abandon(selected)}
      />
    );
  }

  const lastClosedCount = closed[0];
  const sinceLast = daysSince(lastClosedCount?.closed_time);

  const columns: Column<Stocktake>[] = [
    { id: "label", header: "Count", accessor: (r) => r.label ?? "", cell: (r) => (
      <div className="min-w-0">
        <div className="truncate font-medium">{r.label}</div>
        <div className="truncate text-xs text-muted-foreground">{presetOf(r.scope)}{r.scope?.categories?.length ? ` · ${catName(r.scope.categories[0])}` : ""}</div>
      </div>
    ) },
    { id: "closed", header: "Closed", filter: "date", dateHint: "past", accessor: (r) => r.closed_time ?? "", cell: (r) => (
      <div className="min-w-0">
        <div>{r.closed_time ? formatDate(r.closed_time.slice(0, 10)) : "-"}</div>
        <div className="truncate text-xs text-muted-foreground">by {empName(r.closed_by)}</div>
      </div>
    ) },
    { id: "sighted", header: "Sighted", align: "right", filter: "number", accessor: (r) => r.result?.counts?.sighted ?? 0, cell: (r) => (
      <span className="tabular-nums">{r.result?.counts?.sighted ?? 0} <span className="text-muted-foreground">/ {r.result?.counts?.scope_total ?? 0}</span></span>
    ) },
    // Proof quality, not just coverage: a count ticked off by hand and one scanned end to end are different
    // evidence, and the difference is worth seeing without opening the count.
    { id: "proof", header: "Scan-proved", align: "right", filter: "number", accessor: (r) => r.result?.counts?.scanned ?? 0, cell: (r) => {
      const k = r.result?.counts;
      if (!k?.sighted) return <span className="text-muted-foreground">-</span>;
      return <span className="tabular-nums">{Math.round(((k.scanned ?? 0) / k.sighted) * 100)}%</span>;
    } },
    { id: "missing", header: "Missing", align: "right", filter: "number", aggregate: "sum", accessor: (r) => r.result?.counts?.missing ?? 0, cell: (r) => (
      <span className={cn("tabular-nums", (r.result?.counts?.missing ?? 0) > 0 && "font-medium text-warning")}>{r.result?.counts?.missing ?? 0}</span>
    ) },
    // The reconciled column: of what this count could not find, how much is STILL unaccounted for today.
    { id: "still", header: "Still missing", align: "right", filter: "number", aggregate: "sum", accessor: (r) => reconcileMissing(r, assets).stillMissing, cell: (r) => {
      const rec = reconcileMissing(r, assets);
      if (!(r.result?.counts?.missing ?? 0)) return <span className="text-muted-foreground">-</span>;
      return (
        <span className="flex items-center justify-end gap-1.5 tabular-nums">
          <span className={cn(rec.stillMissing > 0 ? "font-medium text-destructive" : "text-success")}>{rec.stillMissing}</span>
          {rec.turnedUp > 0 && <span className="text-xs text-muted-foreground">({rec.turnedUp} turned up)</span>}
        </span>
      );
    } },
    { id: "flagged", header: "Flagged", align: "right", defaultHidden: true, filter: "number", aggregate: "sum", accessor: (r) => r.result?.counts?.flagged ?? 0 },
    { id: "found", header: "Unexpected", align: "right", defaultHidden: true, filter: "number", aggregate: "sum", accessor: (r) => r.result?.counts?.found ?? 0 },
    {
      id: "actions", header: "", sortable: false, filter: "none", align: "right",
      cell: (r) => <Button size="sm" variant="ghost" onClick={() => navigate(`stocktakes/${idOf(r.path)}`)}>Open</Button>,
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Stocktakes"
        description="Inventory counts and what they found. Each closed count keeps its own frozen result; the numbers above are the inventory as it stands today."
        accessCollection="stocktakes"
        actions={startBtn}
      />

      {/* Confidence first: this is the number that decides whether another walk is due, and no single count
          can express it. */}
      {/* Each number opens the assets behind it: "Gone stale" is only useful if you can see WHICH things went
          stale, and the inventory is already in memory, so the list costs nothing to show. */}
      {/* The residual case: the walk stops at ALL_CAP, and every number below is a claim about the WHOLE
          inventory. Said out loud rather than left to be read as a fact about the business. */}
      <TruncationNotice collection="assets" what="assets" className="mb-4" />
      <SummaryStrip
        items={[
          { label: `Sighted in ${staleDays}d`, value: `${confidence.freshPct}%`, icon: ShieldCheck, tone: confidence.freshPct >= 90 ? "success" : confidence.freshPct >= 60 ? "primary" : "warning", hint: `${confidence.fresh} of ${confidence.total}${assetsTruncated ? "+ loaded" : ""}`, onClick: () => setBand(band === "fresh" ? null : "fresh"), active: band === "fresh" },
          { label: "Scan-proved", value: `${confidence.proofPct}%`, icon: CheckCircle2, tone: confidence.proofPct >= 90 ? "success" : "muted", hint: "of those sightings", onClick: () => setBand(band === "proved" ? null : "proved"), active: band === "proved" },
          { label: "Gone stale", value: confidence.stale, icon: Clock, tone: confidence.stale > 0 ? "warning" : "muted", hint: `not seen in ${staleDays}d`, onClick: () => setBand(band === "stale" ? null : "stale"), active: band === "stale" },
          { label: "Never sighted", value: confidence.never, icon: CircleSlash, tone: confidence.never > 0 ? "destructive" : "muted", hint: "no scan on record", onClick: () => setBand(band === "never" ? null : "never"), active: band === "never" },
        ]}
      />

      {band && (
        <BandPanel
          band={band}
          rows={banded}
          staleDays={staleDays}
          empName={empName}
          onClose={() => setBand(null)}
        />
      )}

      {/* One sentence that turns those numbers into a decision. */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-4 py-3 text-sm">
        {open.length > 0 ? (
          <><Play className="h-4 w-4 text-primary" /><span>{open.length === 1 ? "A count is running now." : `${open.length} counts are running now.`} Sightings keep landing on the assets as people scan.</span></>
        ) : lastClosedCount ? (
          <>
            {(sinceLast ?? 0) > staleDays / 2 ? <AlertTriangle className="h-4 w-4 text-warning" /> : <CheckCircle2 className="h-4 w-4 text-success" />}
            <span>
              Last count <button className="underline decoration-dotted underline-offset-2" onClick={() => navigate(`stocktakes/${idOf(lastClosedCount.path)}`)}>{lastClosedCount.label}</button> closed {sinceLast === 0 ? "today" : `${sinceLast} days ago`}
              {(lastClosedCount.result?.counts?.missing ?? 0) > 0
                ? `, ${lastClosedCount.result!.counts!.missing} unfound at the time and ${reconcileMissing(lastClosedCount, assets).stillMissing} still unaccounted for.`
                : ", everything in its scope accounted for."}
              {(sinceLast ?? 0) > staleDays / 2 && " Time to walk again."}
            </span>
          </>
        ) : (
          <><ScanLine className="h-4 w-4 text-muted-foreground" /><span>Nothing has been counted yet. A count is a walk with a scanner: everything you sight gets stamped, and whatever is left over is the missing list.</span></>
        )}
      </div>

      {open.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Running now</div>
          {open.map((c) => {
            const p = progressOf(c);
            const pct = p.total ? Math.round((p.seen / p.total) * 100) : 0;
            return (
              <div key={c.path} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <button className="truncate text-sm font-medium hover:underline" onClick={() => navigate(`stocktakes/${idOf(c.path)}`)}>{c.label}</button>
                    <div className="truncate text-xs text-muted-foreground">{presetOf(c.scope)} · started {formatDate((c.start_time ?? "").slice(0, 10))} by {empName(c.started_by)}</div>
                  </div>
                  <div className="text-right text-sm tabular-nums">{p.seen} / {p.total}<span className="ml-1 text-xs text-muted-foreground">sighted</span></div>
                  <Button size="sm" variant="outline" onClick={() => navigate(`assets?stocktake=${idOf(c.path)}`)}><ScanLine className="h-4 w-4" /> Scan into it</Button>
                  <AccessAction collection="stocktakes" objectPath={c.path} can={c.access?.can} verb="close" label="Close count">
                    <Button size="sm" variant="ghost" onClick={() => closeCount(c)}><Flag className="h-4 w-4" /> Close</Button>
                  </AccessAction>
                  <AccessAction collection="stocktakes" objectPath={c.path} can={c.access?.can} label="Abandon count">
                    {/* Named, because it is an icon alone: the one destructive control in this row must not
                        be announced as "button" and nothing else. */}
                    <Button size="sm" variant="ghost" aria-label="Abandon count" title="Abandon this count" onClick={() => abandon(c)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                  </AccessAction>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <DataState state={state} error={error} onRetry={reload}>
        <DataTable
          tableId="stocktakes"
          columns={columns}
          rows={closed}
          getRowId={(r) => r.path}
          accessCollection="stocktakes"
          accessTargetOf={(r) => ({ collection: "stocktakes", objectPath: r.path, label: r.label ?? "count", can: r.access?.can })}
          emptyTitle="No count has been closed yet"
          emptyDescription="Closing a count freezes its numbers and its missing list, which is what makes it an audit record."
          emptyAction={startBtn}
        />
      </DataState>
    </div>
  );
}

// One count, deep-linked (`/stocktakes/<id>`), so a colleague can be sent straight to it.
function CountDetail({
  count,
  assets,
  empName,
  catName,
  progressOf,
  onBack,
  onClose,
  onAbandon,
}: {
  count: Stocktake;
  assets: Asset[];
  empName: (p?: string) => string;
  catName: (p?: string) => string;
  progressOf: (c: Stocktake) => { total: number; seen: number; missing: number; scope: Asset[] };
  onBack: () => void;
  onClose: () => void;
  onAbandon: () => void;
}) {
  const isOpen = count.status === "open";
  const live = progressOf(count);
  const k = count.result?.counts;
  const rec = useMemo(() => reconcileMissing(count, assets), [count, assets]);
  // An open count has no frozen list yet, so its "missing" is whatever has not been sighted so far: the same
  // question, answered live. Closed counts read from the snapshot, which is the record.
  const liveMissing = useMemo(() => live.scope.filter((a) => !sightedIn(count, a)), [live.scope, count]);

  // What the walk SAW - the other half of the count, and the half somebody usually wants to prove. While the
  // count runs it is the live list (the assets are already loaded); once closed it is the frozen snapshot,
  // because an asset's `last_stocktake` moves to whichever count sighted it most recently. A count closed
  // before that snapshot existed still shows something: the stamps that happen to remain on the assets, marked
  // as the partial evidence they are.
  const sighted = useMemo<{ rows: SightedView[]; reconstructed: boolean }>(() => {
    if (isOpen) return { rows: live.scope.filter((a) => sightedIn(count, a)).map(viewOfAsset), reconstructed: false };
    if (count.result?.sighted) return { rows: count.result.sighted.map(viewOfSnapshot), reconstructed: false };
    return { rows: assets.filter((a) => a.last_stocktake === count.path).map(viewOfAsset), reconstructed: true };
  }, [isOpen, live.scope, count, assets]);

  // The missing half, normalized the same way: live for a running count, the frozen snapshot (re-read against
  // today's sightings) once closed.
  const missing = useMemo<MissingView[]>(
    () => (isOpen ? liveMissing.map(missingViewOfAsset) : rec.rows.map(missingViewOfSnapshot)),
    [isOpen, liveMissing, rec.rows],
  );

  // ---- the numbers ARE the controls -------------------------------------------------------------------
  //
  // A metric somebody has to translate into a filter by hand is a metric they mostly don't use, so each tile
  // opens the list it counts, with the narrowing it implies: "Flagged" opens the sighted list showing only the
  // damaged ones, "Still missing" opens the missing list showing only what has not turned up. The tile that
  // holds the current view is marked, so the strip also says WHERE YOU ARE - which is why both lists fold: a
  // panel that cannot close cannot be "the one you opened".
  // The actionable list leads; the long one waits to be asked for unless it is short enough to just show.
  // One rule, used for the first render AND for landing on another count, so the two cannot disagree.
  const initialOpen = (): Record<PanelId, boolean> => ({ missing: true, sighted: sighted.rows.length > 0 && sighted.rows.length <= 12, found: true });
  const [open, setOpen] = useState<Record<PanelId, boolean>>(initialOpen);
  const [sightedFilter, setSightedFilter] = useState<SightedFilter>("all");
  const [missingFilter, setMissingFilter] = useState<MissingFilter>("all");
  const refs: Record<PanelId, RefObject<HTMLDivElement>> = {
    missing: useRef<HTMLDivElement>(null),
    sighted: useRef<HTMLDivElement>(null),
    found: useRef<HTMLDivElement>(null),
  };

  // Landing on another count starts clean: a narrowing chosen for the last one ("still missing only") silently
  // applied to this one would misreport it. Skipped on the first render, whose state the initializer above
  // already set - re-running it there would throw away the auto-opened short list.
  const shownCount = useRef(count.path);
  useEffect(() => {
    if (shownCount.current === count.path) return;
    shownCount.current = count.path;
    setSightedFilter("all");
    setMissingFilter("all");
    setOpen(initialOpen());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count.path]);

  function show(panel: PanelId, narrow?: { sighted?: SightedFilter; missing?: MissingFilter }) {
    setOpen((o) => ({ ...o, [panel]: true }));
    if (narrow?.sighted) setSightedFilter(narrow.sighted);
    if (narrow?.missing) setMissingFilter(narrow.missing);
    // After the panel has had the render that opens it, bring it into view - a tile at the top of a long page
    // that silently expands something below it looks like it did nothing.
    requestAnimationFrame(() => refs[panel].current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  }
  const showing = (panel: PanelId, filter?: SightedFilter | MissingFilter) =>
    open[panel] && (filter === undefined || (panel === "sighted" ? sightedFilter === filter : missingFilter === filter));

  function exportMissing() {
    const rows = isOpen
      ? liveMissing.map((a) => [a.asset_tag ?? "", a.name ?? "", ASSET_STATUS_LABEL[a.status] ?? a.status, a.assigned_to ? empName(a.assigned_to) : "", a.last_verified_time ? formatDate(a.last_verified_time.slice(0, 10)) : "never", "not sighted yet"])
      : rec.rows.map((r) => [r.row.asset_tag ?? "", r.row.name ?? "", ASSET_STATUS_LABEL[r.row.status ?? ""] ?? r.row.status ?? "", r.row.assigned_to ? empName(r.row.assigned_to) : "", r.row.last_verified_time ? formatDate(r.row.last_verified_time.slice(0, 10)) : "never", r.stillMissing ? "still missing" : `turned up ${formatDate((r.sightedAt ?? "").slice(0, 10))}`]);
    void exportTable(`stocktake-${(count.label ?? "count").replace(/\W+/g, "-").toLowerCase()}`, ["Tag", "Name", "Status at count", "Held by", "Last verified", "Since"], rows, "csv", "stocktakes");
  }

  // The sighted list is the half an auditor asks for, so it exports too - with the proof column, which is the
  // only thing in it they cannot get from the inventory itself.
  function exportSighted() {
    const rows = sighted.rows.map((r) => [
      r.tag ?? "",
      r.name,
      ASSET_STATUS_LABEL[r.status ?? ""] ?? r.status ?? "",
      r.holder ? empName(r.holder) : "",
      r.at ? formatDate(r.at.slice(0, 10)) : "",
      r.by ? empName(r.by) : "",
      r.scanned ? "scanned" : "by hand",
      r.condition ?? "",
    ]);
    void exportTable(`stocktake-${(count.label ?? "count").replace(/\W+/g, "-").toLowerCase()}-sighted`, ["Tag", "Name", "Status", "Held by", "Sighted", "By", "Proof", "Condition"], rows, "csv", "stocktakes");
  }

  return (
    <div className="space-y-4">
      <button className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground" onClick={onBack}>
        <ArrowLeft className="h-4 w-4" /> All counts
      </button>
      <PageHeader
        eyebrow={isOpen ? "Running now" : "Closed count"}
        title={count.label ?? "Count"}
        description={`${presetOf(count.scope)}${count.scope?.categories?.length ? ` · ${catName(count.scope.categories[0])}` : ""}. Started ${formatDate((count.start_time ?? "").slice(0, 10))} by ${empName(count.started_by)}${count.closed_time ? `, closed ${formatDate(count.closed_time.slice(0, 10))} by ${empName(count.closed_by)}` : ""}.`}
        accessCollection="stocktakes"
        actions={
          // Four labelled buttons ("Export not-seen", "Export sighted", "Scan into it", "Close count")
          // are ~470px of nowrap text between them - they have to be allowed to stack on a phone.
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={exportMissing}>{isOpen ? "Export not-seen" : "Export missing"}</Button>
            {sighted.rows.length > 0 && <Button variant="outline" onClick={exportSighted}>Export sighted</Button>}
            {isOpen && (
              <>
                <Button variant="outline" onClick={() => navigate(`assets?stocktake=${idOf(count.path)}`)}><ScanLine className="h-4 w-4" /> Scan into it</Button>
                <AccessAction collection="stocktakes" objectPath={count.path} can={count.access?.can} verb="close" label="Close count">
                  <Button onClick={onClose}><Flag className="h-4 w-4" /> Close count</Button>
                </AccessAction>
                <AccessAction collection="stocktakes" objectPath={count.path} can={count.access?.can} label="Abandon count">
                  <Button variant="ghost" onClick={onAbandon}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                </AccessAction>
              </>
            )}
          </div>
        }
      />

      <SummaryStrip
        items={
          isOpen
            ? [
                // "In scope" is the total the others are parts of, so there is no list it could open.
                { label: "In scope", value: live.total, tone: "muted" },
                { label: "Sighted so far", value: live.seen, tone: "primary", onClick: () => show("sighted", { sighted: "all" }), active: showing("sighted", "all") },
                { label: "Not seen yet", value: live.missing, tone: live.missing > 0 ? "warning" : "success", onClick: () => show("missing", { missing: "all" }), active: showing("missing", "all") },
                { label: "Unexpected finds", value: count.found?.length ?? 0, tone: (count.found?.length ?? 0) > 0 ? "warning" : "muted", ...(count.found?.length ? { onClick: () => show("found"), active: showing("found") } : {}) },
              ]
            : [
                { label: "In scope", value: k?.scope_total ?? 0, tone: "muted" },
                { label: "Sighted", value: k?.sighted ?? 0, tone: "primary", hint: `${k?.scanned ?? 0} scanned`, onClick: () => show("sighted", { sighted: "all" }), active: showing("sighted", "all") },
                { label: "Missing at the time", value: k?.missing ?? 0, tone: (k?.missing ?? 0) > 0 ? "warning" : "success", onClick: () => show("missing", { missing: "all" }), active: showing("missing", "all") },
                // The reconciled number is the one somebody has to act on today, so it opens the same list
                // narrowed to exactly that: what has still not turned up.
                { label: "Still missing", value: rec.stillMissing, icon: rec.turnedUp > 0 ? TrendingDown : TrendingUp, tone: rec.stillMissing > 0 ? "destructive" : "success", hint: rec.turnedUp > 0 ? `${rec.turnedUp} turned up` : "still unaccounted", onClick: () => show("missing", { missing: "still" }), active: showing("missing", "still") },
                { label: "Flagged", value: k?.flagged ?? 0, tone: (k?.flagged ?? 0) > 0 ? "warning" : "muted", hint: "damaged or partial", onClick: () => show("sighted", { sighted: "flagged" }), active: showing("sighted", "flagged") },
                { label: "Unexpected finds", value: k?.found ?? 0, tone: (k?.found ?? 0) > 0 ? "warning" : "muted", ...(k?.found ? { onClick: () => show("found"), active: showing("found") } : {}) },
              ]
        }
      />

      {count.notes && <p className="rounded-lg border bg-muted/30 px-4 py-3 text-sm">{count.notes}</p>}

      {/* What it could not find - the actionable half, so it leads and starts open. Foldable all the same: the
          KPI strip above marks whichever list you opened, and a panel that cannot close cannot be that. */}
      <MissingPanel
        anchorRef={refs.missing}
        rows={missing}
        empName={empName}
        isOpen={isOpen}
        filter={missingFilter}
        onFilter={setMissingFilter}
        open={open.missing}
        onOpenChange={(v: boolean) => setOpen((o) => ({ ...o, missing: v }))}
        truncated={count.result?.missing_truncated ?? 0}
        turnedUp={rec.turnedUp}
      />

      {/* The sighted half. It is normally the longest list on the page, so it stays folded until asked for -
          but it is what answers "prove you saw these", so it is never absent. */}
      <SightedPanel
        anchorRef={refs.sighted}
        rows={sighted.rows}
        empName={empName}
        reconstructed={sighted.reconstructed}
        truncated={count.result?.sighted_truncated ?? 0}
        isOpen={isOpen}
        filter={sightedFilter}
        onFilter={setSightedFilter}
        open={open.sighted}
        onOpenChange={(v: boolean) => setOpen((o) => ({ ...o, sighted: v }))}
      />

      {(count.found?.length ?? 0) > 0 && (
        <div className="rounded-lg border" ref={refs.found}>
          <div className="border-b px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Found, not in the inventory ({count.found!.length})</div>
          <div className="divide-y">
            {count.found!.map((f, i) => (
              <div key={`${f.scan_time}-${i}`} className="flex items-center gap-3 px-4 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{f.raw || f.note}</span>
                <span className="flex-shrink-0 text-xs text-muted-foreground">{empName(f.by)} · {formatDate((f.scan_time ?? "").slice(0, 10))}</span>
              </div>
            ))}
          </div>
          <p className="border-t px-4 py-2 text-xs text-muted-foreground">Scans that matched no asset. Each one is either kit nobody recorded or a tag from somewhere else.</p>
        </div>
      )}

      {/* Who did what to this count, straight from the audit trail. */}
      <ActivitySection resource={count.path} className="rounded-lg border p-4" />
    </div>
  );
}

// The assets behind one confidence number.
//
// The strip above is the page's answer to "should we walk again"; this is its answer to "walk after WHAT". It
// is the same classifier that produced the number (lib/stocktake#confidenceBand), so the list can never be a
// different size than the tile that opened it - and the rows carry the two things a walk needs: where the thing
// is meant to be, and how long it has been since anybody saw it.
const BAND_COPY: Record<ConfidenceBand, { title: string; blurb: string }> = {
  proved: { title: "Scan-proved recently", blurb: "Someone stood next to each of these and scanned its tag." },
  fresh: { title: "Sighted recently, not scanned", blurb: "Confirmed by hand inside the window - somebody's word rather than evidence." },
  stale: { title: "Gone stale", blurb: "Last sighted outside the org's window. These are what a walk is for." },
  never: { title: "Never sighted", blurb: "No scan on record at all: nobody has confirmed these exist since they were entered." },
  retired: { title: "Retired", blurb: "Out of the inventory on purpose." },
};

function BandPanel({ band, rows, staleDays, empName, onClose }: {
  band: ConfidenceBand;
  rows: Asset[];
  staleDays: number;
  empName: (p?: string) => string;
  onClose: () => void;
}) {
  const [shown, setShown] = useState(PAGE);
  const copy = BAND_COPY[band];
  // Oldest sighting first: the top of this list is the front of the queue for the next walk.
  const ordered = useMemo(
    () => [...rows].sort((a, b) => (a.last_verified_time ?? "").localeCompare(b.last_verified_time ?? "")),
    [rows],
  );
  return (
    <div className="space-y-2 rounded-lg border p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm font-medium">{copy.title} ({rows.length})</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{copy.blurb}</span>
        <Button size="sm" variant="ghost" className="h-7" onClick={onClose}>Hide</Button>
      </div>
      {rows.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">Nothing in this band. 🎉</p>
      ) : (
        <ListBody count={ordered.length} shown={shown} onMore={() => setShown((n) => n + PAGE)}>
          {ordered.slice(0, shown).map((a) => {
            const days = daysSince(a.last_verified_time);
            return (
              <div key={a.path} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
                <span className="w-32 flex-shrink-0 truncate font-mono text-xs">{a.asset_tag || "-"}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{a.name}</span>
                <span className="flex-shrink-0 text-xs text-muted-foreground">
                  {a.assigned_to ? `held by ${empName(a.assigned_to)}` : (ASSET_STATUS_LABEL[a.status ?? ""] ?? a.status)}
                </span>
                <span className="w-32 flex-shrink-0 text-right text-xs text-muted-foreground">
                  {days === null ? "never sighted" : days === 0 ? "seen today" : `seen ${days}d ago`}
                  {band === "stale" && days !== null && <span className="ml-1 opacity-70">(+{days - staleDays}d)</span>}
                </span>
                <button className="flex-shrink-0 text-muted-foreground hover:text-foreground" title="Open this asset" onClick={() => navigate(`assets/${idOf(a.path)}`)}>
                  <ExternalLink className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </ListBody>
      )}
    </div>
  );
}

// One sighted row, from either source: the asset as it stands (an open count) or the frozen snapshot (a closed
// one). Normalizing here is what lets the panel below not care which it is looking at.
type SightedView = {
  key: string;
  tag?: string | null;
  name: string;
  status?: string;
  holder?: string | null; // employees/<id>
  at?: string | null;
  by?: string | null; // employees/<id>
  scanned: boolean;
  condition?: string | null;
  assetId?: string;
};

const viewOfAsset = (a: Asset): SightedView => ({
  key: a.path,
  tag: a.asset_tag,
  name: a.name ?? "",
  status: a.status,
  holder: a.assigned_to,
  at: a.last_verified_time,
  by: a.last_verified_by,
  scanned: a.last_verified_scanned === true,
  condition: a.condition,
  assetId: idOf(a.path),
});

const viewOfSnapshot = (r: StocktakeSighted, i: number): SightedView => ({
  key: r.asset ?? `row-${i}`,
  tag: r.asset_tag,
  name: r.name ?? "",
  status: r.status,
  holder: r.assigned_to,
  at: r.sighted_time,
  by: r.sighted_by,
  scanned: r.scanned === true,
  condition: r.condition,
  assetId: r.asset ? idOf(r.asset) : undefined,
});

// One missing row, from either source: an asset that has not been sighted yet (a running count) or a frozen
// snapshot row re-read against today's sightings (a closed one).
type MissingView = {
  key: string;
  tag?: string | null;
  name: string;
  status?: string;
  holder?: string | null; // employees/<id>
  lastSeen?: string | null;
  assetId?: string;
  /** Closed counts only: null = still missing, a date = it turned up on that day. Undefined while running. */
  since?: string | null;
};

const missingViewOfAsset = (a: Asset): MissingView => ({
  key: a.path,
  tag: a.asset_tag,
  name: a.name ?? "",
  status: a.status,
  holder: a.assigned_to,
  lastSeen: a.last_verified_time,
  assetId: idOf(a.path),
});

const missingViewOfSnapshot = (r: { row: StocktakeMissing; stillMissing: boolean; sightedAt?: string | null }, i: number): MissingView => ({
  key: r.row.asset ?? `row-${i}`,
  tag: r.row.asset_tag,
  name: r.row.name ?? "",
  status: r.row.status,
  holder: r.row.assigned_to,
  lastSeen: r.row.last_verified_time,
  assetId: r.row.asset ? idOf(r.row.asset) : undefined,
  since: r.stillMissing ? null : (r.sightedAt ?? null),
});

/** Which panel a KPI tile opens, and how each one can be narrowed by the tile that opened it. */
type PanelId = "missing" | "sighted" | "found";
type SightedFilter = "all" | "hand" | "flagged";
type MissingFilter = "all" | "still";

const FLAGGED_CONDITIONS = ["damaged", "missing_parts"];
const PAGE = 100;

// The two long lists on this page have the same shape, so they behave the same way: a fold (whichever one you
// opened is the one the KPI strip marks), a text filter (finding one tag among four hundred rows should not be
// scrolling), and one meaningful narrowing each - driven either by its own button or by the tile above that
// counts it. Both page at 100 rows: a 500-row snapshot in one DOM burst is a jank nobody asked for.

// What the walk saw. Starts folded unless it is short: it is the longer list, and the one that needs acting on
// is what it could not find. The narrowing is "hand-ticked only" - an unscanned sighting is somebody's word
// rather than evidence, which is exactly the subset an audit re-reads.
function SightedPanel({ rows, empName, reconstructed, truncated, isOpen, filter, onFilter, open, onOpenChange, anchorRef }: {
  rows: SightedView[];
  empName: (p?: string) => string;
  reconstructed: boolean;
  truncated: number;
  isOpen: boolean;
  filter: SightedFilter;
  onFilter: (f: SightedFilter) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchorRef: RefObject<HTMLDivElement>;
}) {
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(PAGE);
  // A new filter (usually from a KPI tile) starts its own page 1 - "Flagged" landing on row 300 of the last
  // view would look like it found nothing.
  useEffect(() => setShown(PAGE), [filter, q]);

  const byHand = rows.filter((r) => !r.scanned).length;
  const flagged = rows.filter((r) => FLAGGED_CONDITIONS.includes(r.condition ?? "")).length;
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "hand" && r.scanned) return false;
      if (filter === "flagged" && !FLAGGED_CONDITIONS.includes(r.condition ?? "")) return false;
      if (!needle) return true;
      return `${r.tag ?? ""} ${r.name} ${empName(r.holder ?? undefined)}`.toLowerCase().includes(needle);
    });
  }, [rows, q, filter, empName]);

  return (
    <div className="rounded-lg border p-4" ref={anchorRef}>
      <FoldSection
        title={isOpen ? `Sighted so far (${rows.length})` : `Sighted (${rows.length})`}
        summary={rows.length === 0 ? "nothing yet" : byHand > 0 ? `${rows.length - byHand} scanned, ${byHand} by hand` : "all scan-proved"}
        open={open}
        onOpenChange={onOpenChange}
      >
        <div className="space-y-2 pt-1">
          {rows.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {isOpen ? "Nothing scanned into this count yet." : "No sighting is recorded against this count."}
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by tag, name or holder…" className="h-8 max-w-xs" />
                {byHand > 0 && (
                  <FilterChip on={filter === "hand"} onClick={() => onFilter(filter === "hand" ? "all" : "hand")}>Hand-ticked only ({byHand})</FilterChip>
                )}
                {flagged > 0 && (
                  <FilterChip on={filter === "flagged"} onClick={() => onFilter(filter === "flagged" ? "all" : "flagged")}>Flagged only ({flagged})</FilterChip>
                )}
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">{filtered.length} shown</span>
              </div>
              <ListBody count={filtered.length} shown={shown} onMore={() => setShown((n) => n + PAGE)}>
                {filtered.slice(0, shown).map((r) => (
                  <SightedLine key={r.key} row={r} holderName={r.holder ? empName(r.holder) : null} byName={r.by ? empName(r.by) : null} />
                ))}
              </ListBody>
            </>
          )}
          {truncated > 0 && (
            <p className="text-xs text-muted-foreground">…and {truncated} more not stored: the snapshot is capped, so this list is partial by design.</p>
          )}
          {reconstructed && (
            <p className="text-xs text-muted-foreground">
              This count closed before its sighted list was frozen, so this is rebuilt from the stamps still on the
              assets - anything re-sighted by a later count is missing from it.
            </p>
          )}
        </div>
      </FoldSection>
    </div>
  );
}

// What it could not find. Starts open - it is the list somebody has to do something about - and its narrowing
// is the reconciled one: of what this count missed, what is STILL unaccounted for today.
function MissingPanel({ rows, empName, isOpen, filter, onFilter, open, onOpenChange, truncated, turnedUp, anchorRef }: {
  rows: MissingView[];
  empName: (p?: string) => string;
  isOpen: boolean;
  filter: MissingFilter;
  onFilter: (f: MissingFilter) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  truncated: number;
  turnedUp: number;
  anchorRef: RefObject<HTMLDivElement>;
}) {
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(PAGE);
  useEffect(() => setShown(PAGE), [filter, q]);

  const still = rows.filter((r) => r.since === null).length;
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "still" && r.since !== null) return false;
      if (!needle) return true;
      return `${r.tag ?? ""} ${r.name} ${empName(r.holder ?? undefined)}`.toLowerCase().includes(needle);
    });
  }, [rows, q, filter, empName]);

  return (
    <div className="rounded-lg border p-4" ref={anchorRef}>
      <FoldSection
        title={isOpen ? `Not sighted yet (${rows.length})` : `Missing when it closed (${rows.length})`}
        summary={rows.length === 0 ? "all accounted for" : isOpen ? "still to find" : turnedUp > 0 ? `${still} still missing, ${turnedUp} turned up since` : "none have turned up since"}
        open={open}
        onOpenChange={onOpenChange}
      >
        <div className="space-y-2 pt-1">
          {rows.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">Everything in scope was accounted for. 🎉</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by tag, name or holder…" className="h-8 max-w-xs" />
                {!isOpen && turnedUp > 0 && (
                  <FilterChip on={filter === "still"} onClick={() => onFilter(filter === "still" ? "all" : "still")}>Still missing only ({still})</FilterChip>
                )}
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">{filtered.length} shown</span>
              </div>
              <ListBody count={filtered.length} shown={shown} onMore={() => setShown((n) => n + PAGE)}>
                {filtered.slice(0, shown).map((r) => (
                  <MissingLine
                    key={r.key}
                    tag={r.tag}
                    name={r.name}
                    status={r.status}
                    holder={r.holder ? empName(r.holder) : null}
                    lastSeen={r.lastSeen}
                    assetId={r.assetId}
                    since={r.since}
                  />
                ))}
              </ListBody>
            </>
          )}
          {truncated > 0 && (
            <p className="text-xs text-muted-foreground">…and {truncated} more not stored: the snapshot is capped, so this list is partial by design.</p>
          )}
        </div>
      </FoldSection>
    </div>
  );
}

// A filter that is also a readout: pressed means the list below is narrowed to it, which is the same state the
// KPI tile above shows. One component so the two panels cannot drift into looking like different controls.
function FilterChip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button size="sm" variant={on ? "secondary" : "outline"} className="h-8" aria-pressed={on} onClick={onClick}>
      {children}
    </Button>
  );
}

// The bordered list plus the two things every paged list needs to say: that a filter matched nothing, and that
// there is more below.
function ListBody({ count, shown, onMore, children }: { count: number; shown: number; onMore: () => void; children: React.ReactNode }) {
  return (
    <>
      <div className="divide-y rounded-lg border">
        {children}
        {count === 0 && <p className="px-4 py-6 text-center text-sm text-muted-foreground">Nothing matches that.</p>}
      </div>
      {count > shown && (
        <Button variant="outline" size="sm" className="w-full" onClick={onMore}>
          Show {Math.min(PAGE, count - shown)} more
        </Button>
      )}
    </>
  );
}

// One sighted row. The proof chip is the point: a scan means somebody stood next to the thing, a hand-tick
// means somebody said so, and a condition worth flagging outranks both.
function SightedLine({ row, holderName, byName }: { row: SightedView; holderName: string | null; byName: string | null }) {
  const days = daysSince(row.at);
  const flagged = FLAGGED_CONDITIONS.includes(row.condition ?? "");
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
      <span className="w-32 flex-shrink-0 truncate font-mono text-xs">{row.tag || "-"}</span>
      <span className="min-w-0 flex-1 truncate font-medium">{row.name}</span>
      <span className="flex-shrink-0 text-xs text-muted-foreground">{holderName ? `held by ${holderName}` : (ASSET_STATUS_LABEL[row.status ?? ""] ?? row.status)}</span>
      {flagged && (
        <span className="flex-shrink-0 rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">
          {row.condition === "damaged" ? "damaged" : "missing parts"}
        </span>
      )}
      <span
        className={cn(
          "flex-shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
          row.scanned ? "bg-success/10 text-success" : "bg-muted text-muted-foreground",
        )}
        title={row.scanned ? "Proved by a scan of its tag" : "Ticked off by hand - no scan"}
      >
        {row.scanned ? "scanned" : "by hand"}
      </span>
      <span className="w-40 flex-shrink-0 text-right text-xs text-muted-foreground">
        {row.at ? `${days === 0 ? "today" : `${days}d ago`}${byName ? ` · ${byName}` : ""}` : "-"}
      </span>
      {row.assetId && (
        <button className="flex-shrink-0 text-muted-foreground hover:text-foreground" title="Open this asset" onClick={() => navigate(`assets/${row.assetId}`)}>
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

// One row of a missing list. The "since" chip is what keeps an old count useful: it says whether the thing
// ever turned up, without touching the frozen numbers.
function MissingLine({
  tag,
  name,
  status,
  holder,
  lastSeen,
  assetId,
  since,
}: {
  tag?: string | null;
  name: string;
  status?: string;
  holder?: string | null;
  lastSeen?: string | null;
  assetId?: string;
  since?: string | null;
}) {
  const days = daysSince(lastSeen);
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
      <span className="w-32 flex-shrink-0 truncate font-mono text-xs">{tag || "-"}</span>
      <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
      <span className="flex-shrink-0 text-xs text-muted-foreground">{holder ? `held by ${holder}` : (ASSET_STATUS_LABEL[status ?? ""] ?? status)}</span>
      <span className="w-32 flex-shrink-0 text-right text-xs text-muted-foreground">{lastSeen ? `seen ${days}d ago` : "never sighted"}</span>
      {since === undefined ? null : since ? (
        <span className="flex-shrink-0 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">turned up {formatDate(since.slice(0, 10))}</span>
      ) : (
        <span className="flex-shrink-0 rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">still missing</span>
      )}
      {assetId && (
        <button className="flex-shrink-0 text-muted-foreground hover:text-foreground" title="Open this asset" onClick={() => navigate(`assets/${assetId}`)}>
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
