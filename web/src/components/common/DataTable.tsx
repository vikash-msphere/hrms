import * as React from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, Ban, Bookmark, Check, ChevronsDownUp, ChevronsUpDown, Copy, ExternalLink, EyeOff, Filter, Layers, X, SlidersHorizontal, GripVertical, ChevronLeft, ChevronRight, Download, FileSpreadsheet, FileText, Inbox, Search, Star } from "lucide-react";
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
import { loadLocalPrefs, fetchServerPrefs, savePrefs, type SavedView, type TablePrefs } from "@/lib/tablePrefs";
import { useConfirm } from "@/components/common/confirm";
import { useAccessMode, type AccessTargetRef } from "@/components/access/AccessModeProvider";
import { AccessTarget } from "@/components/access/AccessTarget";
import { AccessAction } from "@/components/access/AccessAction";
import { usePermission, useCanExport } from "@/lib/perm";
import { exportTable } from "@/lib/exportTable";
import { useCollectionHasMore } from "@/hooks/useCollection";
import { syncLastUrl } from "@/router";
import { useMedia } from "@/hooks/useMedia";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/use-toast";
import { BLANK, filterChipLabel, matchesFilter, numberStats, type FilterKind } from "@/lib/tableFilter";
import { DateFilterPanel, NumberFilterPanel, SelectFilterPanel, type SelectOption } from "@/components/common/tableFilterPanels";
import { TableInsights, type TableInsight } from "@/components/common/TableInsights";
// The app's one pill filter, so a scope chip cannot drift into a fifth appearance of the same control.
import { FilterChip } from "@/components/common/FilterChips";
import { todayStr } from "@/lib/orgDay";

const PAGE_SIZES = [10, 25, 50, 100, 0]; // 0 = All

/** Joins column ids into one comparable key. A character no column id can contain, so the key is unambiguous. */
const ID_SEP = String.fromCharCode(0);

// Which table's search box `/` reaches. A page can hold several tables (tabs that render all their panels,
// a page with a sub-table), and every one of them listening for `/` would race to steal the same keystroke.
// The FIRST one mounted owns the key for as long as it is mounted, which on a tabbed page is the tab that
// was open first - and the shortcut sheet only ever promised one search box per page.
const slashOwners: symbol[] = [];

/** The next focusable row in `dir`, stepping over group headers and anything else that cannot take focus. */
function focusSiblingRow(from: HTMLElement, dir: 1 | -1): void {
  let el: Element | null = dir === 1 ? from.nextElementSibling : from.previousElementSibling;
  while (el && !el.hasAttribute("tabindex")) el = dir === 1 ? el.nextElementSibling : el.previousElementSibling;
  (el as HTMLElement | null)?.focus();
}

export type Column<T> = {
  id: string;
  header: string;
  /** Value used for sorting and filtering. */
  accessor?: (row: T) => string | number | boolean | null | undefined;
  /** Custom cell renderer; defaults to the accessor value. */
  cell?: (row: T) => React.ReactNode;
  sortable?: boolean; // default true when accessor present
  // How this column is narrowed. Default "text" when an accessor is present.
  //   text    substring match, the safe default for a name or a free-text field
  //   select  the column's distinct values, each with a row count
  //   number  comparisons and ranges (>, ≥, between…), with the column's own min/median/max/total offered
  //   date    calendar windows (last 30 days, this month, before today) and an explicit from/to
  // A money or day column left as "text" filters by SUBSTRING, which is not a question anyone asks of it -
  // "5000" matches 15000 and misses 5000.50. See lib/tableFilter.ts for the value grammar; every kind still
  // encodes to a plain string, so deep links and saved views carry them unchanged.
  filter?: FilterKind;
  // Which half of the calendar a date column lives in, so its filter panel leads with the right windows: a
  // Created column is asked about the past, a Due column about what is coming. Ordering only - both halves
  // stay offered.
  dateHint?: "past" | "future";
  // Offer this column in the group-by picker. Worth it where the column is a small set of repeated values
  // that people compare across (department, category, status, owner); pointless on a name or an id, and
  // actively bad on a date, which groups into a heap of one-row groups.
  groupBy?: boolean;
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
  // Numeric column that carries a figure: the table aggregates the accessor over every FILTERED row (all
  // pages, not just the one on screen) into a footer strip, per group, and over the selection in the bulk
  // bar. Money columns pass `formatTotal` so the figure reads in the same units as the cells - "what am I
  // looking at, in total" is the question a finance table gets asked most, and reaching for a spreadsheet to
  // answer it is a page failing.
  //
  // Which kind to pick: `sum` for anything that adds up (money, days, points), `avg` for a rate or a
  // duration where the total is meaningless ("average days open"), `min`/`max` for the extreme that decides
  // something ("the oldest thing in this queue"), `count` for how many rows carry a value at all.
  //
  // Blanks: `sum` treats a missing value as zero, because a row with no amount contributes no amount. Every
  // other kind SKIPS blanks - an average that counted the rows with nothing recorded is not the average
  // anybody meant, and it moves whenever somebody adds an empty row.
  aggregate?: "sum" | "avg" | "min" | "max" | "count";
  // How a figure from this column reads. Used for the footer/selection total, and for every other figure the
  // table prints from it: the min/median/max in a number filter's panel, and the filter chip ("Amount: >
  // ₹5,000" rather than "Amount: >5000"). Worth setting on any numeric column that carries a unit, not only
  // on the ones that are summed.
  formatTotal?: (n: number) => React.ReactNode;
  // A proportion (0..1) drawn behind this column's cells, so a ratio reads DOWN the column instead of one row
  // at a time: which budgets are nearly spent, which counts came out short, who has used most of their leave.
  // Return null where the row has no proportion to draw (no denominator, not applicable) and the cell renders
  // plain. Values above 1 are drawn full and toned as an overrun, because "over" is the state worth seeing.
  //
  // It is decoration over the cell's own content, never a replacement for it: the number still has to be
  // readable, and the bar is what makes the column scannable.
  bar?: (row: T) => number | null;
  // Extra items on this column's cell menu, built from the row. Meant for the jump a value implies - an
  // employee cell leading to that person's own pages - not for row actions, which belong in an actions column
  // where they can be seen without a right-click.
  actions?: (row: T) => CellMenuAction[];
};

/** One page-supplied item on a cell's right-click menu. */
export type CellMenuAction = { label: string; icon?: React.ReactNode; onSelect: () => void };

/** One "whose rows" preset. See the `scopes` prop for what belongs here and what does not. */
export type TableScope = {
  /** Stable across renders; also what a deep link and `defaultScope` name. */
  id: string;
  label: React.ReactNode;
  /** The narrowing this scope IS, over the table's own columns. Empty = the unnarrowed table ("All"). */
  filters: Record<string, string>;
  /** How many rows it would show. Left out where counting it would cost a read the page has not done. */
  count?: number;
  /** Anything that rides the chip - a "new since you looked" badge, most often. */
  badge?: React.ReactNode;
  title?: string;
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
  /**
   * Runs with the selected rows.
   *
   * The return value says WHAT TO KEEP SELECTED: rows back means keep exactly those (a partial failure hands
   * back the rows that failed), nothing back means the run succeeded and the selection is cleared, and a throw
   * keeps the whole selection for a blanket retry.
   *
   * Keeping everything selected after a partial failure is a dead end on a queue: approve ten expenses, two
   * fail, the reload lands and eight of them are now APPROVED - and the Approve action's own `disabled` guard
   * (`every(r => state === "SUBMITTED")`) then evaluates false, so the button the reader needs is greyed out
   * with nothing on screen saying which two failed or that the way forward is to deselect eight rows by hand.
   * `bulkInvoke` already computes `failedRows`; this is the channel it had no way to return through.
   */
  run: (rows: T[]) => void | Promise<void> | T[] | Promise<T[] | void>;
};

