import * as React from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, ChevronsUpDown, Filter, X, SlidersHorizontal, GripVertical, ChevronLeft, ChevronRight, Download, FileSpreadsheet, FileText, Inbox, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { loadLocalPrefs, fetchServerPrefs, savePrefs } from "@/lib/tablePrefs";
import { useAccessMode, type AccessTargetRef } from "@/components/access/AccessModeProvider";
import { AccessTarget } from "@/components/access/AccessTarget";
import { AccessAction } from "@/components/access/AccessAction";
import { usePermission } from "@/lib/perm";
import { exportTable } from "@/lib/exportTable";
import { useCollectionHasMore } from "@/hooks/useCollection";

const PAGE_SIZES = [10, 25, 50, 100, 0]; // 0 = All

export type Column<T> = {
  id: string;
  header: string;
  /** Value used for sorting and filtering. */
  accessor?: (row: T) => string | number | boolean | null | undefined;
  /** Custom cell renderer; defaults to the accessor value. */
  cell?: (row: T) => React.ReactNode;
  sortable?: boolean; // default true when accessor present
  filter?: "text" | "select" | "none"; // default "text" when accessor present
  align?: "left" | "right" | "center";
  className?: string;
  headClassName?: string;
  defaultHidden?: boolean; // hidden until the user enables it in the column selector
  defaultFilter?: string; // seed an initial filter value (e.g. Status = "Active")
  hideValueByDefault?: string; // exclude rows with this accessor value unless filtered (e.g. "Deleted")
};

type SortState = { id: string; dir: "asc" | "desc" } | null;

// Reconcile a saved hidden-set with the current columns. Columns the saved prefs never
// knew about (not in savedOrder) fall back to their defaultHidden, so newly-added fields
// start unchecked even for users who already have saved layouts.
function computeHidden<T>(savedHidden: string[] | undefined, savedOrder: string[] | undefined, managed: Column<T>[]): Set<string> {
  if (!savedHidden && !savedOrder) {
    return new Set(managed.filter((c) => c.defaultHidden).map((c) => c.id));
  }
  const hidden = new Set(savedHidden ?? []);
  const known = new Set(savedOrder ?? []);
  for (const c of managed) if (c.defaultHidden && !known.has(c.id)) hidden.add(c.id);
  return hidden;
}

