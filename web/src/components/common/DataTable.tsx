import * as React from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, Bookmark, Check, ChevronsUpDown, Filter, X, SlidersHorizontal, GripVertical, ChevronLeft, ChevronRight, Download, FileSpreadsheet, FileText, Inbox, Search, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { loadLocalPrefs, fetchServerPrefs, savePrefs, type SavedView } from "@/lib/tablePrefs";
import { useConfirm } from "@/components/common/confirm";
import { useAccessMode, type AccessTargetRef } from "@/components/access/AccessModeProvider";
import { AccessTarget } from "@/components/access/AccessTarget";
import { AccessAction } from "@/components/access/AccessAction";
import { usePermission } from "@/lib/perm";
import { exportTable } from "@/lib/exportTable";
import { useCollectionHasMore } from "@/hooks/useCollection";
import { syncLastHash } from "@/router";
import { useMedia } from "@/hooks/useMedia";

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
  // Extra select-filter values to offer even when no loaded row carries them. For a value whose rows are
  // FETCHED ON DEMAND ("Deleted"): the option has to exist before the fetch, or picking it is impossible and
  // the trash is unreachable. Paired with `onFilterChange` on the table, which is how the page learns to go
  // and get them.
  filterOptions?: string[];
  // Phone card layout: rank for inclusion (lower = more important; the best-ranked column becomes the card
  // title, the next three its metadata lines). Unranked columns keep their visible order after ranked ones,
  // except a Status column, which is pulled up to sit directly under the title (see `mobileLayout`).
  mobilePriority?: number;
  // Numeric column that carries a total: the table sums the accessor over every FILTERED row (all pages, not
  // just the one on screen) into a footer strip, and the bulk bar totals the selection. Money columns pass
  // `formatTotal` so the total reads in the same units as the cells - "what am I looking at, in total" is the
  // question a finance table gets asked most, and reaching for a spreadsheet to answer it is a page failing.
  aggregate?: "sum";
  formatTotal?: (n: number) => React.ReactNode;
};

type SortState = { id: string; dir: "asc" | "desc" } | null;

/** An action offered on the bulk bar when rows are selected. Passing any bulk actions to DataTable turns on
 *  row multi-select (leading checkbox column + header select-all over the filtered set). */
export type BulkAction<T> = {
  label: string;
  icon?: React.ReactNode;
  destructive?: boolean;
  /** Ask before running (rendered through the shared confirm dialog). */
  confirm?: { title: string; description?: string };
  /** Return a reason to disable the action for this selection, or null to allow it. */
  disabled?: (rows: T[]) => string | null;
  /** Runs with the selected rows. Selection clears only on success; throw to keep it for a retry. */
  run: (rows: T[]) => void | Promise<void>;
};

// --- Deep-linkable table state (sort + filters), carried in the hash query as one param per table ---------
// Encoded as t.<key>={"s":"col.dir","f":{col:value}}. `f` is present only when the filters differ from the
// columns' defaultFilter seed, so an untouched table adds nothing to the URL; an explicitly cleared default
// round-trips as {"f":{}}. Written with history.replaceState (no history entry per keystroke, and the
// unsaved-changes guard in router.ts ignores query-only changes).
type UrlTableState = { s?: string; f?: Record<string, string> };