// --- Deep-linkable table state (sort + filters), carried in the URL query as one param per table ----------
// Encoded as t.<key>={"s":"col.dir","f":{col:value},"g":"col"}. `f` is present only when the filters differ from the
// columns' defaultFilter seed, so an untouched table adds nothing to the URL; an explicitly cleared default
// round-trips as {"f":{}}. Written with history.replaceState (no history entry per keystroke, and the
// unsaved-changes guard in router.ts ignores query-only changes).
type UrlTableState = { s?: string; f?: Record<string, string>; g?: string };

function readUrlTableState(key: string | undefined): UrlTableState | null {
  if (!key) return null;
  try {
    const raw = new URLSearchParams(window.location.search).get(`t.${key}`);
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

/** The proportion behind a `bar` column's cell. Drawn under the content, never over it, and toned by how far
 *  along it is: the reader is looking for the ones running out, so "nearly there" and "over" have to differ
 *  from "plenty left" without reading the number. */
function CellBar({ value }: { value: number | null }) {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  const pct = Math.min(1, value) * 100;
  // No z-index: an absolutely positioned element paints after the cell's own inline text, so the bar is
  // deliberately kept faint enough to read straight through. Sending it behind instead (`-z-10`) would put
  // it behind the ROW's background, which is opaque, and it would never be seen at all.
  const tone = value > 1 ? "bg-destructive/20" : value >= 0.9 ? "bg-warning/20" : "bg-primary/10";
  return (
    <span aria-hidden className={cn("pointer-events-none absolute inset-y-0 left-0 rounded-sm", tone)} style={{ width: `${pct}%` }} />
  );
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
  onVisibleRows,
  accessTargetOf,
  getSubRows,
  hasMore,
  search,
  bulkActions,
  onLoadMore,
  insights,
  scopes,
  defaultScope,
  defaultGroupBy,
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
  /**
   * The rows this table is showing - filtered and sorted, in display order - whenever that set changes.
   *
   * For a page that opens a row in a dialog and then lets the reader step to the next one: "next" has to mean
   * the next row in THIS table, or stepping walks off into rows the table filtered out and a "3 of 48"
   * counts a set nobody is looking at. Every page ordering lives in here, so nothing outside can reproduce it.
   *
   * Pass a STABLE callback (a `useState` setter is one). `filtered` keeps its identity when the result is
   * unchanged, so this fires only when the set really moves - not on every render.
   */
  onVisibleRows?: (rows: T[]) => void;
  /**
   * What is worth noticing about these rows, said by the page that understands them.
   *
   * Called with every LOADED row - not the filtered set - so a chip keeps saying how many there are after
   * its own filter has been applied, and so the strip does not empty itself the moment it is used. Each chip
   * carries the narrowing that isolates exactly the rows it counted; clicking applies it, clicking again
   * puts the table back. See components/common/TableInsights.tsx for what makes a chip worth having.
   */
  insights?: (rows: T[]) => TableInsight[];
  /**
   * WHOSE ROWS - the identity question, as named presets over this table's own column filters.
   *
   * A page used to answer this with a tab bar: four tabs, four tables, four saved layouts, for what is one
   * table narrowed four ways. A scope is the same narrowing said as a chip, and because it is nothing but a
   * preset of `filters` it inherits everything the table already does with them - the deep link, the saved
   * view, the "these filters are on" row, and the rule that what a chip shows is exactly what it counted.
   *
   * Only for the identity axis. A tab bar whose tabs are STATES (a review queue, a payment queue) or
   * different row types is not this, and flattening one into chips would conflate two questions.
   */
  scopes?: TableScope[];
  /** The scope a reader lands on. Yields to a deep link, like every other opening state on the table. */
  defaultScope?: string;
  // Group the table by this column on first open (the reader can regroup or ungroup, and their choice is
  // saved with the rest of the table's prefs). The column must carry `groupBy`.
  defaultGroupBy?: string;
}) {
  const am = useAccessMode();
  const { toast } = useToast();
  // The org's today, not the browser's: a date filter reading "last 7 days" has to mean the same seven days
  // for a reader in London as for the office in Mumbai whose rows these are.
  const today = todayStr();
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
  // Keyed on the id STRING, not on `managed`. Pages build their `columns` as a fresh array literal in the
  // render body, so `managed` takes a new identity every render and everything derived from it did too -
  // including `orderedManaged`, which is in the layout-persist effect's dependency array, so that effect
  // re-ran and `JSON.stringify`d the whole prefs payload on every render of every table in the app. Column
  // IDS are plain strings and cannot go stale the way a column's accessor closure can, so this is the one
  // part of the chain that is safe to freeze.
  const managedIdsKey = managed.map((c) => c.id).join(ID_SEP);
  const managedIds = React.useMemo(() => managedIdsKey.split(ID_SEP).filter(Boolean), [managedIdsKey]);

  // READ ONCE, not once per render. `useRef(loadLocalPrefs(tableId))` evaluates its argument on every render
  // and keeps only the first result, so this was a synchronous `localStorage.getItem` plus a `JSON.parse` per
  // render of every table on the page - one per keystroke in a column filter, and this is the component the
  // whole app lists through. It is also exactly the cost lib/clientStore.ts exists to keep out of render.
  const initialRef = React.useRef<TablePrefs | null>(null);
  if (!initialRef.current) initialRef.current = loadLocalPrefs(tableId);
  const initial = initialRef.current;
  const [order, setOrder] = React.useState<string[]>(initial.order ?? managedIds);
  const [hidden, setHidden] = React.useState<Set<string>>(
    () => computeHidden(initial.hidden, initial.order, managed)
  );
  const [widths, setWidths] = React.useState<Record<string, number>>(initial.widths ?? {});
  const [pageSize, setPageSize] = React.useState<number>(initial.pageSize ?? 25);
  const [density, setDensity] = React.useState<"comfortable" | "compact">(initial.density ?? "comfortable");
  // A deep link's grouping wins over the saved one, like its sort and filters do (see `urlInitial`; the
  // read is repeated here because this state is declared above that ref).
  const [groupBy, setGroupBy] = React.useState<string>(
    () => readUrlTableState(tableId ?? accessCollection)?.g ?? initial.groupBy ?? defaultGroupBy ?? "",
  );
  // Which groups are folded shut, by group value. Deliberately NOT persisted: it is a reading gesture
  // ("put that lot away while I look at this one"), not a layout choice, and a table that reopened with
  // four of its groups shut would look like it had lost rows.
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  const [views, setViews] = React.useState<SavedView[]>(initial.views ?? []);
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
  const defaultGroupByRef = React.useRef(defaultGroupBy);
  defaultGroupByRef.current = defaultGroupBy;
  const accessCollectionRef = React.useRef(accessCollection);
  accessCollectionRef.current = accessCollection;
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
      setGroupBy(local.groupBy ?? defaultGroupByRef.current ?? "");
      setSort(parseUrlSort(local.sort));
      setCollapsed(new Set());
      setViews(local.views ?? []);
      setPickedView(null);
      setHydrated(false);
      savedBaseline.current = null;
      loadedFor.current = tableId;
    }
    void fetchServerPrefs(tableId).then((sp) => {
      if (!active) return;
      if (sp) {
        // A deep link is a more specific request than the saved layout, and this lands long after the first
        // render read the URL - so whatever the link carries is left exactly as it was set.
        const deep = readUrlTableState(tableId ?? accessCollectionRef.current);
        if (sp.order) setOrder(sp.order);
        setHidden(computeHidden(sp.hidden, sp.order, managedRef.current));
        setWidths(sp.widths ?? {});
        if (typeof sp.pageSize === "number") setPageSize(sp.pageSize);
        if (sp.density) setDensity(sp.density);
        if (typeof sp.groupBy === "string" && typeof deep?.g !== "string") setGroupBy(sp.groupBy);
        if (typeof sp.sort === "string" && !deep?.s) setSort(parseUrlSort(sp.sort));
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
  // A deep link's sort wins over the saved one, like its filters and grouping do.
  const [sort, setSort] = React.useState<SortState>(() => parseUrlSort(urlInitial.current?.s ?? initial.sort));
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
    if (typeof carried.g === "string") setGroupBy(carried.g);
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
      if (groupBy) payload.g = groupBy;
      const value = Object.keys(payload).length > 0 ? JSON.stringify(payload) : null;

      const params = new URLSearchParams(window.location.search);
      if (params.get(`t.${urlKey}`) === value || (!params.has(`t.${urlKey}`) && value === null)) return;
      if (value === null) params.delete(`t.${urlKey}`);
      else params.set(`t.${urlKey}`, value);
      const q = params.toString();
      // Carries the current state object through, like router.ts and urlQuery.ts: a dialog's own history entry
      // is marked `hrmsDialog: true` and `dropDialogEntry` refuses to pop one whose marker has gone, so
      // replacing the state with null while a dialog was open left a dead back-entry behind it.
      history.replaceState(window.history.state, "", `${window.location.pathname}${q ? `?${q}` : ""}`);
      syncLastUrl(); // no route change is announced, so the guard has to be told what the address bar now says
    }, 250);
    return () => clearTimeout(t);
    // `columns` is usually a fresh array per render; reading defaults inside the debounce keeps it out of deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlKey, sort, filters, groupBy]);

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
  // Where "Total · N rows" goes in the footer: the first data column that isn't itself showing a sum, so the
  // label never displaces a figure and never lands in a 1px gutter column.
  const totalLabelColId = (visibleColumns.find((c) => c.aggregate !== "sum") ?? visibleColumns[0])?.id;

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
    const payload = {
      order: orderedManaged,
      hidden: [...hidden],
      widths,
      pageSize,
      density,
      groupBy,
      sort: sort ? `${sort.id}.${sort.dir}` : "",
      views,
    };
    const serialized = JSON.stringify(payload);
    if (savedBaseline.current === null) {
      savedBaseline.current = serialized; // first post-hydration run = the loaded layout; don't save it back
      return;
    }
    if (serialized === savedBaseline.current) return; // no real change
    savedBaseline.current = serialized;
    savePrefs(tableId, payload);
  }, [hydrated, tableId, orderedManaged, hidden, widths, pageSize, density, groupBy, sort, views]);

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
  //
  // WHAT THE SPLIT DOES NOT BUY, stated plainly because the shape of the code suggests otherwise. `colById` is
  // derived from `columns`, which pages build as a fresh array literal in the render body, so the memo below
  // is invalidated on EVERY render and the pass runs in the urgent render as well as the deferred one. The
  // deferral still does its job - it keeps the keystroke itself off the critical path and lets React abandon a
  // half-finished pass - but it does not make the urgent render free.
  //
  // Freezing the memo on a column-ID signature would fix the count and break the result. A column's accessor
  // is a closure over data the page loaded separately (`empName` over `employees`, `deptName` over
  // `departments`), and that data arrives without `rows`, `sort` or the filters changing - so a memo keyed on
  // ids alone would keep sorting and filtering through accessors that still read an empty directory, long
  // after the cells beside them rendered the names. A stale sort order is a worse defect than a second pass.
  // The pass is made CHEAP instead (see `personName`'s prepared-map overload, which is what made these
  // accessors linear scans), and the RESULT is kept referentially stable below so nothing downstream churns.
  const deferredFilters = React.useDeferredValue(filters);

  const lastFiltered = React.useRef<T[]>([]);
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
      const kind = col.filter ?? "text";
      out = out.filter((r) => matchesFilter(kind, value, col.accessor!(r), today));
    }
    if (sort) {
      const col = colById[sort.id];
      if (col?.accessor) {
        const dir = sort.dir === "asc" ? 1 : -1;
        out = [...out].sort((a, b) => dir * compare(col.accessor!(a), col.accessor!(b)));
      }
    }
    // Same rows in the same order as last time? Hand back the SAME array. The pass above has to re-run (its
    // accessors are fresh closures every render - see the note on the deferral), but a new array identity for
    // an unchanged result is what made everything downstream re-run with it: the bulk-selection prune effect,
    // `selectedRows`, and every consumer the table hands `filtered` to.
    const prev = lastFiltered.current;
    if (prev.length === out.length && prev.every((r, i) => r === out[i])) return prev;
    lastFiltered.current = out;
    return out;
    // `columns` is read for `hideValueByDefault` but is not listed: it is usually a fresh array per render,
    // and `colById` is derived from it, so it already changes whenever the columns really do.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- columns is covered by colById; see above
  }, [rows, deferredFilters, sort, colById, today]);

  // Hand the page the set it is drawing, for the callers that need to walk it (see `onVisibleRows`).
  React.useEffect(() => { onVisibleRows?.(filtered); }, [filtered, onVisibleRows]);

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
  // Where the last selection gesture landed, so shift-click knows what it is extending FROM.
  const selectAnchor = React.useRef<string | null>(null);
  const toggleOne = (id: string) => {
    selectAnchor.current = id;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  /**
   * Shift-click: select everything between the last click and this one, in the order the table is showing.
   *
   * The gesture every list in every other app has, and without it a queue of forty is selected forty clicks
   * at a time - which is the moment people give up on the bulk bar and start approving rows one by one.
   * It extends over `filtered`, not the page, so a range can span a page boundary the way the header's
   * select-all already spans one.
   */
  const extendSelection = (id: string) => {
    const ids = filtered.map(getRowId);
    const to = ids.indexOf(id);
    const from = selectAnchor.current ? ids.indexOf(selectAnchor.current) : -1;
    selectAnchor.current = id;
    if (to < 0 || from < 0) {
      toggleOne(id);
      return;
    }
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    setSelected((prev) => {
      const next = new Set(prev);
      for (let i = lo; i <= hi; i += 1) next.add(ids[i]!);
      return next;
    });
  };
  // The selection is re-read AFTER the confirm dialog, not captured before it.
  //
  // `selectedRows` is a render-time value, so an awaited modal freezes it: a background refetch (a sibling
  // tab's write, the change feed, a poll) can replace `filtered` while the dialog is open, and the effect
  // above that prunes rows which have since filtered out cannot run across the await. The action then ran
  // against the rows as they were when the dialog opened. The server re-authorizes every row, so this was
  // stale COPIES rather than forbidden rows - but a destructive bulk action should act on what is on screen
  // when it is confirmed, not on what was there when it was clicked.
  const liveSelection = React.useRef<T[]>(selectedRows);
  liveSelection.current = selectedRows;
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
    // Whatever is still selected now the dialog has closed. Empty means every selected row went away while it
    // was open, and running an action over nothing is not what the person confirmed.
    const rows = liveSelection.current;
    if (rows.length === 0) return;
    setBulkBusy(action.label);
    try {
      // Rows back = keep exactly those selected (a partial failure returns the ones that failed, so the retry
      // acts on them and no others); nothing back = done, clear it.
      const keep = await action.run(rows);
      setSelected(Array.isArray(keep) && keep.length ? new Set(keep.map(getRowId)) : new Set());
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

  // --- grouping ---------------------------------------------------------------------------------------------
  // One column's value splits the table into folds, each carrying its own count and its own subtotal for
  // every summed column. What it answers that a sort cannot: "which department is this going on", "how much
  // of this is Travel" - questions about the SET, which a sorted list makes you count by eye.
  const groupCol = groupBy ? colById[groupBy] : undefined;
  const groupable = React.useMemo(() => managed.filter((c) => c.groupBy && c.accessor), [managed]);
  const groupKeyOf = React.useCallback(
    (r: T) => (groupCol?.accessor ? String(groupCol.accessor(r) ?? "") : ""),
    [groupCol],
  );
  const groups = React.useMemo(() => {
    if (!groupCol?.accessor) return null;
    const buckets = new Map<string, T[]>();
    for (const r of filtered) {
      const k = groupKeyOf(r);
      const bucket = buckets.get(k);
      if (bucket) bucket.push(r);
      else buckets.set(k, [r]);
    }
    // Blank last: an "Unassigned" fold is a real group, but it is never the one being compared against.
    return [...buckets.entries()]
      .map(([key, rs]) => ({ key, label: key || "(Blank)", rows: rs }))
      .sort((a, b) => (a.key === "" ? 1 : b.key === "" ? -1 : compare(a.key, b.key)));
  }, [filtered, groupCol, groupKeyOf]);
  // A collapsed group's rows leave the paged set entirely, so folding one away shortens the table instead
  // of leaving a page of nothing. The footer totals and the export keep covering every filtered row - what
  // is folded is hidden, not excluded - and the pager says how many that is.
  const shown = React.useMemo(
    () => (groups ? groups.filter((g) => !collapsed.has(g.key)).flatMap((g) => g.rows) : filtered),
    [groups, collapsed, filtered],
  );
  const foldedAway = filtered.length - shown.length;
  // Drives the one control that folds or unfolds the lot. It reads the CURRENT groups rather than the size
  // of `collapsed`, which can still hold keys from a grouping the reader has since changed.
  const allFolded = !!groups && groups.length > 0 && groups.every((g) => collapsed.has(g.key));
  const foldAll = () => setCollapsed(allFolded ? new Set() : new Set((groups ?? []).map((g) => g.key)));

  const pageCount = pageSize > 0 ? Math.max(1, Math.ceil(shown.length / pageSize)) : 1;
  const safePage = Math.min(page, pageCount - 1);
  React.useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [safePage, page]);
  // Back to the first page whenever the result set or page size changes.
  React.useEffect(() => {
    setPage(0);
  }, [filters, sort, pageSize, groupBy]);
  const pageStart = pageSize > 0 ? safePage * pageSize : 0;
  const pageEnd = pageSize > 0 ? pageStart + pageSize : shown.length;
  const paged = pageSize > 0 ? shown.slice(pageStart, pageEnd) : shown;
  const from = shown.length === 0 ? 0 : pageStart + 1;
  const to = Math.min(shown.length, pageEnd);

  // What this page draws, in order: rows, with a group header wherever one opens. A header also leads a page
  // that starts mid-group (marked "continued"), because a fold's rows are unreadable without the name of the
  // fold they are in. A collapsed group is a header and nothing else, drawn at the position it holds.
  type RenderItem = { kind: "group"; key: string; label: string; rows: T[]; collapsed: boolean; continued: boolean } | { kind: "row"; row: T };
  const renderItems = React.useMemo<RenderItem[]>(() => {
    if (!groups) return paged.map((row) => ({ kind: "row" as const, row }));
    const items: RenderItem[] = [];
    let offset = 0;
    for (const g of groups) {
      const isCollapsed = collapsed.has(g.key);
      const start = offset;
      const end = start + (isCollapsed ? 0 : g.rows.length);
      offset = end;
      if (isCollapsed) {
        // A zero-height group sits on a boundary; it belongs to the page whose window contains it, and to
        // the last page when it trails the final row.
        const onPage = (start >= pageStart && start < pageEnd) || (start === pageEnd && pageEnd >= shown.length);
        if (onPage) items.push({ kind: "group", key: g.key, label: g.label, rows: g.rows, collapsed: true, continued: false });
        continue;
      }
      const sliceStart = Math.max(start, pageStart);
      const sliceEnd = Math.min(end, pageEnd);
      if (sliceEnd <= sliceStart) continue;
      items.push({ kind: "group", key: g.key, label: g.label, rows: g.rows, collapsed: false, continued: sliceStart > start });
      for (const row of g.rows.slice(sliceStart - start, sliceEnd - start)) items.push({ kind: "row", row });
    }
    return items;
  }, [groups, collapsed, paged, pageStart, pageEnd, shown.length]);
  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // --- totals ----------------------------------------------------------------------------------------------
  // Summed over the FILTERED rows, not the visible page: a total that changed when you turned the page would
  // answer a question nobody asked.
  //
  // The rows are still one server page on a truncated collection, and every column that uses this is money -
  // so the figure is marked with the same `+` and the same word ("loaded") the pager, the export button and
  // the empty state already use. A partial sum printed as "Total", exact row count beside it, is the number
  // that gets read out in a meeting while the pager two lines below says the set is bigger than that.
  const sumCols = React.useMemo(() => columns.filter((c) => c.aggregate), [columns]);
  // `null` when the kind has nothing to report: no rows, or none of them carrying a value. The callers then
  // print nothing rather than a "0" that reads as a measured zero.
  const sumOf = React.useCallback((rs: T[], col: Column<T>): number | null => {
    if (col.aggregate === "sum") return rs.reduce((n, r) => n + (Number(col.accessor?.(r)) || 0), 0);
    const nums: number[] = [];
    for (const r of rs) {
      const v = col.accessor?.(r);
      if (v == null || v === "") continue;
      const n = Number(v);
      if (Number.isFinite(n)) nums.push(n);
    }
    if (col.aggregate === "count") return nums.length;
    if (nums.length === 0) return null;
    if (col.aggregate === "avg") return nums.reduce((a, b) => a + b, 0) / nums.length;
    if (col.aggregate === "min") return Math.min(...nums);
    if (col.aggregate === "max") return Math.max(...nums);
    return null;
  }, []);
  // A bare number is only unambiguous for a sum, which is what every table did before the other kinds
  // existed. The rest say which question they answer, in one word, or the footer is a row of numbers whose
  // meaning depends on remembering the column's declaration.
  const AGG_PREFIX: Record<NonNullable<Column<T>["aggregate"]>, string> = { sum: "", avg: "avg ", min: "min ", max: "max ", count: "" };
  const fmtTotal = (col: Column<T>, n: number | null): React.ReactNode => {
    if (n === null) return null;
    // A count is a number of ROWS, so the column's own formatter (money, days) would mislabel it.
    if (col.aggregate === "count") return `${n} set`;
    const rounded = col.aggregate === "avg" ? Math.round(n * 10) / 10 : n;
    return `${AGG_PREFIX[col.aggregate ?? "sum"]}${col.formatTotal ? String(col.formatTotal(rounded)) : String(rounded)}`;
  };
  // Only a sum keeps growing as more pages load, so only a sum is marked "+" when the set is truncated. An
  // average or a max over a window is not a partial figure, it is a figure about the window.
  const aggGrows = (col: Column<T>) => col.aggregate === "sum" || col.aggregate === "count";
  // A fold's share of the whole, printed beside its subtotal. Only for a SUM, where the parts add up to the
  // total and the share is therefore a fact rather than an arithmetic accident, and only once there is more
  // than one fold, because "100%" beside the only group is noise. "Which cost centre is this going on" is
  // the question grouping a money table is asked, and it is a proportion, not an amount.
  const groupShare = (rowsInGroup: T[], col: Column<T>): string | null => {
    if (col.aggregate !== "sum" || (groups?.length ?? 0) < 2) return null;
    const whole = sumOf(filtered, col) ?? 0;
    const part = sumOf(rowsInGroup, col) ?? 0;
    if (whole === 0 || part === 0) return null;
    const pct = (part / whole) * 100;
    return `${pct < 1 ? "<1" : Math.round(pct)}%`;
  };
  const showTotals = sumCols.length > 0 && filtered.length > 0;

  function toggleSort(col: Column<T>) {
    if (col.sortable === false || !col.accessor) return;
    setSort((s) =>
      !s || s.id !== col.id ? { id: col.id, dir: "asc" } : s.dir === "asc" ? { id: col.id, dir: "desc" } : null
    );
  }

  // --- what one column holds, for its filter panel ----------------------------------------------------------
  // Counted against the rows every OTHER filter leaves standing, not against all of them. On a table already
  // narrowed to one department, "Status: Rejected 41" would be counting somebody else's rejections, and
  // picking it would land on an empty table. Cross-filtered, the counts are a preview of the click.
  const rowsExcept = React.useCallback(
    (colId: string) => {
      let out = rows;
      for (const col of Object.values(colById)) {
        if (col.hideValueByDefault && col.accessor && col.id !== colId && !filters[col.id]) {
          out = out.filter((r) => String(col.accessor!(r) ?? "") !== col.hideValueByDefault);
        }
      }
      for (const [id, value] of Object.entries(filters)) {
        if (!value || id === colId) continue;
        const col = colById[id];
        if (!col?.accessor) continue;
        out = out.filter((r) => matchesFilter(col.filter ?? "text", value, col.accessor!(r), today));
      }
      return out;
    },
    [rows, colById, filters, today],
  );

  function valueCounts(col: Column<T>): { options: SelectOption[]; blank: number; total: number } {
    const base = rowsExcept(col.id);
    const counts = new Map<string, number>();
    let blank = 0;
    for (const r of base) {
      const v = col.accessor?.(r);
      const s = v == null ? "" : String(v);
      if (s === "") blank += 1;
      else counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    // A declared option with no loaded rows still belongs on the list (the trash, an unused category); it
    // reads as the empty drawer it is rather than being missing.
    for (const v of col.filterOptions ?? []) if (!counts.has(v)) counts.set(v, 0);
    return {
      options: [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => a.value.localeCompare(b.value)),
      blank,
      total: base.length,
    };
  }

  const columnNumberStats = (col: Column<T>) =>
    numberStats(rowsExcept(col.id).map((r) => Number(col.accessor?.(r))));
  /** How a figure from this column reads - the column's own money/day formatter where it has one. */
  const fmtNumber = (col: Column<T>) => (n: number) => (col.formatTotal ? String(col.formatTotal(n)) : String(Math.round(n * 100) / 100));

  /** The filter panel for one column, shared by the desktop header popover and the phone sheet. */
  const filterPanel = (col: Column<T>) => {
    const value = filters[col.id] ?? "";
    const set = (next: string) => setFilters((f) => ({ ...f, [col.id]: next }));
    if (col.filter === "number") return <NumberFilterPanel value={value} stats={columnNumberStats(col)} fmt={fmtNumber(col)} onChange={set} />;
    if (col.filter === "date") return <DateFilterPanel value={value} hint={col.dateHint} onChange={set} />;
    if (col.filter === "select") {
      const { options, blank, total: n } = valueCounts(col);
      return <SelectFilterPanel options={options} value={value} total={n} blankCount={blank} onPick={set} />;
    }
    return (
      <div className="flex items-center gap-1.5">
        <Input
          autoFocus
          value={value}
          placeholder={`Search ${col.header.toLowerCase()}`}
          onChange={(e) => set(e.target.value)}
          className="h-8"
        />
        {value && (
          <Button variant="ghost" size="icon" aria-label={`Clear the ${col.header.toLowerCase()} filter`} className="h-8 w-8 shrink-0" onClick={() => set("")}>
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
    );
  };

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

  // --- cell menu --------------------------------------------------------------------------------------------
  // Right-click a cell and the table offers what can be done WITH THAT VALUE, read off the column: an amount
  // offers "above this" and "below this", a day offers "before"/"after"/"that month", a status offers only
  // itself and its opposite. The alternative is the route everyone takes today - open the column's filter
  // popover, retype a value that is already on screen, hope it matches - and the retyping is where it goes
  // wrong on exactly the columns (a name with an initial, a code, an amount) where it matters.
  const [cellMenu, setCellMenu] = React.useState<{ x: number; y: number; colId: string; raw: string; row: T } | null>(null);
  const openCellMenu = (col: Column<T>, row: T) => (e: React.MouseEvent) => {
    if (!col.accessor || col.filter === "none") return;
    // A right-click inside a field is the browser's, not ours: cut/paste/spellcheck on an input in a cell
    // is the menu the person is asking for there.
    const t = e.target as HTMLElement | null;
    if (t?.closest("input, textarea, [contenteditable='true']")) return;
    e.preventDefault();
    setCellMenu({ x: e.clientX, y: e.clientY, colId: col.id, raw: String(col.accessor(row) ?? ""), row });
  };
  const menuCol = cellMenu ? colById[cellMenu.colId] : undefined;
  const applyFilter = (id: string, v: string) => {
    setFilters((f) => ({ ...f, [id]: v }));
    setCellMenu(null);
  };
  const cellMenuItems = () => {
    if (!cellMenu || !menuCol) return null;
    const { raw, colId } = cellMenu;
    const kind = menuCol.filter ?? "text";
    const day = raw.slice(0, 10);
    const fmt = fmtNumber(menuCol);
    const shown = raw.length > 32 ? `${raw.slice(0, 32)}…` : raw;
    return (
      <>
        <DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground">
          {menuCol.header}: <span className="font-medium text-foreground">{raw === "" ? "(blank)" : shown}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {raw === "" ? (
          <>
            <DropdownMenuItem onSelect={() => applyFilter(colId, BLANK)}><Filter /> Only blanks</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => applyFilter(colId, `!${BLANK}`)}><Ban /> Hide blanks</DropdownMenuItem>
          </>
        ) : kind === "number" ? (
          <>
            <DropdownMenuItem onSelect={() => applyFilter(colId, `=${Number(raw)}`)}><Filter /> Exactly {fmt(Number(raw))}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => applyFilter(colId, `>${Number(raw)}`)}><ArrowUp /> More than {fmt(Number(raw))}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => applyFilter(colId, `<${Number(raw)}`)}><ArrowDown /> Less than {fmt(Number(raw))}</DropdownMenuItem>
          </>
        ) : kind === "date" ? (
          <>
            <DropdownMenuItem onSelect={() => applyFilter(colId, day)}><Filter /> Only {day}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => applyFilter(colId, `..${day}`)}><ArrowUp /> On or before</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => applyFilter(colId, `${day}..`)}><ArrowDown /> On or after</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => applyFilter(colId, day.slice(0, 7))}><Filter /> That month</DropdownMenuItem>
          </>
        ) : (
          <>
            <DropdownMenuItem onSelect={() => applyFilter(colId, raw)}><Filter /> Show only these</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => applyFilter(colId, `!${raw}`)}><Ban /> Exclude these</DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        {menuCol.sortable !== false && (
          <DropdownMenuItem onSelect={() => { setSort({ id: colId, dir: "asc" }); setCellMenu(null); }}>
            <ArrowUp /> Sort {kind === "number" || kind === "date" ? "low to high" : "A to Z"}
          </DropdownMenuItem>
        )}
        {menuCol.sortable !== false && (
          <DropdownMenuItem onSelect={() => { setSort({ id: colId, dir: "desc" }); setCellMenu(null); }}>
            <ArrowDown /> Sort {kind === "number" || kind === "date" ? "high to low" : "Z to A"}
          </DropdownMenuItem>
        )}
        {menuCol.groupBy && (
          <DropdownMenuItem onSelect={() => { setGroupBy(groupBy === colId ? "" : colId); setCellMenu(null); }}>
            <Layers /> {groupBy === colId ? "Ungroup" : `Group by ${menuCol.header.toLowerCase()}`}
          </DropdownMenuItem>
        )}
        {/* Where the column says so, the value is also a way OUT of this table: a person's name leads to their
            leave, their assets, their tickets. Without this the reader copies the name, opens the other page
            and types it into a search box - and the twenty tables in this app stay twenty separate lists. */}
        {(menuCol.actions?.(cellMenu.row) ?? []).length > 0 && <DropdownMenuSeparator />}
        {(menuCol.actions?.(cellMenu.row) ?? []).map((a) => (
          <DropdownMenuItem key={a.label} onSelect={() => { setCellMenu(null); a.onSelect(); }}>
            {a.icon ?? <ExternalLink />} {a.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            setCellMenu(null);
            navigator.clipboard
              .writeText(raw)
              .then(() => toast({ title: "Copied", description: raw.length > 60 ? `${raw.slice(0, 60)}…` : raw }))
              .catch(() => {});
          }}
        >
          <Copy /> Copy value
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            setHidden((prev) => new Set(prev).add(colId));
            setCellMenu(null);
          }}
        >
          <EyeOff /> Hide this column
        </DropdownMenuItem>
      </>
    );
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
              onClick={(e) => {
                e.stopPropagation();
                if (!e.shiftKey) return;
                e.preventDefault();
                extendSelection(id);
              }}
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
  // `/` puts the cursor in this table's search box - the shortcut the help sheet already advertises as
  // "search within the page", which until now only the feed implemented.
  const searchRef = React.useRef<HTMLInputElement | null>(null);
  const hasSearch = !!search;
  const slashToken = React.useRef<symbol>(Symbol("table-search"));
  React.useEffect(() => {
    if (!hasSearch) return;
    const token = slashToken.current;
    slashOwners.push(token);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (slashOwners[0] !== token) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      // An open overlay owns the keyboard, exactly as the global shortcut layer treats it.
      if (document.querySelector('[role="dialog"][data-state="open"], [role="listbox"][data-state="open"], [role="menu"][data-state="open"]')) return;
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const at = slashOwners.indexOf(token);
      if (at >= 0) slashOwners.splice(at, 1);
    };
  }, [hasSearch]);

  const searchControl = search && (
    // Full width on a phone: search is the main way to find a row when the table is a card list, and a 208px
    // box next to nothing looks (and reads) like an afterthought.
    <div className="relative w-full sm:w-auto">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={searchRef}
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
      {activeFilters.map(([id, v]) => {
        const col = colById[id];
        return (
          <span key={id} className="inline-flex items-center gap-1 rounded-full bg-accent px-2.5 py-1 text-xs font-medium text-accent-foreground">
            {/* Read back through the column's own grammar: ">5000" on a money column is a chip that says
                "Amount: > ₹5,000", and an excluded value says so rather than showing a bare "!". */}
            {col?.header}: {col ? filterChipLabel(col.filter ?? "text", v, fmtNumber(col)) : v}
            <button onClick={() => setFilters((f) => ({ ...f, [id]: "" }))} className="hover:text-foreground" aria-label={`Clear the ${col?.header ?? id} filter`}><X className="h-3 w-3" /></button>
          </span>
        );
      })}
      {groupCol && (
        <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
          <Layers className="h-3 w-3" /> Grouped by {groupCol.header}
          <button onClick={() => setGroupBy("")} className="hover:text-foreground" aria-label="Ungroup the table"><X className="h-3 w-3" /></button>
        </span>
      )}
      {/* Fold the lot at once. Next to the grouping chip because that is where the reader is told the table
          is grouped, and the per-group chevrons are too far down to serve a table with twenty folds. */}
      {groupCol && (groups?.length ?? 0) > 1 && (
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={foldAll}>
          {allFolded ? <ChevronsUpDown className="h-3 w-3" /> : <ChevronsDownUp className="h-3 w-3" />}
          {allFolded ? "Expand all" : "Collapse all"}
        </Button>
      )}
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
      groupBy,
      // The shape as well as the rows: applying a view should give back the table the way it was saved,
      // not that layout poured into whatever column order and density the reader happens to be on.
      order: orderedManaged,
      widths,
      pageSize,
      density,
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
    // Same rule for grouping: a view that predates it says nothing, and silence is not "ungroup".
    if (v === null) setGroupBy(defaultGroupByRef.current ?? "");
    else if (typeof v.groupBy === "string") setGroupBy(v.groupBy);
    // The shape, on the same "silence is not an instruction" rule. "Default" is about which rows and
    // columns the table shows, so it leaves order, widths, page size and density alone: those are how this
    // reader likes the table, not part of the narrowing being reset.
    if (v) {
      if (v.order) setOrder(v.order);
      if (v.widths) setWidths(v.widths);
      if (typeof v.pageSize === "number") setPageSize(v.pageSize);
      if (v.density) setDensity(v.density);
    }
    setCollapsed(new Set());
    // Legacy views saved before the search box was captured carry no `search`, and clearing on their behalf is
    // a claim they never made: applying one - which happens unprompted on mount, for a pinned default - wiped
    // whatever the page had seeded into its own search box. `undefined` means "this view says nothing about
    // search"; an empty string means "this view searched for nothing", and only that clears it.
    if (v === null || v.search !== undefined) search?.onChange(v?.search ?? "");
  };
  const toggleDefaultView = (name: string) =>
    setViews((vs) => vs.map((v) => (v.name === name ? { ...v, isDefault: !v.isDefault } : { ...v, isDefault: false })));

  // Which view the table is currently showing. The one the user picked wins as long as the live state still
  // matches its snapshot, so it clears itself the moment they tweak a filter away from it - and two views
  // that happen to capture the same state stay distinguishable (matching alone would always name the first).
  //
  // Matched on which rows and columns are shown, NOT on the shape a view also carries: dragging a column
  // wider or switching to compact does not put you on a different view, and making it do so would drop the
  // view's name off the table for a change that moved no rows.
  const viewMatches = (v: SavedView) =>
    JSON.stringify(nonEmpty(v.filters)) === filtersKey &&
    (v.sort ?? "") === sortKey &&
    (!v.hidden || [...v.hidden].sort().join(",") === hiddenKey) &&
    (v.groupBy === undefined || v.groupBy === groupBy) &&
    (!search || (v.search ?? "") === search.value);
  const picked = views.find((v) => v.name === pickedView) ?? null;
  const activeView = picked && viewMatches(picked) ? picked : (views.find(viewMatches) ?? null);
  const onBaseline =
    !activeView &&
    !sort &&
    filtersKey === JSON.stringify(nonEmpty(baseline().filters)) &&
    hiddenKey === [...baseline().hidden].sort().join(",") &&
    groupBy === (defaultGroupBy ?? "") &&
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
              : "A view restores its filters, sort, grouping, search and columns. Star one to open the table with it."}
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
          {groupable.length > 0 && (
            <div className="mt-2 space-y-1 border-t pt-2">
              <span className="text-xs font-semibold text-muted-foreground">Group by</span>
              <Select value={groupBy || "__none__"} onValueChange={(v) => setGroupBy(v === "__none__" ? "" : v)}>
                <SelectTrigger className="h-8" aria-label="Group rows by a column">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No grouping</SelectItem>
                  {groupable.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.header}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
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

          {groupable.length > 0 && (
            <section className="space-y-1.5">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Group</h4>
              <Select value={groupBy || "__none__"} onValueChange={(v) => setGroupBy(v === "__none__" ? "" : v)}>
                <SelectTrigger aria-label="Group rows by a column">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No grouping</SelectItem>
                  {groupable.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.header}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </section>
          )}

          {filterableCols.length > 0 && (
            <section className="space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Filter</h4>
              {/* The same panels the desktop header popovers use, laid out flat: a phone has no column
                  headers to hang a popover off, and a filter that reads differently on the two surfaces is
                  two filters to learn. Folded shut past the first few so the sheet opens on something
                  scannable rather than on a wall of every column's values. */}
              {filterableCols.map((col) => {
                const value = filters[col.id] ?? "";
                return (
                  <details key={col.id} open={!!value} className="rounded-lg border px-3 py-2">
                    <summary className="flex cursor-pointer items-center justify-between gap-2 text-sm font-medium">
                      <span>{col.header}</span>
                      <span className="truncate text-xs font-normal text-muted-foreground">
                        {value ? filterChipLabel(col.filter ?? "text", value, fmtNumber(col)) : "Any"}
                      </span>
                    </summary>
                    <div className="pt-2">{filterPanel(col)}</div>
                  </details>
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
  //
  // Per TABLE, not app-wide: the table's own collection is passed, so `export.<collection>.read` lights up
  // this table alone while the broad `export.read` still covers every one. Exporting payroll and exporting
  // the holiday list were the same switch, which meant the safe half could not be granted without the other.
  const canExport = useCanExport(accessCollection);
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

  // --- insights ---------------------------------------------------------------------------------------------
  // Computed over every LOADED row rather than the filtered set, so a chip's figure holds still once its own
  // filter is applied - a strip whose numbers all collapsed to "1" the moment you used it would be unreadable
  // and, worse, would look like the rows had gone.
  const insightList = insights ? insights(rows) : [];
  const insightActive =
    insightList.find((i) => i.filters && Object.entries(i.filters).every(([k, v]) => (filters[k] ?? "") === v))?.id ?? null;
  /**
   * Put the table on a named narrowing - an insight chip, a scope chip.
   *
   * Applied over the table's OWN defaults, not over whatever is currently filtered: a chip says "these
   * seven", and landing on the intersection of it with somebody's half-finished filter would show fewer than
   * it promised. `undo` is the press that takes it off again, which lands back on those same defaults.
   */
  const applyPreset = (preset: { filters?: Record<string, string>; sort?: string }, undo: boolean) => {
    setPage(0);
    setFilters(undo ? baseline().filters : { ...baseline().filters, ...preset.filters });
    if (preset.sort) setSort(undo ? null : parseUrlSort(preset.sort));
  };
  const applyInsight = (i: TableInsight, undo: boolean) => {
    if (i.onClick) {
      i.onClick();
      return;
    }
    applyPreset(i, undo);
  };

  // --- scopes -----------------------------------------------------------------------------------------------
  // Which scope the table is showing: the one whose filters the live state matches. Read rather than stored,
  // exactly like the active insight, so a scope survives a reload, travels in a deep link and clears itself
  // the moment somebody edits a filter away from it - none of which a remembered "current tab" could do.
  const scopeList = scopes ?? [];
  const scopeActive = scopeList.find((s) => Object.entries(s.filters).every(([k, v]) => (filters[k] ?? "") === v))?.id ?? null;
  // The opening scope, applied once and only where the reader asked for nothing more specific: a deep link
  // carries its own filters and is the more specific request, the same rule the pinned default view follows.
  // Applied once, and not before the rows are in. A page works its opening scope out FROM its rows ("land an
  // assignee on their queue when something is open there"), so deciding it on the empty first render would
  // land everybody on the fallback and then leave them there - the answer arrives a moment later and the
  // reader has already been put somewhere.
  const scopeApplied = React.useRef(false);
  React.useEffect(() => {
    if (scopeApplied.current || !defaultScope || scopeList.length === 0 || rows.length === 0) return;
    scopeApplied.current = true;
    if (urlInitial.current?.f) return;
    const opening = scopeList.find((s) => s.id === defaultScope);
    if (opening && Object.keys(opening.filters).length > 0) applyPreset(opening, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultScope, scopeList.length, rows.length]);

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

      {/* Whose rows, then what is worth noticing about them - in that order, because the scope decides which
          rows the insights below are even about. */}
      {scopeList.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {scopeList.map((s) => (
            <FilterChip
              key={s.id}
              active={scopeActive === s.id}
              count={s.count}
              title={s.title}
              onClick={() => applyPreset(s, scopeActive === s.id && Object.keys(s.filters).length > 0)}
            >
              {s.label}
              {s.badge}
            </FilterChip>
          ))}
        </div>
      )}

      {insightList.length > 0 && <TableInsights insights={insightList} activeId={insightActive} onApply={applyInsight} />}

      {/* Bulk bar: appears with the first selected row.
          Desktop - sticky under the toolbar, so it stays reachable while scrolling a long table.
          Phone - docked at the foot of the viewport instead, clear of the home indicator. Selecting rows on
          a phone means scrolling a card list, and a bar stuck to the TOP of that list is off screen by the
          third selection; docked at the bottom it stays exactly where the selecting thumb already is. */}
      {bulkActions && selected.size > 0 && (
        <div
          className={cn(
            "z-20 flex items-center gap-2 rounded-lg border border-primary/30 bg-card px-3 py-2 shadow-pop",
            "fixed inset-x-3 bottom-[calc(1.25rem+env(safe-area-inset-bottom))] flex-wrap",
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
                <span className="uppercase tracking-wide text-muted-foreground">
                  Total · {total}{truncated ? "+" : ""} row{total === 1 ? "" : "s"}{truncated ? " loaded" : ""}
                </span>
                {sumCols.map((col) => (
                  <span key={col.id} className="font-medium tabular-nums">{col.header}: {fmtTotal(col, sumOf(filtered, col))}{truncated && aggGrows(col) ? "+" : ""}</span>
                ))}
              </div>
            )}
            {renderItems.flatMap((item) => {
              if (item.kind === "group") {
                return [
                  <button
                    key={`g:${item.key}`}
                    type="button"
                    onClick={() => toggleGroup(item.key)}
                    aria-expanded={!item.collapsed}
                    className="flex w-full items-center gap-1.5 rounded-lg bg-muted/70 px-3 py-2 text-left text-sm font-semibold"
                  >
                    <ChevronRight className={cn("h-4 w-4 shrink-0 transition-transform", !item.collapsed && "rotate-90")} />
                    <span className="truncate">{item.label}</span>
                    <span className="font-normal text-muted-foreground">{item.rows.length}</span>
                    <span className="min-w-2 flex-1" />
                    {sumCols.map((col) => (
                      <span key={col.id} className="shrink-0 text-xs font-medium tabular-nums">
                        {fmtTotal(col, sumOf(item.rows, col))}
                        {groupShare(item.rows, col) && <span className="ml-1 font-normal text-muted-foreground">{groupShare(item.rows, col)}</span>}
                      </span>
                    ))}
                  </button>,
                ];
              }
              return [
                renderMobileCard(item.row, false),
                // Children are always visible on phone: cards carry no fold chevron.
                ...(getSubRows?.(item.row) ?? []).map((k) => renderMobileCard(k, true)),
              ];
            })}
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
                          <PopoverContent
                            align={col.align === "right" ? "end" : "start"}
                            className={col.filter === "number" || col.filter === "date" ? "w-64" : undefined}
                          >
                            <div className="space-y-2">
                              <p className="text-xs font-semibold text-muted-foreground">Filter by {col.header}</p>
                              {filterPanel(col)}
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
              renderItems.flatMap((item) => {
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
                        // j/k alongside ↑/↓ because the shortcut sheet already promises them for a queue,
                        // and x to select without reaching for the checkbox - the three keys that make a
                        // long approval queue workable from the keyboard alone.
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onRowClick(r);
                        } else if (e.key === "ArrowDown" || e.key === "j") {
                          e.preventDefault();
                          focusSiblingRow(e.currentTarget, 1);
                        } else if (e.key === "ArrowUp" || e.key === "k") {
                          e.preventDefault();
                          focusSiblingRow(e.currentTarget, -1);
                        } else if (e.key === "x" && bulkActions) {
                          e.preventDefault();
                          toggleOne(getRowId(r));
                        }
                      },
                    })}
                  >
                    {renderCols.map((col) => (
                      <TableCell
                        key={col.id}
                        style={widthStyle(col.id)}
                        onContextMenu={col.accessor && col.filter !== "none" ? openCellMenu(col, r) : undefined}
                        className={cn(
                          "truncate",
                          // Right-aligned columns are numeric by convention; tabular-nums keeps digits in
                          // vertical register down the column so values are scannable.
                          col.align === "right" && "text-right tabular-nums",
                          col.align === "center" && "text-center",
                          // Indent a child's first data column so it reads as nested under its parent.
                          isChild && col.id === firstDataColId && "pl-8",
                          col.bar && "relative", // the proportion is drawn against the cell box
                          col.className
                        )}
                      >
                        {col.bar && <CellBar value={col.bar(r)} />}
                        {col.id === "__select__" ? (
                          !isChild && (
                            <Checkbox
                              checked={selected.has(getRowId(r))}
                              onCheckedChange={() => toggleOne(getRowId(r))}
                              // Shift-click runs INSTEAD of the toggle: Radix composes our handler ahead of
                              // its own and skips its own once the event is defaulted-prevented.
                              onClick={(e) => {
                                e.stopPropagation();
                                if (!e.shiftKey) return;
                                e.preventDefault();
                                extendSelection(getRowId(r));
                              }}
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
                if (item.kind === "group") {
                  const groupSelected = bulkActions ? item.rows.every((r) => selected.has(getRowId(r))) : false;
                  return [
                    <TableRow key={`g:${item.key}`} className="border-y bg-muted/70 hover:bg-muted/70">
                      <TableCell colSpan={renderCols.length} className="py-1.5">
                        <div className="flex items-center gap-2">
                          {bulkActions && (
                            <Checkbox
                              checked={groupSelected}
                              aria-label={`Select every row in ${item.label}`}
                              onCheckedChange={() =>
                                setSelected((prev) => {
                                  const next = new Set(prev);
                                  for (const r of item.rows) {
                                    if (groupSelected) next.delete(getRowId(r));
                                    else next.add(getRowId(r));
                                  }
                                  return next;
                                })
                              }
                            />
                          )}
                          <button
                            type="button"
                            onClick={() => toggleGroup(item.key)}
                            aria-expanded={!item.collapsed}
                            className="inline-flex min-w-0 items-center gap-1.5 text-sm font-semibold hover:text-primary"
                          >
                            <ChevronRight className={cn("h-4 w-4 shrink-0 transition-transform", !item.collapsed && "rotate-90")} />
                            <span className="truncate">{item.label}</span>
                            <span className="shrink-0 font-normal text-muted-foreground">
                              {item.rows.length}
                              {item.continued ? " · continued" : ""}
                            </span>
                          </button>
                          <div className="min-w-4 flex-1" />
                          {/* A fold's own subtotals, on the fold. Grouping a money table by cost centre and
                              still having to add the column up by hand would be the whole point missed. */}
                          {sumCols.map((col) => (
                            <span key={col.id} className="shrink-0 text-xs tabular-nums text-muted-foreground">
                              {col.header}: <span className="font-medium text-foreground">{fmtTotal(col, sumOf(item.rows, col))}</span>
                              {groupShare(item.rows, col) && <span className="ml-1">{groupShare(item.rows, col)}</span>}
                            </span>
                          ))}
                        </div>
                      </TableCell>
                    </TableRow>,
                  ];
                }
                const row = item.row;
                const kids = getSubRows?.(row);
                const open = kids && kids.length > 0 && expanded.has(getRowId(row));
                return open ? [renderRow(row, false), ...kids!.map((k) => renderRow(k, true))] : [renderRow(row, false)];
              })
            )}
          </TableBody>
          {showTotals && (
            <TableFooter>
              <TableRow className="hover:bg-transparent">
                {/* The label goes in the first DATA column, not `i === 0`: `renderCols` prepends up to three
                    1px gutter columns (select, access, expand), so on a table with both totals and bulk
                    actions "Total · N rows" landed in the checkbox column - and `truncate` (white-space:
                    nowrap) then forced its min-content width onto that whole column. The gutters' own
                    `className` is applied here too, so they stay 1px whatever the footer holds. */}
                {renderCols.map((col) => (
                  <TableCell
                    key={col.id}
                    style={widthStyle(col.id)}
                    className={cn("truncate text-xs", col.className, col.align === "right" && "text-right tabular-nums", col.align === "center" && "text-center")}
                  >
                    {col.aggregate ? (
                      <>{fmtTotal(col, sumOf(filtered, col))}{truncated && aggGrows(col) ? "+" : ""}</>
                    ) : col.id === totalLabelColId ? (
                      <span className="uppercase tracking-wide text-muted-foreground">
                        Total · {total}{truncated ? "+" : ""} row{total === 1 ? "" : "s"}{truncated ? " loaded" : ""}
                      </span>
                    ) : null}
                  </TableCell>
                ))}
              </TableRow>
            </TableFooter>
          )}
        </Table>
      </Card>
      )}
      {/* The cell menu, anchored at the pointer. One menu for the whole table, positioned rather than one
          per cell - fifty rows of ten columns is five hundred menus nobody has opened. */}
      <DropdownMenu open={!!cellMenu} onOpenChange={(o) => !o && setCellMenu(null)}>
        <DropdownMenuTrigger asChild>
          {/* Focusable but not tabbable, and NOT aria-hidden: Radix returns focus here when the menu
              closes, and focusing an aria-hidden element is the one thing that would make this a barrier
              rather than an invisible anchor. */}
          <span tabIndex={-1} className="pointer-events-none fixed" style={{ left: cellMenu?.x ?? 0, top: cellMenu?.y ?? 0 }} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">{cellMenuItems()}</DropdownMenuContent>
      </DropdownMenu>

      <div className="flex flex-wrap items-center justify-between gap-3 px-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-2">
          <span>
            {shown.length === 0 ? "No records" : `Showing ${from}-${to} of ${truncated ? `${shown.length}+` : shown.length}`}
            {/* Folded groups are hidden, not filtered out: the totals and the export still cover them, so
                the pager has to say they are there rather than letting the count read as a loss of rows. */}
            {foldedAway > 0 ? ` (+${foldedAway} in folded groups)` : ""}
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