function compare(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

export function DataTable<T>({
  columns,
  rows,
  getRowId,
  onRowClick,
  rowClassName,
  toolbar,
  title,
  controlsSlot,
  tableId,
  emptyTitle = "No results",
  emptyDescription,
  accessCollection,
  accessTargetOf,
  getSubRows,
  hasMore,
  search,
}: {
  columns: Column<T>[];
  rows: T[];
  getRowId: (row: T) => string;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;
  toolbar?: React.ReactNode;
  // Optional section heading, rendered on the toolbar row (left) so it lines up with the toolbar buttons.
  title?: React.ReactNode;
  // When provided (a DOM node, or null until mounted), the table's controls (filter chips, `toolbar`, the
  // Columns button) are portaled into that node instead of rendered on their own row - so they can live in a
  // surrounding tab/toggle bar and not cost a vertical line. Passing the prop at all suppresses the own row.
  controlsSlot?: HTMLElement | null;
  tableId?: string;
  emptyTitle?: string;
  emptyDescription?: string;
  // Access-management mode: when set + the mode is on, each row gets a "manage access" affordance scoped to
  // the row's object. `accessTargetOf` supplies the per-row object path / label / can-hint.
  accessCollection?: string;
  accessTargetOf?: (row: T) => { collection?: string; objectPath?: string; label?: string; can?: string[] };
  // Expandable rows: return a row's children to make it foldable (a leading chevron toggles them). Rows with
  // no children render no chevron. Children ride with their parent - not independently sorted/filtered/paged.
  getSubRows?: (row: T) => T[] | undefined;
  // `rows` is only the first page of a larger collection. Normally left unset: it is derived automatically
  // from `accessCollection` (below), so a new page cannot forget it. Pass it explicitly only when the rows
  // come from a different collection than the one being access-managed.
  hasMore?: boolean;
  // Opt in to a server-side search box next to the column filters. The page owns the value and feeds it back
  // as `q` to useCollection, so the rows this table receives are already server-filtered across the whole
  // collection - the only way to reach a record beyond the first page.
  search?: { value: string; onChange: (v: string) => void; placeholder?: string };
}) {
  const am = useAccessMode();
  const autoHasMore = useCollectionHasMore(accessCollection);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const toggleExpand = React.useCallback((id: string) => {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const colById = React.useMemo(() => Object.fromEntries(columns.map((c) => [c.id, c])), [columns]);
  // Managed columns (with a header) can be reordered/hidden/resized; trailing
  // columns without a header (e.g. the actions menu) are pinned at the end.
  const managed = React.useMemo(() => columns.filter((c) => c.header !== ""), [columns]);
  const trailing = React.useMemo(() => columns.filter((c) => c.header === ""), [columns]);
  const managedIds = React.useMemo(() => managed.map((c) => c.id), [managed]);

  const initial = React.useRef(loadLocalPrefs(tableId));
  const [order, setOrder] = React.useState<string[]>(initial.current.order ?? managedIds);
  const [hidden, setHidden] = React.useState<Set<string>>(
    () => computeHidden(initial.current.hidden, initial.current.order, managed)
  );
  const [widths, setWidths] = React.useState<Record<string, number>>(initial.current.widths ?? {});
  const [pageSize, setPageSize] = React.useState<number>(initial.current.pageSize ?? 25);
  const [page, setPage] = React.useState(0);
  const [hydrated, setHydrated] = React.useState(false);

  // Pull this user's saved layout from the server (source of truth across devices). Fetch ONCE per tableId:
  // `managed` derives from the caller's `columns`, which is usually a fresh array each render, so depending
  // on it here would re-fetch on every re-render (e.g. as the page's data loads). We read the latest
  // `managed` through a ref instead of listing it as a dependency.
  const managedRef = React.useRef(managed);
  managedRef.current = managed;
  React.useEffect(() => {
    let active = true;
    fetchServerPrefs(tableId).then((sp) => {
      if (!active) return;
      if (sp) {
        if (sp.order) setOrder(sp.order);
        setHidden(computeHidden(sp.hidden, sp.order, managedRef.current));
        setWidths(sp.widths ?? {});
        if (typeof sp.pageSize === "number") setPageSize(sp.pageSize);
      }
      setHydrated(true);
    });
    return () => {
      active = false;
    };
  }, [tableId]);
  const [sort, setSort] = React.useState<SortState>(null);
  const [filters, setFilters] = React.useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const c of columns) if (c.defaultFilter) seed[c.id] = c.defaultFilter;
    return seed;
  });

  // Reconcile saved order with the current columns (append new, drop stale).
  const orderedManaged = React.useMemo(() => {
    const known = new Set(managedIds);
    const kept = order.filter((id) => known.has(id));
    const missing = managedIds.filter((id) => !kept.includes(id));
    return [...kept, ...missing];
  }, [order, managedIds]);

  const visibleColumns = React.useMemo(
    () => [...orderedManaged.filter((id) => !hidden.has(id)).map((id) => colById[id]), ...trailing],
    [orderedManaged, hidden, colById, trailing]
  );

  // The first real data column - child rows indent their content here so nesting reads under the parent.
  const firstDataColId = visibleColumns[0]?.id;

  // Leading columns (leftmost), in order: the fold chevron (when rows are expandable), then the "manage access"
  // icon (in access mode). Both lead rather than trail so a wide table's horizontal scroll never hides them.
  const renderCols = React.useMemo(() => {
    let cols = visibleColumns;
    if (am.enabled && accessCollection) {
      const accessCol: Column<T> = {
        id: "__access__",
        header: "",
        className: "w-px pr-0",
        headClassName: "w-px pr-0",
        cell: (row: T) => {
          // Scope provenance (access.why) rides along generically from the row's hint - no per-table wiring.
          const why = (row as { access?: { why?: AccessTargetRef["why"] } }).access?.why;
          return <AccessTarget target={{ collection: accessCollection, why, ...(accessTargetOf?.(row) ?? {}) }} />;
        },
      };
      cols = [accessCol, ...cols];
    }
    if (getSubRows) {
      const expandCol: Column<T> = {
        id: "__expand__",
        header: "",
        className: "w-px pr-0",
        headClassName: "w-px pr-0",
        cell: (row: T) => {
          const kids = getSubRows(row);
          if (!kids || kids.length === 0) return null;
          const open = expanded.has(getRowId(row));
          return (
            <button
              type="button"
              aria-label={open ? "Collapse" : "Expand"}
              onClick={(e) => { e.stopPropagation(); toggleExpand(getRowId(row)); }}
              className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ChevronRight className={cn("h-4 w-4 transition-transform", open && "rotate-90")} />
            </button>
          );
        },
      };
      cols = [expandCol, ...cols];
    }
    return cols;
  }, [visibleColumns, am.enabled, accessCollection, accessTargetOf, getSubRows, expanded, getRowId, toggleExpand]);

  // Persist layout changes - but ONLY genuine user edits, never the initial load. The first run after
  // hydration just records the loaded layout as a baseline (no save); subsequent runs save only when the
  // serialized prefs actually differ. Without this, flipping `hydrated` true would re-PATCH the prefs we
  // just GET'd on every page load.
  const savedBaseline = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!hydrated) return; // don't overwrite server prefs before we've loaded them
    const payload = { order: orderedManaged, hidden: [...hidden], widths, pageSize };
    const serialized = JSON.stringify(payload);
    if (savedBaseline.current === null) {
      savedBaseline.current = serialized; // first post-hydration run = the loaded layout; don't save it back
      return;
    }
    if (serialized === savedBaseline.current) return; // no real change
    savedBaseline.current = serialized;
    savePrefs(tableId, payload);
  }, [hydrated, tableId, orderedManaged, hidden, widths, pageSize]);

  const filtered = React.useMemo(() => {
    let out = rows;
    // Columns can hide a value by default (e.g. "Deleted") unless the user filters for it.
    for (const col of columns) {
      if (col.hideValueByDefault && col.accessor && !filters[col.id]) {
        out = out.filter((r) => String(col.accessor!(r) ?? "") !== col.hideValueByDefault);
      }
    }
    for (const [colId, value] of Object.entries(filters)) {
      if (!value) continue;
      const col = colById[colId];
      if (!col?.accessor) continue;
      const needle = value.toLowerCase();
      const isSelect = col.filter === "select";
      out = out.filter((r) => {
        const raw = col.accessor!(r);
        const hay = raw == null ? "" : String(raw);
        return isSelect ? hay === value : hay.toLowerCase().includes(needle);
      });
    }
    if (sort) {
      const col = colById[sort.id];
      if (col?.accessor) {
        const dir = sort.dir === "asc" ? 1 : -1;
        out = [...out].sort((a, b) => dir * compare(col.accessor!(a), col.accessor!(b)));
      }
    }
    return out;
  }, [rows, filters, sort, colById]);

  const anyFilter = Object.values(filters).some(Boolean);
  const total = filtered.length;
  // EVERYTHING below - filtering, sorting, paging, export - runs over `rows` alone. The server caps a list page
  // and nothing here follows the cursor, so on a large collection `rows` is a window and all of it is
  // partial. Derived from the store rather than passed per page, so this can't be forgotten on a new table;
  // the explicit prop wins when a table's rows come from elsewhere.
  const truncated = hasMore ?? autoHasMore;
  const pageCount = pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  const safePage = Math.min(page, pageCount - 1);
  React.useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [safePage, page]);
  // Back to the first page whenever the result set or page size changes.
  React.useEffect(() => {
    setPage(0);
  }, [filters, sort, pageSize]);
  const paged = pageSize > 0 ? filtered.slice(safePage * pageSize, safePage * pageSize + pageSize) : filtered;
  const from = total === 0 ? 0 : safePage * (pageSize || total) + 1;
  const to = pageSize > 0 ? Math.min(total, (safePage + 1) * pageSize) : total;

  function toggleSort(col: Column<T>) {
    if (col.sortable === false || !col.accessor) return;
    setSort((s) =>
      !s || s.id !== col.id ? { id: col.id, dir: "asc" } : s.dir === "asc" ? { id: col.id, dir: "desc" } : null
    );
  }

  function distinctValues(col: Column<T>): string[] {
    const set = new Set<string>();
    for (const r of rows) {
      const v = col.accessor?.(r);
      if (v != null && String(v) !== "") set.add(String(v));
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }

  // --- column reordering (drag a grip handle) ---
  const dragId = React.useRef<string | null>(null);
  function onDrop(targetId: string) {
    const from = dragId.current;
    dragId.current = null;
    if (!from || from === targetId) return;
    const next = orderedManaged.filter((id) => id !== from);
    const at = next.indexOf(targetId);
    next.splice(at, 0, from);
    setOrder(next);
  }

  // --- column resizing (drag the right edge) ---
  function startResize(e: React.PointerEvent, id: string) {
    e.preventDefault();
    e.stopPropagation();
    const th = (e.currentTarget as HTMLElement).closest("th") as HTMLElement | null;
    const startX = e.clientX;
    const startW = widths[id] ?? th?.offsetWidth ?? 160;
    const move = (ev: PointerEvent) => {
      const w = Math.max(72, startW + (ev.clientX - startX));
      setWidths((prev) => ({ ...prev, [id]: w }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  const widthStyle = (id: string): React.CSSProperties | undefined =>
    widths[id] ? { width: widths[id], minWidth: widths[id], maxWidth: widths[id] } : undefined;

  const activeFilters = Object.entries(filters).filter(([, v]) => v);
  const hideableCount = orderedManaged.length;
  const hiddenCount = orderedManaged.filter((id) => hidden.has(id)).length;

  // Server-side search box, shown ALONGSIDE the column filters rather than replacing them. The two do
  // different jobs and compose: this one asks the server for matching records across the WHOLE collection
  // (so it reaches rows past the first page, which a column filter cannot), and the column filters then
  // narrow whatever came back. Only rendered when the page wires it up.
  const searchControl = search && (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={search.value}
        onChange={(e) => search.onChange(e.target.value)}
        placeholder={search.placeholder ?? "Search all records…"}
        aria-label={search.placeholder ?? "Search all records"}
        className="h-9 w-52 pl-8 pr-7"
      />
      {search.value && (
        <button
          type="button"
          onClick={() => search.onChange("")}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );

  const chipsControl = (
    <>
      {activeFilters.map(([id, v]) => (
        <span key={id} className="inline-flex items-center gap-1 rounded-full bg-accent px-2.5 py-1 text-xs font-medium text-accent-foreground">
          {colById[id]?.header}: {v}
          <button onClick={() => setFilters((f) => ({ ...f, [id]: "" }))} className="hover:text-foreground"><X className="h-3 w-3" /></button>
        </span>
      ))}
      {activeFilters.length > 0 && (
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setFilters({})}>Clear filters</Button>
      )}
    </>
  );
  const columnsControl = (
    <TooltipProvider>
      <Popover>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button variant="outline" size="icon" className="relative h-9 w-9" aria-label="Columns">
                <SlidersHorizontal className="h-4 w-4" />
                {hiddenCount > 0 && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" />}
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>Columns{hiddenCount > 0 ? ` · ${hideableCount - hiddenCount}/${hideableCount} shown` : ""}</TooltipContent>
        </Tooltip>
        <PopoverContent align="end" className="w-56">
          <p className="mb-2 text-xs font-semibold text-muted-foreground">Toggle columns</p>
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {orderedManaged.map((id) => {
              const col = colById[id];
              if (!col) return null;
              const checked = !hidden.has(id);
              return (
                <label key={id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-accent">
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(v) =>
                      setHidden((prev) => {
                        const next = new Set(prev);
                        if (v === true) next.delete(id);
                        else next.add(id);
                        return next;
                      })
                    }
                  />
                  {col.header}
                </label>
              );
            })}
          </div>
          <Button variant="ghost" size="sm" className="mt-2 h-7 w-full text-xs" onClick={() => setHidden(new Set())}>Show all</Button>
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );

  // Cross-module export: the visible, accessor-bearing columns (skips the access/actions columns) of the
  // FILTERED rows (all of them, not just the current page). Gated by the `export` capability; the AccessAction
  // overlays the manage icon in access mode so admins control who may export.
  const canExport = usePermission("export.read");
  const exportCols = visibleColumns.filter((c) => c.accessor && c.header);
  function runExport(format: "csv" | "xlsx") {
    const headers = exportCols.map((c) => c.header);
    const data = filtered.map((r) => exportCols.map((c) => c.accessor!(r) ?? ""));
    void exportTable(tableId || accessCollection || "export", headers, data, format);
  }
  const exportControl = (canExport || am.enabled) && (
    <AccessAction collection="export" label="Data export">
      <TooltipProvider>
        <Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button variant="outline" size="icon" className="h-9 w-9" aria-label="Export" disabled={!canExport || exportCols.length === 0}>
                  <Download className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            {/* Export covers `filtered`, which is drawn from the loaded rows only - say so, or a truncated
                spreadsheet reads as a complete one. */}
            <TooltipContent>
              Export {filtered.length} row{filtered.length === 1 ? "" : "s"}
              {truncated ? " (only the records loaded on this page)" : ""}
            </TooltipContent>
          </Tooltip>
          <PopoverContent align="end" className="w-44 p-1">
            <button type="button" onClick={() => runExport("csv")} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"><FileText className="h-4 w-4 text-muted-foreground" /> CSV</button>
            <button type="button" onClick={() => runExport("xlsx")} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"><FileSpreadsheet className="h-4 w-4 text-muted-foreground" /> Excel (.xlsx)</button>
          </PopoverContent>
        </Popover>
      </TooltipProvider>
    </AccessAction>
  );

  return (
    <div className="space-y-3">
      {/* Controls: portaled into a parent bar (tabs/toggles) when a slot is given, else their own row. */}
      {controlsSlot !== undefined ? (
        controlsSlot ? createPortal(<div className="flex flex-wrap items-center justify-end gap-2">{searchControl}{chipsControl}{toolbar}{exportControl}{columnsControl}</div>, controlsSlot) : null
      ) : (
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {title && <h3 className="mr-1 text-lg font-semibold">{title}</h3>}
            {searchControl}
            {chipsControl}
          </div>
          <div className="flex items-center gap-2">
            {toolbar}
            {exportControl}
            {columnsControl}
          </div>
        </div>
      )}

      <Card className="overflow-hidden">
        <Table containerClassName="max-h-[68vh]">
          {/* Sticky, opaque header so column labels stay visible while scrolling a long list (the container
              above bounds the height; short tables never reach it, so they're unchanged). */}
          <TableHeader className="sticky top-0 z-10 bg-muted">
            <TableRow className="hover:bg-transparent">
              {renderCols.map((col) => {
                const reorderable = col.header !== "";
                const canSort = col.sortable !== false && !!col.accessor;
                const canFilter = col.filter !== "none" && !!col.accessor;
                const sorted = sort?.id === col.id ? sort.dir : null;
                const filterValue = filters[col.id] ?? "";
                return (
                  <TableHead
                    key={col.id}
                    style={widthStyle(col.id)}
                    onDragOver={reorderable ? (e) => e.preventDefault() : undefined}
                    onDrop={reorderable ? () => onDrop(col.id) : undefined}
                    className={cn(
                      "group/col relative",
                      col.align === "right" && "text-right",
                      col.align === "center" && "text-center",
                      col.headClassName
                    )}
                  >
                    <div
                      className={cn(
                        "flex items-center gap-1",
                        col.align === "right" && "justify-end",
                        col.align === "center" && "justify-center"
                      )}
                    >
                      {reorderable && (
                        <span
                          draggable
                          onDragStart={() => (dragId.current = col.id)}
                          className="-ml-1 cursor-grab text-muted-foreground/60 opacity-0 transition-opacity hover:text-foreground group-hover/col:opacity-100 active:cursor-grabbing"
                          title="Drag to reorder column"
                        >
                          <GripVertical className="h-3.5 w-3.5" />
                        </span>
                      )}
                      <button
                        type="button"
                        className={cn("inline-flex items-center gap-1", canSort && "hover:text-foreground")}
                        onClick={() => toggleSort(col)}
                        disabled={!canSort}
                      >
                        {col.header}
                        {canSort &&
                          (sorted === "asc" ? (
                            <ArrowUp className="h-3.5 w-3.5" />
                          ) : sorted === "desc" ? (
                            <ArrowDown className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronsUpDown className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover/col:opacity-40" />
                          ))}
                      </button>
                      {canFilter && (
                        <Popover>
                          <PopoverTrigger asChild>
                            <button
                              type="button"
                              className={cn(
                                "rounded p-0.5 transition-all hover:bg-accent",
                                filterValue
                                  ? "text-primary"
                                  : "text-muted-foreground/50 opacity-0 group-hover/col:opacity-100"
                              )}
                            >
                              <Filter className={cn("h-3.5 w-3.5", filterValue && "fill-primary/20")} />
                            </button>
                          </PopoverTrigger>
                          <PopoverContent align={col.align === "right" ? "end" : "start"}>
                            <div className="space-y-2">
                              <p className="text-xs font-semibold text-muted-foreground">Filter by {col.header}</p>
                              {col.filter === "select" ? (
                                <div className="max-h-56 space-y-0.5 overflow-y-auto">
                                  <FilterOption label="All" active={!filterValue} onClick={() => setFilters((f) => ({ ...f, [col.id]: "" }))} />
                                  {distinctValues(col).map((v) => (
                                    <FilterOption key={v} label={v} active={filterValue === v} onClick={() => setFilters((f) => ({ ...f, [col.id]: v }))} />
                                  ))}
                                </div>
                              ) : (
                                <div className="flex items-center gap-1.5">
                                  <Input
                                    autoFocus
                                    value={filterValue}
                                    placeholder={`Search ${col.header.toLowerCase()}`}
                                    onChange={(e) => setFilters((f) => ({ ...f, [col.id]: e.target.value }))}
                                    className="h-8"
                                  />
                                  {filterValue && (
                                    <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => setFilters((f) => ({ ...f, [col.id]: "" }))}>
                                      <X className="h-4 w-4" />
                                    </Button>
                                  )}
                                </div>
                              )}
                            </div>
                          </PopoverContent>
                        </Popover>
                      )}
                    </div>
                    {reorderable && (
                      <span
                        onPointerDown={(e) => startResize(e, col.id)}
                        title="Drag to resize column"
                        className="group/resize absolute -right-1.5 top-0 z-10 flex h-full w-3 cursor-col-resize touch-none select-none justify-center"
                      >
                        <span className="h-full w-px bg-border opacity-0 transition-all group-hover/col:opacity-100 group-hover/resize:w-0.5 group-hover/resize:bg-primary" />
                      </span>
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={renderCols.length} className="h-48 text-center">
                  <div className="flex flex-col items-center justify-center gap-3 py-6">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
                      <Inbox className="h-6 w-6" />
                    </div>
                    <div>
                      {/* With only the first page loaded, "no results" would be a lie: the match may sit in a
                          row that was never fetched. Say which set was actually searched. */}
                      <p className="text-sm font-medium text-foreground">
                        {truncated && anyFilter ? `No matches in the ${rows.length} loaded records` : emptyTitle}
                      </p>
                      {truncated && anyFilter ? (
                        <p className="mt-1 text-sm text-muted-foreground">
                          This page holds only the first {rows.length} records, and filters apply to those. The record you want may not be loaded — use search (⌘K) to look across everything.
                        </p>
                      ) : (
                        emptyDescription && <p className="mt-1 text-sm text-muted-foreground">{emptyDescription}</p>
                      )}
                    </div>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              paged.flatMap((row) => {
                const renderRow = (r: T, isChild: boolean) => (
                  <TableRow
                    key={getRowId(r)}
                    className={cn(
                      onRowClick && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      isChild && "bg-muted/30",
                      rowClassName?.(r),
                    )}
                    onClick={onRowClick ? () => onRowClick(r) : undefined}
                    // Make clickable rows operable from the keyboard: Tab to focus, Enter/Space to open, and
                    // ↑/↓ to move between rows. Guarded to e.target===currentTarget so keys typed inside a
                    // cell's own control (button, input, checkbox) aren't hijacked.
                    {...(onRowClick && {
                      tabIndex: 0,
                      role: "button",
                      onKeyDown: (e: React.KeyboardEvent<HTMLTableRowElement>) => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onRowClick(r);
                        } else if (e.key === "ArrowDown") {
                          e.preventDefault();
                          (e.currentTarget.nextElementSibling as HTMLElement | null)?.focus();
                        } else if (e.key === "ArrowUp") {
                          e.preventDefault();
                          (e.currentTarget.previousElementSibling as HTMLElement | null)?.focus();
                        }
                      },
                    })}
                  >
                    {renderCols.map((col) => (
                      <TableCell
                        key={col.id}
                        style={widthStyle(col.id)}
                        className={cn(
                          "truncate",
                          // Right-aligned columns are numeric by convention; tabular-nums keeps digits in
                          // vertical register down the column so values are scannable.
                          col.align === "right" && "text-right tabular-nums",
                          col.align === "center" && "text-center",
                          // Indent a child's first data column so it reads as nested under its parent.
                          isChild && col.id === firstDataColId && "pl-8",
                          col.className
                        )}
                      >
                        {col.cell ? col.cell(r) : String(col.accessor?.(r) ?? "")}
                      </TableCell>
                    ))}
                  </TableRow>
                );
                const kids = getSubRows?.(row);
                const open = kids && kids.length > 0 && expanded.has(getRowId(row));
                return open ? [renderRow(row, false), ...kids!.map((k) => renderRow(k, true))] : [renderRow(row, false)];
              })
            )}
          </TableBody>
        </Table>
      </Card>
      <div className="flex flex-wrap items-center justify-between gap-3 px-1 text-xs text-muted-foreground">
        <span>
          {total === 0 ? "No records" : `Showing ${from}-${to} of ${truncated ? `${total}+` : total}`}
          {total !== rows.length ? ` (filtered from ${truncated ? `${rows.length}+` : rows.length})` : ""}
          {truncated ? " — first page only" : ""}
        </span>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span>Rows per page</span>
            <Select value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v))}>
              <SelectTrigger className="h-7 w-[72px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZES.map((s) => (
                  <SelectItem key={s} value={String(s)}>
                    {s === 0 ? "All" : s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {pageSize > 0 && (
            <div className="flex items-center gap-1">
              <span className="mr-1">
                Page {safePage + 1} of {pageCount}
              </span>
              <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage <= 0} onClick={() => setPage(safePage - 1)}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FilterOption({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "block w-full truncate rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
        active && "bg-accent font-medium text-accent-foreground"
      )}
    >
      {label}
    </button>
  );
}