function readUrlTableState(key: string | undefined): UrlTableState | null {
  if (!key) return null;
  try {
    const qs = window.location.hash.split("?")[1] ?? "";
    const raw = new URLSearchParams(qs).get(`t.${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as UrlTableState;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function parseUrlSort(s: string | undefined): SortState {
  if (!s) return null;
  const at = s.lastIndexOf(".");
  if (at <= 0) return null;
  const dir = s.slice(at + 1);
  return dir === "asc" || dir === "desc" ? { id: s.slice(0, at), dir } : null;
}

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
  emptyAction,
  accessCollection,
  onFilterChange,
  accessTargetOf,
  getSubRows,
  hasMore,
  search,
  bulkActions,
  onLoadMore,
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
  /** The page's create control, repeated in the zero state. A collection nobody has added to yet is the
   *  state every new tenant meets on every page, and describing the action there ("use Add delegation") while
   *  the button itself is a header away is a worse answer than putting the button in front of them. Suppressed
   *  automatically when a filter is what emptied the table - there the recovery is to clear the filter. */
  emptyAction?: React.ReactNode;
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
  // Bulk operations over selected rows. Presence enables multi-select; see BulkAction.
  bulkActions?: BulkAction<T>[];
  // Follow the server cursor and append the next page (useCollection's loadMore). When set and the rows are
  // truncated, the footer grows a "Load more" button - the way past the server's page cap without search.
  onLoadMore?: () => Promise<void> | void;
  // Told the CURRENT value of one column's filter whenever it changes. The one case that needs it: a filter
  // value whose rows are not loaded ("Deleted"), where the page has to go and fetch them. Everything else
  // filters the rows already in hand and the page never needs to know.
  onFilterChange?: (colId: string, value: string) => void;
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
  const [density, setDensity] = React.useState<"comfortable" | "compact">(initial.current.density ?? "comfortable");
  const [views, setViews] = React.useState<SavedView[]>(initial.current.views ?? []);
  const [pickedView, setPickedView] = React.useState<string | null>(null); // saved view the user last applied, by name
  const [page, setPage] = React.useState(0);
  const [hydrated, setHydrated] = React.useState(false);
  const savedBaseline = React.useRef<string | null>(null); // serialized layout we last loaded or saved
  const defaultApplied = React.useRef<string | null>(null); // tableId whose pinned default view we've applied

  // Pull this user's saved layout from the server (source of truth across devices). Fetch ONCE per tableId:
  // `managed` derives from the caller's `columns`, which is usually a fresh array each render, so depending
  // on it here would re-fetch on every re-render (e.g. as the page's data loads). We read the latest
  // `managed` through a ref instead of listing it as a dependency.
  const managedRef = React.useRef(managed);
  managedRef.current = managed;
  const loadedFor = React.useRef<string | undefined>(tableId);
  React.useEffect(() => {
    let active = true;
    // A tabbed page swaps tableId (e.g. "leaves-mine" -> "leaves-all"). Re-seed from that table's own
    // cached prefs so the previous tab's layout and saved views never bleed into this one.
    if (loadedFor.current !== tableId) {
      const local = loadLocalPrefs(tableId);
      setOrder(local.order ?? managedRef.current.map((c) => c.id));
      setHidden(computeHidden(local.hidden, local.order, managedRef.current));
      setWidths(local.widths ?? {});
      setPageSize(local.pageSize ?? 25);
      setDensity(local.density ?? "comfortable");
      setViews(local.views ?? []);
      setPickedView(null);
      setHydrated(false);
      savedBaseline.current = null;
      loadedFor.current = tableId;
    }
    void fetchServerPrefs(tableId).then((sp) => {
      if (!active) return;
      if (sp) {
        if (sp.order) setOrder(sp.order);
        setHidden(computeHidden(sp.hidden, sp.order, managedRef.current));
        setWidths(sp.widths ?? {});
        if (typeof sp.pageSize === "number") setPageSize(sp.pageSize);
        if (sp.density) setDensity(sp.density);
        if (sp.views) setViews(sp.views);
      }
      setHydrated(true);
    });
    return () => {
      active = false;
    };
  }, [tableId]);
  // The key this table's sort/filter state travels under in the URL. tableId wins (unique per table);
  // accessCollection is the fallback so most collection pages deep-link without extra wiring. Tables with
  // neither simply skip URL sync.
  const urlKey = tableId ?? accessCollection;
  const urlInitial = React.useRef(readUrlTableState(urlKey));
  const [sort, setSort] = React.useState<SortState>(() => parseUrlSort(urlInitial.current?.s));
  // The deep link is read again if the key ARRIVES after the first render.
  //
  // `urlKey` comes from props, and a page can render its table before they have settled - while permissions
  // load, while a tab decides which table it is. The read above then happened under a key that did not exist
  // yet, and a ref never looks again: the pasted link opened the default view, silently, and the more loaded
  // the machine the more likely that was. Applied only when the key first becomes known (or changes, which
  // is a tabbed page swapping tables), so it can never overwrite a sort the reader has since chosen.
  const urlAppliedFor = React.useRef<string | undefined>(urlKey);
  React.useEffect(() => {
    if (!urlKey || urlAppliedFor.current === urlKey) return;
    urlAppliedFor.current = urlKey;
    const carried = readUrlTableState(urlKey);
    if (!carried) return;
    setSort(parseUrlSort(carried.s));
    if (carried.f) setFilters(carried.f);
  }, [urlKey]);
  const onFilterChangeRef = React.useRef(onFilterChange);
  onFilterChangeRef.current = onFilterChange;
  const [filters, setFilters] = React.useState<Record<string, string>>(() => {
    // A URL-carried filter set replaces the defaults wholesale (an empty {} means "defaults cleared").
    if (urlInitial.current?.f) return urlInitial.current.f;
    const seed: Record<string, string> = {};
    for (const c of columns) if (c.defaultFilter) seed[c.id] = c.defaultFilter;
    return seed;
  });
  // Report each filter that CHANGED value. Seeded as empty so the first run also reports a filter restored
  // from the URL - a link to the trash has to fetch the trash, not land on an empty table.
  const reported = React.useRef<Record<string, string>>({});
  React.useEffect(() => {
    const prev = reported.current;
    reported.current = filters;
    if (!onFilterChangeRef.current) return;
    for (const id of new Set([...Object.keys(prev), ...Object.keys(filters)])) {
      if ((prev[id] ?? "") !== (filters[id] ?? "")) onFilterChangeRef.current(id, filters[id] ?? "");
    }
  }, [filters]);

  // Mirror sort + filters back into the hash query (debounced) so the current view is shareable and survives
  // navigation. Skipped entirely without a urlKey; the param is dropped when the state matches the defaults.
  React.useEffect(() => {
    if (!urlKey) return;
    const t = setTimeout(() => {
      const defaults: Record<string, string> = {};
      for (const c of columns) if (c.defaultFilter) defaults[c.id] = c.defaultFilter;
      const active = Object.fromEntries(Object.entries(filters).filter(([, v]) => v));
      const payload: UrlTableState = {};
      if (sort) payload.s = `${sort.id}.${sort.dir}`;
      if (JSON.stringify(active) !== JSON.stringify(defaults)) payload.f = active;
      const value = Object.keys(payload).length > 0 ? JSON.stringify(payload) : null;

      const raw = window.location.hash.replace(/^#\/?/, "");
      const [path, qs = ""] = raw.split("?");
      const params = new URLSearchParams(qs);
      if (params.get(`t.${urlKey}`) === value || (!params.has(`t.${urlKey}`) && value === null)) return;
      if (value === null) params.delete(`t.${urlKey}`);
      else params.set(`t.${urlKey}`, value);
      const q = params.toString();
      history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/${path}${q ? `?${q}` : ""}`);
      syncLastHash(); // no hashchange fires, so the guard has to be told what the address bar now says
    }, 250);
    return () => clearTimeout(t);
    // `columns` is usually a fresh array per render; reading defaults inside the debounce keeps it out of deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlKey, sort, filters]);

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
          // `.access-row-key` (index.css) makes the key hover-reveal on pointer devices: the column keeps its
          // width, but a 50-row table stops stamping 50 amber boxes down its left edge.
          return <AccessTarget target={{ collection: accessCollection, why, ...(accessTargetOf?.(row) ?? {}) }} className="access-row-key" />;
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
    // Selection checkboxes are the leftmost column; the cell itself renders in renderRow (it needs to know
    // child rows from parents - children ride with their parent and are not independently selectable).
    if (bulkActions) {
      cols = [{ id: "__select__", header: "", className: "w-px pr-0", headClassName: "w-px pr-0" } as Column<T>, ...cols];
    }
    return cols;
  }, [visibleColumns, am.enabled, accessCollection, accessTargetOf, getSubRows, expanded, getRowId, toggleExpand, bulkActions]);

  // Persist layout changes - but ONLY genuine user edits, never the initial load. The first run after
  // hydration just records the loaded layout as a baseline (no save); subsequent runs save only when the
  // serialized prefs actually differ. Without this, flipping `hydrated` true would re-PATCH the prefs we
  // just GET'd on every page load.
  React.useEffect(() => {
    if (!hydrated) return; // don't overwrite server prefs before we've loaded them
    const payload = { order: orderedManaged, hidden: [...hidden], widths, pageSize, density, views };
    const serialized = JSON.stringify(payload);
    if (savedBaseline.current === null) {
      savedBaseline.current = serialized; // first post-hydration run = the loaded layout; don't save it back
      return;
    }
    if (serialized === savedBaseline.current) return; // no real change
    savedBaseline.current = serialized;
    savePrefs(tableId, payload);
  }, [hydrated, tableId, orderedManaged, hidden, widths, pageSize, density, views]);

  // The filtering pass runs at a LOWER PRIORITY than the keystroke that caused it.
  //
  // A column filter is a text input, and every keystroke re-ran the memo below - a pass over every row per
  // active filter, plus a full re-sort - and then re-rendered a page of rows, all inside the same commit as
  // the input's own update. On a hundred-row table of formatted money and dates that is enough work per
  // character to make typing feel like it lags behind the keyboard.
  //
  // `useDeferredValue` splits the two: `filters` updates immediately, so the input stays exactly as
  // responsive as an uncontrolled one, while `deferredFilters` lags by a render and React can abandon a
  // half-finished pass when the next character arrives. What the reader sees during those few milliseconds is
  // the PREVIOUS result set, which is the right thing to show - it is what was on screen already.
  //
  // Only the filters are deferred. Sort is a click, not a stream of input, so deferring it would add latency
  // to a gesture that has none to hide. Everything that must react to the typed value at once - the filter
  // chips, the URL mirror, `onFilterChange`, the reset to page one - keeps reading `filters` directly.
  const deferredFilters = React.useDeferredValue(filters);

  const filtered = React.useMemo(() => {
    let out = rows;
    // Columns can hide a value by default (e.g. "Deleted") unless the user filters for it.
    for (const col of columns) {
      if (col.hideValueByDefault && col.accessor && !deferredFilters[col.id]) {
        out = out.filter((r) => String(col.accessor!(r) ?? "") !== col.hideValueByDefault);
      }
    }
    for (const [colId, value] of Object.entries(deferredFilters)) {
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
    // `columns` is read for `hideValueByDefault` but is not listed: it is usually a fresh array per render,
    // and `colById` is derived from it, so it already changes whenever the columns really do. Listing it would
    // re-filter and re-sort every row on every render of every table in the app.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- columns is covered by colById; see above
  }, [rows, deferredFilters, sort, colById]);

  // --- bulk selection (only when the caller passes bulkActions) --------------------------------------------
  const confirmDialog = useConfirm();
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = React.useState<string | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  // Selection tracks the FILTERED set: rows that filter out (or vanish on reload) silently drop out of it,
  // so a bulk action can never touch a row the user no longer sees.
  React.useEffect(() => {
    if (!bulkActions) return;
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(filtered.map(getRowId));
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, !!bulkActions]);
  const selectedRows = React.useMemo(
    () => (selected.size === 0 ? [] : filtered.filter((r) => selected.has(getRowId(r)))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered, selected]
  );
  const allSelected = filtered.length > 0 && selectedRows.length === filtered.length;
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(filtered.map(getRowId)));
  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  async function runBulk(action: BulkAction<T>) {
    if (action.confirm) {
      const ok = await confirmDialog({
        title: action.confirm.title,
        description: action.confirm.description,
        destructive: action.destructive,
        confirmLabel: action.label,
      });
      if (!ok) return;
    }
    setBulkBusy(action.label);
    try {
      await action.run(selectedRows);
      setSelected(new Set()); // success: the selection's job is done
    } catch {
      // the caller's run() surfaces its own error toast; keep the selection so the user can retry
    } finally {
      setBulkBusy(null);
    }
  }

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

  // --- totals ----------------------------------------------------------------------------------------------
  // Summed over the FILTERED rows, not the visible page: a total that changed when you turned the page would
  // answer a question nobody asked.
  const sumCols = React.useMemo(() => columns.filter((c) => c.aggregate === "sum"), [columns]);
  const sumOf = React.useCallback(
    (rs: T[], col: Column<T>) => rs.reduce((n, r) => n + (Number(col.accessor?.(r)) || 0), 0),
    [],
  );
  const fmtTotal = (col: Column<T>, n: number) => (col.formatTotal ? col.formatTotal(n) : String(n));
  const showTotals = sumCols.length > 0 && filtered.length > 0;

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
    for (const v of col.filterOptions ?? []) set.add(v);
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

  // --- phone card layout ------------------------------------------------------------------------------------
  // Below sm, a wide table degrades to horizontal-scroll hunting; render each row as a card instead: best-
  // ranked column as the title, the next three as labelled lines, trailing (header-less) columns as actions.
  const isPhone = useMedia("(max-width: 639px)");
  const mobileLayout = React.useMemo(() => {
    const dataCols = visibleColumns.filter((c) => c.header !== "");
    // Four of a dozen columns fit a card, and which four is a real editorial choice. A page states it with
    // `mobilePriority`; the default is column order, with one correction: the STATUS column is pulled to the
    // front of the metadata. Column order is written for a table, where status is read across the row and
    // its position hardly matters - but a card that shows a leave request's type and dates and not whether
    // it was approved has left out the only thing the reader opened the page for. Every list in this app
    // that has a state has it under a header called Status (or an id of `state`/`status`), so one rule here
    // beats thirty-three per-page rankings.
    const isStatus = (c: Column<T>) => /^(state|status)$/i.test(c.id) || /^status$/i.test(String(c.header));
    const rank = (c: Column<T>, i: number) => c.mobilePriority ?? (i === 0 ? 0 : isStatus(c) ? 1 : i + 1);
    const ranked = dataCols.map((c, i) => ({ c, r: rank(c, i), i })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.c);
    return { title: ranked[0], meta: ranked.slice(1, 4) };
  }, [visibleColumns]);

  // A row's own click only counts when the press STARTED on that row.
  //
  // A portalled layer over the table - the row-actions menu, a popover - is not a DOM descendant of the row,
  // so a click inside it cannot bubble here. What does reach here is the browser's own retarget: the menu
  // closes on pointerup, the item the press began on is gone by the time `click` is dispatched, and the event
  // lands on whatever is now under the cursor, which is this row. Every use of a row-actions menu therefore
  // opened the row's record as well - the menu appeared over a detail sheet nobody asked for, and the action
  // then ran against a page that had moved underneath it. Recording where the press began is what tells the
  // two apart; a reader opening a row always presses down on it first.
  // A press that begins on a control INSIDE the row belongs to that control, never to the row: otherwise the
  // press that opens the row-actions menu arms the row, and the retargeted click that closes the menu a moment
  // later finds it still armed.
  const pressedRow = React.useRef<string | null>(null);
  const rowPress = (id: string) => (e: React.PointerEvent) => {
    const control = (e.target as HTMLElement | null)?.closest?.("button, a, input, select, textarea, label, [role='menuitem'], [role='checkbox']");
    pressedRow.current = control && control !== e.currentTarget ? null : id;
  };
  const rowClick = (r: T, id: string) => () => {
    if (pressedRow.current !== id) return;
    pressedRow.current = null;
    onRowClick?.(r);
  };

  const renderMobileCard = (r: T, isChild: boolean) => {
    const id = getRowId(r);
    const { title, meta } = mobileLayout;
    return (
      <Card
        key={id}
        className={cn("p-3", isChild && "ml-6", onRowClick && "cursor-pointer transition-colors active:bg-muted/50", rowClassName?.(r))}
        onPointerDown={onRowClick ? rowPress(id) : undefined}
        onClick={onRowClick ? rowClick(r, id) : undefined}
        role={onRowClick ? "button" : undefined}
        tabIndex={onRowClick ? 0 : undefined}
        onKeyDown={
          onRowClick
            ? (e: React.KeyboardEvent) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onRowClick(r);
                }
              }
            : undefined
        }
      >
        <div className="flex items-start gap-3">
          {bulkActions && !isChild && (
            <Checkbox
              checked={selected.has(id)}
              onCheckedChange={() => toggleOne(id)}
              onClick={(e) => e.stopPropagation()}
              aria-label="Select row"
              className="mt-0.5"
            />
          )}
          <div className="min-w-0 flex-1">
            {title && <div className="text-sm font-medium">{title.cell ? title.cell(r) : String(title.accessor?.(r) ?? "")}</div>}
            <dl className="mt-1 space-y-0.5">
              {meta.map((c) => {
                const content = c.cell ? c.cell(r) : c.accessor ? String(c.accessor(r) ?? "") : null;
                if (content == null || content === "") return null;
                return (
                  <div key={c.id} className="flex items-baseline gap-2 text-xs">
                    <dt className="shrink-0 text-muted-foreground">{c.header}</dt>
                    <dd className="min-w-0 flex-1 truncate text-right">{content}</dd>
                  </div>
                );
              })}
            </dl>
          </div>
          {/* The action cluster wraps rather than holding one line: a row-actions column is free to carry
              labelled buttons ("Confirm receipt", "Return"), and three of those in a row want more than a
              phone screen. Wrapping makes the cluster's floor its widest button instead of their sum, so the
              card shrinks to the screen instead of pushing the page sideways. */}
          {trailing.length > 0 && (
            <div
              // Row actions are written dense (`size="sm"`, h-8) because a table row is a cursor's surface.
              // A card is a finger's, so the same buttons get a 36px floor here - the table itself is left
              // alone, where inflating every row would push the columns off screen.
              className="flex max-w-[55%] flex-wrap items-center justify-end gap-1 coarse:[&_button]:min-h-9 [&>*]:flex-wrap"
              onClick={(e) => e.stopPropagation()}
            >
              {trailing.map((c) => (
                <React.Fragment key={c.id}>{c.cell?.(r)}</React.Fragment>
              ))}
            </div>
          )}
        </div>
      </Card>
    );
  };

  const activeFilters = Object.entries(filters).filter(([, v]) => v);
  const hideableCount = orderedManaged.length;
  const hiddenCount = orderedManaged.filter((id) => hidden.has(id)).length;

  // Server-side search box, shown ALONGSIDE the column filters rather than replacing them. The two do
  // different jobs and compose: this one asks the server for matching records across the WHOLE collection
  // (so it reaches rows past the first page, which a column filter cannot), and the column filters then
  // narrow whatever came back. Only rendered when the page wires it up.
  const searchControl = search && (
    // Full width on a phone: search is the main way to find a row when the table is a card list, and a 208px
    // box next to nothing looks (and reads) like an afterthought.
    <div className="relative w-full sm:w-auto">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        value={search.value}
        onChange={(e) => search.onChange(e.target.value)}
        placeholder={search.placeholder ?? "Search all records…"}
        aria-label={search.placeholder ?? "Search all records"}
        className="h-9 w-full pl-8 pr-7 sm:w-52"
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
  // --- saved views: named snapshots of what the table shows, persisted with its other prefs ---------------
  // Only offered on tables with a tableId (nothing to persist under otherwise). A view captures the whole
  // "which rows, which columns" state - column filters, sort, the server-side search box and the visible
  // column set - so applying one always produces a visible change, whichever control the narrowing came from.
  const [viewName, setViewName] = React.useState("");
  const [viewsOpen, setViewsOpen] = React.useState(false);
  // The table's built-in baseline, i.e. what "Default" restores: the columns' own defaults, no sort,
  // no search. Read from `columns` at call time (a fresh array each render, so never a dependency).
  const baseline = () => ({
    filters: Object.fromEntries(columns.filter((c) => c.defaultFilter).map((c) => [c.id, c.defaultFilter!])),
    hidden: computeHidden(undefined, undefined, managedRef.current),
  });
  const nonEmpty = (f: Record<string, string>) =>
    Object.fromEntries(Object.entries(f).filter(([, v]) => v).sort(([a], [b]) => a.localeCompare(b)));
  const sortKey = sort ? `${sort.id}.${sort.dir}` : "";
  const hiddenKey = [...hidden].sort().join(",");
  const filtersKey = JSON.stringify(nonEmpty(filters));

  function saveCurrentView() {
    const name = viewName.trim();
    if (!name) return;
    const snap: SavedView = {
      name,
      sort: sort ? `${sort.id}.${sort.dir}` : undefined,
      filters: nonEmpty(filters),
      hidden: [...hidden],
      // Keep the pin when overwriting a view that was the default.
      ...(views.find((v) => v.name === name)?.isDefault ? { isDefault: true as const } : {}),
      ...(search ? { search: search.value } : {}),
    };
    setViews((vs) => [...vs.filter((v) => v.name !== name), snap]); // same name = overwrite
    setViewName("");
  }
  // `null` applies the built-in default view.
  const applyView = (v: SavedView | null) => {
    setViewsOpen(false);
    setPage(0);
    setPickedView(v?.name ?? null);
    const base = baseline();
    setSort(parseUrlSort(v?.sort));
    setFilters(v ? { ...v.filters } : base.filters);
    // Legacy views saved before column visibility was captured leave the current layout alone.
    setHidden(v ? (v.hidden ? new Set(v.hidden) : hidden) : base.hidden);
    search?.onChange(v?.search ?? "");
  };
  const toggleDefaultView = (name: string) =>
    setViews((vs) => vs.map((v) => (v.name === name ? { ...v, isDefault: !v.isDefault } : { ...v, isDefault: false })));

  // Which view the table is currently showing. The one the user picked wins as long as the live state still
  // matches its snapshot, so it clears itself the moment they tweak a filter away from it - and two views
  // that happen to capture the same state stay distinguishable (matching alone would always name the first).
  const viewMatches = (v: SavedView) =>
    JSON.stringify(nonEmpty(v.filters)) === filtersKey &&
    (v.sort ?? "") === sortKey &&
    (!v.hidden || [...v.hidden].sort().join(",") === hiddenKey) &&
    (!search || (v.search ?? "") === search.value);
  const picked = views.find((v) => v.name === pickedView) ?? null;
  const activeView = picked && viewMatches(picked) ? picked : (views.find(viewMatches) ?? null);
  const onBaseline =
    !activeView &&
    !sort &&
    filtersKey === JSON.stringify(nonEmpty(baseline().filters)) &&
    hiddenKey === [...baseline().hidden].sort().join(",") &&
    (!search || !search.value);

  // Open the table on its pinned default view. Runs once, after prefs land, and yields to a deep link:
  // a URL that carries explicit table state is a more specific request than the saved default.
  React.useEffect(() => {
    if (!tableId || !hydrated || defaultApplied.current === tableId) return;
    defaultApplied.current = tableId;
    if (readUrlTableState(urlKey)) return;
    const pinned = views.find((v) => v.isDefault);
    if (pinned) applyView(pinned);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableId, hydrated, views]);

  const viewRow = (key: string, label: string, active: boolean, onApply: () => void, extras?: React.ReactNode) => (
    <div key={key} className="group/view flex items-center gap-1">
      <button
        type="button"
        onClick={onApply}
        aria-current={active ? "true" : undefined}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5 rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
          active && "bg-accent/60 font-medium"
        )}
      >
        <Check className={cn("h-3.5 w-3.5 shrink-0", active ? "text-primary" : "opacity-0")} />
        <span className="truncate">{label}</span>
      </button>
      {extras}
    </div>
  );

  const viewsControl = tableId ? (
    <TooltipProvider>
      <Popover open={viewsOpen} onOpenChange={setViewsOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size={activeView ? "sm" : "icon"}
                className={cn("relative h-9 gap-1.5", activeView ? "max-w-40 px-2.5" : "w-9")}
                aria-label="Saved views"
              >
                <Bookmark className={cn("h-4 w-4 shrink-0", activeView && "fill-current text-primary")} />
                {activeView ? (
                  <span className="truncate text-xs">{activeView.name}</span>
                ) : (
                  views.length > 0 && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" />
                )}
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>{activeView ? `View: ${activeView.name}` : "Saved views"}</TooltipContent>
        </Tooltip>
        <PopoverContent align="end" className="w-60">
          <p className="mb-2 text-xs font-semibold text-muted-foreground">Views</p>
          <div className="max-h-64 space-y-0.5 overflow-y-auto">
            {viewRow("__default", "Default", onBaseline, () => applyView(null))}
            {views.map((v) =>
              viewRow(
                v.name,
                v.name,
                activeView?.name === v.name,
                () => applyView(v),
                <>
                  <button
                    type="button"
                    aria-label={v.isDefault ? `Unpin ${v.name} as the default view` : `Open ${v.name} by default`}
                    onClick={() => toggleDefaultView(v.name)}
                    className={cn(
                      "rounded p-1 transition-opacity hover:text-primary",
                      v.isDefault ? "text-primary" : "text-muted-foreground opacity-0 group-hover/view:opacity-100"
                    )}
                  >
                    <Star className={cn("h-3.5 w-3.5", v.isDefault && "fill-current")} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete view ${v.name}`}
                    onClick={() => setViews((vs) => vs.filter((x) => x.name !== v.name))}
                    className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/view:opacity-100"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </>
              )
            )}
          </div>
          <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
            {views.length === 0
              ? "Set up filters, a sort or a search, then save them here as a named view."
              : "A view restores its filters, sort, search and columns. Star one to open the table with it."}
          </p>
          <div className="mt-2 flex items-center gap-1.5 border-t pt-2">
            <Input
              value={viewName}
              onChange={(e) => setViewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  saveCurrentView();
                }
              }}
              placeholder="Name this view"
              className="h-8 min-w-0"
            />
            <Button size="sm" className="h-8" disabled={!viewName.trim()} onClick={saveCurrentView}>
              Save
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  ) : null;

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
          <div className="mt-2 flex items-center justify-between border-t pt-2">
            <span className="text-xs font-semibold text-muted-foreground">Density</span>
            <div className="inline-flex rounded-md border p-0.5">
              {(["comfortable", "compact"] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDensity(d)}
                  className={cn(
                    "rounded px-2 py-0.5 text-xs capitalize transition-colors",
                    density === d ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );

  // --- phone sort & filter ----------------------------------------------------------------------------------
  // On a phone the table becomes cards, and cards have no column headers - which is where all of the sorting
  // and filtering lived. Without this control the phone view is a fixed, unsortable, unfilterable list: the
  // same rows in the same order, however many there are. Everything the header offers is gathered into one
  // sheet instead, in the order the questions get asked ("newest first", "only the pending ones").
  const [sortSheet, setSortSheet] = React.useState(false);
  const sortableCols = visibleColumns.filter((c) => c.sortable !== false && !!c.accessor && c.header);
  const filterableCols = visibleColumns.filter((c) => c.filter !== "none" && !!c.accessor && c.header);
  const phoneToolsControl = (sortableCols.length > 0 || filterableCols.length > 0) && (
    <Sheet open={sortSheet} onOpenChange={setSortSheet}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" className="h-9 gap-1.5">
          <SlidersHorizontal className="h-4 w-4" />
          Sort & filter
          {activeFilters.length > 0 && (
            <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-4 text-primary-foreground">
              {activeFilters.length}
            </span>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Sort & filter</SheetTitle>
          <SheetDescription>
            {total} row{total === 1 ? "" : "s"} shown{truncated ? " of the records loaded so far" : ""}
          </SheetDescription>
        </SheetHeader>
        <SheetBody className="space-y-6">
          {sortableCols.length > 0 && (
            <section className="space-y-1">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sort by</h4>
              {sortableCols.map((col) => {
                const dir = sort?.id === col.id ? sort.dir : null;
                return (
                  <button
                    key={col.id}
                    type="button"
                    // Same three-state cycle as tapping a column header on a desktop (asc, desc, off), so the
                    // two surfaces do not disagree about what a second tap means.
                    onClick={() => toggleSort(col)}
                    className={cn(
                      "flex min-h-11 w-full items-center justify-between gap-2 rounded-lg px-3 text-sm transition-colors",
                      dir ? "bg-accent font-medium text-accent-foreground" : "hover:bg-muted",
                    )}
                  >
                    <span className="truncate">{col.header}</span>
                    {dir === "asc" ? (
                      <span className="flex shrink-0 items-center gap-1 text-xs">
                        <ArrowUp className="h-3.5 w-3.5" /> A-Z
                      </span>
                    ) : dir === "desc" ? (
                      <span className="flex shrink-0 items-center gap-1 text-xs">
                        <ArrowDown className="h-3.5 w-3.5" /> Z-A
                      </span>
                    ) : (
                      <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                    )}
                  </button>
                );
              })}
            </section>
          )}

          {filterableCols.length > 0 && (
            <section className="space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Filter</h4>
              {filterableCols.map((col) => {
                const value = filters[col.id] ?? "";
                return (
                  <div key={col.id} className="space-y-1.5">
                    <label className="text-sm font-medium">{col.header}</label>
                    {col.filter === "select" ? (
                      // A native-feeling Select rather than the desktop popover's option list: on a phone one
                      // tap to a bounded, scrollable list beats a nested overlay inside a sheet.
                      <Select
                        value={value || "__all__"}
                        onValueChange={(v) => setFilters((f) => ({ ...f, [col.id]: v === "__all__" ? "" : v }))}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__all__">All</SelectItem>
                          {distinctValues(col).map((v) => (
                            <SelectItem key={v} value={v}>
                              {v}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <Input
                          value={value}
                          placeholder={`Any ${col.header.toLowerCase()}`}
                          onChange={(e) => setFilters((f) => ({ ...f, [col.id]: e.target.value }))}
                        />
                        {value && (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Clear ${col.header} filter`}
                            onClick={() => setFilters((f) => ({ ...f, [col.id]: "" }))}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
          )}
        </SheetBody>
        <SheetFooter className="justify-between">
          <Button variant="ghost" onClick={() => setFilters({})} disabled={activeFilters.length === 0}>
            Clear filters
          </Button>
          {/* The sheet applies as you go, so this is a dismiss, not a commit - labelled for what it does. */}
          <Button onClick={() => setSortSheet(false)}>Done</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );

  // Cross-module export: the visible, accessor-bearing columns (skips the access/actions columns) of the
  // FILTERED rows (all of them, not just the current page). Gated by the `export` capability; the AccessAction
  // overlays the manage icon in access mode so admins control who may export.
  const canExport = usePermission("export.read");
  const exportCols = visibleColumns.filter((c) => c.accessor && c.header);
  function runExport(format: "csv" | "xlsx") {
    const headers = exportCols.map((c) => c.header);
    const data = filtered.map((r) => exportCols.map((c) => c.accessor!(r) ?? ""));
    // `accessCollection` is the real collection name where the table has one; the filename fallback is a view
    // label. The server anchors the audit entry on the former and records the latter as a label.
    void exportTable(tableId || accessCollection || "export", headers, data, format, accessCollection);
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

  // The zero state, written once for the two places it renders (a Card on a phone, a full-width row in the
  // table). A table can be empty for two different reasons and they need two different offers: nothing has
  // been created yet -> the page's own create control; a filter or a search excluded everything -> the way
  // back out of it. Offering "Add delegation" to someone who has simply mistyped a search is noise.
  const filteredEmpty = anyFilter || !!search?.value;
  const emptyBody = (
    <>
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Inbox className="h-6 w-6" />
      </div>
      <div>
        {/* With only the first page loaded, "no results" would be a lie: the match may sit in a row that was
            never fetched. Say which set was actually searched. */}
        <p className="text-sm font-medium text-foreground">
          {truncated && anyFilter ? `No matches in the ${rows.length} loaded records` : emptyTitle}
        </p>
        {truncated && anyFilter ? (
          <p className="mt-1 text-sm text-muted-foreground">
            This page holds only the first {rows.length} records, and filters apply to those. The record you want may not be loaded — use search (⌘K) to look across everything.
          </p>
        ) : filteredEmpty ? (
          <p className="mt-1 text-sm text-muted-foreground">Nothing here matches what you're filtering by.</p>
        ) : (
          emptyDescription && <p className="mt-1 text-sm text-muted-foreground">{emptyDescription}</p>
        )}
      </div>
      {filteredEmpty ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => { setFilters({}); search?.onChange(""); }}
        >
          Clear {anyFilter && search?.value ? "search and filters" : anyFilter ? "filters" : "search"}
        </Button>
      ) : (
        emptyAction
      )}
    </>
  );

  return (
    <div className="space-y-3">
      {/* Controls: portaled into a parent bar (tabs/toggles) when a slot is given, else their own row. */}
      {/* Which controls belong on a phone: search (full width - it is the primary way to find a row on a
          small screen), the sort & filter sheet in place of the column headers that no longer exist, and the
          same views/export affordances. The column picker is dropped: cards have no columns to pick, and its
          density switch is a table-only setting. */}
      {controlsSlot !== undefined ? (
        controlsSlot
          ? createPortal(
              <div className="flex flex-wrap items-center justify-end gap-2">
                {searchControl}
                {chipsControl}
                {toolbar}
                {isPhone && phoneToolsControl}
                {exportControl}
                {viewsControl}
                {!isPhone && columnsControl}
              </div>,
              controlsSlot,
            )
          : null
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            {title && <h3 className="mr-1 text-lg font-semibold">{title}</h3>}
            {searchControl}
            {chipsControl}
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
            {toolbar}
            {isPhone && phoneToolsControl}
            {exportControl}
            {viewsControl}
            {!isPhone && columnsControl}
          </div>
        </div>
      )}

      {/* Bulk bar: appears with the first selected row.
          Desktop - sticky under the toolbar, so it stays reachable while scrolling a long table.
          Phone - docked above the bottom nav instead. Selecting rows on a phone means scrolling a card list,
          and a bar stuck to the TOP of that list is off screen by the third selection; docked at the bottom
          it stays exactly where the selecting thumb already is. */}
      {bulkActions && selected.size > 0 && (
        <div
          className={cn(
            "z-20 flex items-center gap-2 rounded-lg border border-primary/30 bg-card px-3 py-2 shadow-pop",
            "fixed inset-x-3 bottom-[calc(4.25rem+env(safe-area-inset-bottom))] flex-wrap",
            "md:sticky md:inset-x-auto md:bottom-auto md:top-2",
          )}
        >
          <span className="text-sm font-medium tabular-nums">
            {selectedRows.length} selected
            {/* What the selection adds up to, before an irreversible bulk action decides its fate. */}
            {sumCols.map((col) => (
              <span key={col.id} className="ml-2 font-normal text-muted-foreground">
                {col.header}: {fmtTotal(col, sumOf(selectedRows, col))}
              </span>
            ))}
          </span>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
          <div className="min-w-4 flex-1" />
          {bulkActions.map((a) => {
            const reason = a.disabled?.(selectedRows) ?? null;
            return (
              <Button
                key={a.label}
                size="sm"
                variant={a.destructive ? "destructive" : "outline"}
                disabled={!!reason || (!!bulkBusy && bulkBusy !== a.label)}
                loading={bulkBusy === a.label}
                title={reason ?? undefined}
                onClick={() => void runBulk(a)}
              >
                {a.icon} {a.label}
              </Button>
            );
          })}
        </div>
      )}

      {isPhone ? (
        filtered.length === 0 ? (
          <Card className="flex flex-col items-center gap-3 p-6 text-center sm:p-8">{emptyBody}</Card>
        ) : (
          <div className="space-y-2">
            {showTotals && (
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border bg-muted/60 px-3 py-2 text-xs">
                <span className="uppercase tracking-wide text-muted-foreground">Total · {total} row{total === 1 ? "" : "s"}</span>
                {sumCols.map((col) => (
                  <span key={col.id} className="font-medium tabular-nums">{col.header}: {fmtTotal(col, sumOf(filtered, col))}</span>
                ))}
              </div>
            )}
            {paged.flatMap((row) => [
              renderMobileCard(row, false),
              // Children are always visible on phone: cards carry no fold chevron.
              ...(getSubRows?.(row) ?? []).map((k) => renderMobileCard(k, true)),
            ])}
          </div>
        )
      ) : (
      <Card className="overflow-hidden">
        <Table
          containerClassName="max-h-[68dvh]"
          className={density === "compact" ? "[&_tbody_td]:py-1.5 [&_thead_th]:h-9" : undefined}
        >
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
                    // Which column the table is ordered by, and which way - the one thing a sorted table
                    // says visually (an arrow in the header) that a screen reader was told nothing about.
                    // `none` on the other sortable columns is what makes the sorted one stand out rather
                    // than being the only header carrying the attribute at all.
                    aria-sort={canSort ? (sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none") : undefined}
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
                    {col.id === "__select__" ? (
                      <Checkbox
                        checked={allSelected ? true : selected.size > 0 ? "indeterminate" : false}
                        onCheckedChange={toggleAll}
                        aria-label={allSelected ? "Deselect all rows" : "Select all rows"}
                        disabled={filtered.length === 0}
                      />
                    ) : (
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
                              // Named, because it is an icon alone: without this it is a button a screen
                              // reader announces as "button" and nothing else, on every filterable column of
                              // every table in the app.
                              aria-label={`Filter by ${col.header.toLowerCase()}`}
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
                                    <Button variant="ghost" size="icon" aria-label={`Clear the ${col.header.toLowerCase()} filter`} className="h-8 w-8 shrink-0" onClick={() => setFilters((f) => ({ ...f, [col.id]: "" }))}>
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
                    )}
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
                  <div className="flex flex-col items-center justify-center gap-3 py-6">{emptyBody}</div>
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
                    onPointerDown={onRowClick ? rowPress(getRowId(r)) : undefined}
                    onClick={onRowClick ? rowClick(r, getRowId(r)) : undefined}
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
                        {col.id === "__select__" ? (
                          !isChild && (
                            <Checkbox
                              checked={selected.has(getRowId(r))}
                              onCheckedChange={() => toggleOne(getRowId(r))}
                              onClick={(e) => e.stopPropagation()}
                              aria-label="Select row"
                            />
                          )
                        ) : col.cell ? (
                          col.cell(r)
                        ) : (
                          String(col.accessor?.(r) ?? "")
                        )}
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
          {showTotals && (
            <TableFooter>
              <TableRow className="hover:bg-transparent">
                {renderCols.map((col, i) => (
                  <TableCell
                    key={col.id}
                    style={widthStyle(col.id)}
                    className={cn("truncate text-xs", col.align === "right" && "text-right tabular-nums", col.align === "center" && "text-center")}
                  >
                    {col.aggregate === "sum" ? (
                      fmtTotal(col, sumOf(filtered, col))
                    ) : i === 0 ? (
                      <span className="uppercase tracking-wide text-muted-foreground">Total · {total} row{total === 1 ? "" : "s"}</span>
                    ) : null}
                  </TableCell>
                ))}
              </TableRow>
            </TableFooter>
          )}
        </Table>
      </Card>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 px-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-2">
          <span>
            {total === 0 ? "No records" : `Showing ${from}-${to} of ${truncated ? `${total}+` : total}`}
            {total !== rows.length ? ` (filtered from ${truncated ? `${rows.length}+` : rows.length})` : ""}
            {truncated && !onLoadMore ? " — first page only" : ""}
          </span>
          {truncated && onLoadMore && (
            <Button
              variant="outline"
              size="sm"
              // "Load more" is how you reach records past the first page - the one control in this row that
              // must be easy to hit, and it was the smallest thing on the page at 24px.
              className="h-7 px-2 text-xs coarse:h-9 coarse:px-3"
              loading={loadingMore}
              onClick={() => {
                setLoadingMore(true);
                void Promise.resolve(onLoadMore()).finally(() => setLoadingMore(false));
              }}
            >
              Load more
            </Button>
          )}
        </span>
        <div className="flex items-center gap-3 sm:gap-4">
          <div className="flex items-center gap-2">
            {/* The label is the first thing to go on a narrow screen: the select's own value ("25") plus its
                position in the pager already says what it does, and the words cost a third of the row. */}
            <span className="hidden sm:inline">Rows per page</span>
            <Select value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v))}>
              <SelectTrigger className="h-7 w-[72px] coarse:min-h-9" aria-label="Rows per page">
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
              {/* Paging arrows are pure navigation and get hit repeatedly - 28px is a miss on touch. */}
              <Button variant="outline" size="icon" className="h-7 w-7 coarse:h-9 coarse:w-9" aria-label="Previous page" disabled={safePage <= 0} onClick={() => setPage(safePage - 1)}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="icon" className="h-7 w-7 coarse:h-9 coarse:w-9" aria-label="Next page" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>
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
