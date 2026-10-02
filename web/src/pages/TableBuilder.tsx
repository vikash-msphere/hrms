import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown, ArrowUp, BarChart3, ChevronRight, Columns3, Copy, ExternalLink, Filter, GripVertical, Link2,
  Lock, Plus, RefreshCw, Rows3, Sigma, Sparkles, Table2, Trash2, Pencil, Search, X,
} from "lucide-react";
import { api, create, get, patch, remove } from "@/api";
import { navigate, useRoute, setQueryParams } from "@/router";
import { cn, formatDate, formatMonthYear, humanize, idOf } from "@/lib/utils";
import { useMoney } from "@/lib/org";
import { usePermission } from "@/lib/perm";
import { useCollection } from "@/hooks/useCollection";
import { useIntent } from "@/lib/intent";
import { useAiFeature } from "@/lib/aiFeatures";
import { useKpiFocus, type FocusSpec } from "@/lib/kpiFocus";
import { resourceRoute, opensExactRecord } from "@/lib/resourceRoute";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";
import { useDeletedToast } from "@/hooks/useSoftDelete";
import type {
  Department, Me, PayPeriod, TableCatalogue, TableField, TableFieldKind, TableLink, TableRunColumn,
  TableRunResult, TableRunRow, TableView,
} from "@/types";
import { DataTable, type Column } from "@/components/common/DataTable";
import type { TableInsight } from "@/components/common/TableInsights";
import { daysSince, fmtDaysCount } from "@/lib/tableDerive";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/common/PageHeader";
import { RowsSkeleton } from "@/components/common/Skeletons";
import { SummaryStrip, type SummaryItem } from "@/components/common/SummaryStrip";
import { Chart, ChartCard } from "@/components/common/Chart";
import { RowActions } from "@/components/common/RowActions";
import { WriteDialog } from "@/components/common/WriteDialog";
import { Field } from "@/components/common/Field";
import { AccessAction } from "@/components/access/AccessAction";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

// Custom tables: pick a base ("one row is a person", "one row is a ticket"), pick fields from anywhere the
// server will let you see, and you have a grid you can name, keep, share and export.
//
// The page holds NO rules. The field picker only ever shows what `GET /v1/table-fields` offered, and the rows
// come from `:run`, which re-reads every source under the reader's own access. So opening somebody else's
// table shows YOUR rows, and any column you are not entitled to arrives in `dropped` with the reason instead
// of as an empty column pretending there was nothing there.

// How many rows one table will follow the cursor for. A report is read to the end - a salary sheet is
// useless as a 100-row window - but a grid is still a screen, not a bulk extract: past this the answer is a
// filter, or a narrower base, not another page.
// When a saved table stops being in use and starts being clutter. A quarter: long enough that a table built
// for one quarterly review is not called stale the week after it was used.
const STALE_VIEW_DAYS = 90;
const ROW_CEILING = 5000;

// ONE PAGE IS NOT ONE SCREENFUL OF ROWS, and reading it as though it were is what made a working filter look
// like an empty report.
//
// The runner pushes into SQL only the filters it can - a plain base column, inside the statement's bound-
// parameter budget - and applies the rest over the page AFTER the cursor has cut it (services/tableRun.ts).
// Every filter on a linked column or on a source field (`@comp.*`, `@identity.*`, `@personal.*`, `@bank.*`) is
// in that second half, which is most of what a report filters by. So a page legitimately comes back short, or
// empty, while `next_page_token` still names more: the matching rows are simply further down the cursor.
//
// Stopping at the first page therefore rendered "No rows - nothing you can see matches this table yet" for a
// filter matching plenty, understated the count in the title, and exported the window rather than the report.
// A load follows the cursor until it has a screenful or the report ends.
//
// Bounded twice, because the loop must not become a way to walk a collection: `PAGE_TARGET` is the screenful
// that hands back to the explicit "Load more", and `MAX_PAGES_PER_LOAD` caps the requests ONE load may spend
// when a filter matches almost nothing - the grid then honestly says there is more, instead of paging on by
// itself. ROW_CEILING still bounds the whole table.
const PAGE_TARGET = 100;
const MAX_PAGES_PER_LOAD = 20;

// The server's own caps on a saved spec: `MAX_FILTERS` in domain/tableFields.ts, and the four that
// `cleanSort` slices to. Said here so the editor stops at the same place the API does, rather than offering a
// control whose result is a 400.
const MAX_FILTERS = 24;
const MAX_SORTS = 4;

type ViewSpec = {
  columns: { field: string; label?: string; hidden?: boolean }[];
  params: Record<string, string>;
};

/** One saved filter / one saved sort, as the wire contract defines them - never re-declared here. */
type ViewFilter = NonNullable<TableView["filters"]>[number];
type ViewSort = NonNullable<TableView["sort"]>[number];
type FilterOp = ViewFilter["op"];

/** One column of a chosen table, with the presentation the author gave it. */
type ChosenColumn = { field: string; label?: string };

// The value of one cell, for everything the page computes RATHER than renders: totals, groups, counts.
//
// A denied cell is not a value and is not a blank either (see `renderCell`): summing it would understate a
// total the reader is told is a total, and grouping by it would invent a "(blank)" group out of somebody
// else's data. It reads as absent here, and the strip counts those rows separately.
const valueOf = (row: TableRunRow, key: string): unknown => (row.denied?.includes(key) ? undefined : row.cells[key]);
const isBlank = (v: unknown) => v === null || v === undefined || v === "";
const isNumericKind = (kind: TableFieldKind) => kind === "money" || kind === "number";
// A column worth grouping BY: one whose values repeat. Not `ref` - a reference cell is the record's PATH
// ("departments/9f3..."), so a bar chart of one is a row of identifiers; the picker's own answer to "group by
// the department" is to follow the link and take its name.
const isGroupableKind = (kind: TableFieldKind) => kind === "enum" || kind === "bool" || kind === "text" || kind === "date" || kind === "datetime";

const BLANK_GROUP = "(blank)";

// How many bars the summary draws. Past this the chart stops being a picture and becomes a hedge of
// one-pixel bars, so the tail is said in a sentence under it instead.
const GROUP_CAP = 12;
// A pie is unreadable long before a bar chart is, and the library pools whatever is past this into one "Rest"
// slice of its own accord.
const SLICE_CAP = 8;

/**
 * The pictures a grouped table can be drawn as.
 *
 * `share` marks the ones that say "out of the whole": a slice is a FRACTION OF A TOTAL, so it means something
 * only where the groups add up to that total. Averages do not add up, and neither does a sum with a negative
 * in it - the library silently drops the negative group and draws the rest as if it were everything. Those are
 * offered only when the numbers in hand can carry them, which is why the list is filtered per table rather
 * than fixed.
 */
const CHART_TYPES = [
  { value: "bar", label: "Bars", mark: "bar", share: false },
  { value: "line", label: "Line", mark: "point", share: false },
  { value: "pie", label: "Pie", mark: "slice", share: true },
  { value: "donut", label: "Donut", mark: "slice", share: true },
  { value: "percentage", label: "Share bar", mark: "slice", share: true },
] as const;
type ChartChoice = (typeof CHART_TYPES)[number];

// Which group one row falls in. A date groups by MONTH: grouping a joining date by the day gives three
// hundred one-row groups and no picture, and the month is the bucket every other date chart in the app uses.
function groupOf(col: TableRunColumn, row: TableRunRow): string {
  const v = valueOf(row, col.key);
  if (isBlank(v)) return BLANK_GROUP;
  if (col.kind === "date" || col.kind === "datetime") return String(v).slice(0, 7);
  if (col.kind === "bool") return v ? "Yes" : "No";
  return String(v);
}

/** How a group reads on the chart's axis: a month as "Sep 2026", everything else as itself. */
function groupLabel(col: TableRunColumn, key: string): string {
  if (key === BLANK_GROUP) return BLANK_GROUP;
  if (col.kind === "date" || col.kind === "datetime") return formatMonthYear(`${key}-01`) || key;
  if (col.kind === "enum") return key.replace(/_/g, " ").toLowerCase();
  return key;
}

// The operators offered per kind, in the words the reader would use. `in` takes a comma-separated list, and
// `empty` / `not_empty` take no value at all - both are the server's own contract (domain/tableFields.ts).
const OPS_BY_KIND: Record<TableFieldKind, { op: FilterOp; label: string }[]> = {
  text: [
    { op: "contains", label: "contains" }, { op: "eq", label: "is" }, { op: "ne", label: "is not" },
    { op: "in", label: "is any of" }, { op: "empty", label: "is empty" }, { op: "not_empty", label: "is not empty" },
  ],
  enum: [
    { op: "eq", label: "is" }, { op: "ne", label: "is not" }, { op: "in", label: "is any of" },
    { op: "empty", label: "is empty" }, { op: "not_empty", label: "is not empty" },
  ],
  ref: [
    { op: "eq", label: "is" }, { op: "ne", label: "is not" }, { op: "contains", label: "contains" },
    { op: "empty", label: "is empty" }, { op: "not_empty", label: "is not empty" },
  ],
  bool: [{ op: "eq", label: "is" }, { op: "empty", label: "is empty" }, { op: "not_empty", label: "is not empty" }],
  number: [
    { op: "eq", label: "is" }, { op: "ne", label: "is not" }, { op: "gt", label: "is more than" },
    { op: "gte", label: "is at least" }, { op: "lt", label: "is less than" }, { op: "lte", label: "is at most" },
    { op: "empty", label: "is empty" }, { op: "not_empty", label: "is not empty" },
  ],
  money: [
    { op: "eq", label: "is" }, { op: "ne", label: "is not" }, { op: "gt", label: "is more than" },
    { op: "gte", label: "is at least" }, { op: "lt", label: "is less than" }, { op: "lte", label: "is at most" },
    { op: "empty", label: "is empty" }, { op: "not_empty", label: "is not empty" },
  ],
  date: [
    { op: "eq", label: "is on" }, { op: "gt", label: "is after" }, { op: "gte", label: "is on or after" },
    { op: "lt", label: "is before" }, { op: "lte", label: "is on or before" },
    { op: "empty", label: "is empty" }, { op: "not_empty", label: "is not empty" },
  ],
  datetime: [
    { op: "eq", label: "is on" }, { op: "gt", label: "is after" }, { op: "gte", label: "is on or after" },
    { op: "lt", label: "is before" }, { op: "lte", label: "is on or before" },
    { op: "empty", label: "is empty" }, { op: "not_empty", label: "is not empty" },
  ],
};

/** Operators that judge presence, not a value - the value input goes away for these. */
const VALUELESS: readonly FilterOp[] = ["empty", "not_empty"];

const opLabel = (kind: TableFieldKind, op: FilterOp) => OPS_BY_KIND[kind].find((o) => o.op === op)?.label ?? op;

/**
 * A last-resort name for a column NOTHING has described: a field the reader does not get, on a table they
 * are looking at anyway (the definition is shared; the columns it resolves to are not). Read out of the
 * storage key itself - `manager_id.@personal.personal_email` is "Manager -> Personal: Personal email" -
 * because a key is a name with the punctuation left in, and printing it raw asks the reader to parse it.
 */
function nameFromKey(key: string): string {
  const parts = key.split(".").map((seg) => humanize(seg.replace(/^@/, "").replace(/_id$/, "")));
  const leaf = parts[parts.length - 1]!;
  return parts.length > 1 ? `${parts.slice(0, -1).join(" -> ")}: ${leaf}` : leaf;
}

/** What a field is CALLED, from the run's own columns - falling back to the key for a filter on a column the
 *  reader does not get. */
const labelOfField = (field: string, cols: TableRunColumn[]) => cols.find((c) => c.key === field)?.label ?? nameFromKey(field);
const kindOfField = (field: string, cols: TableRunColumn[]): TableFieldKind => cols.find((c) => c.key === field)?.kind ?? "text";

/**
 * One control of the summary card, with the word for what it changes beside it. A `<label>` around the
 * trigger rather than text next to it, so the word is part of the control: pressing "Measure" opens the
 * measure list. The trigger keeps its own `aria-label` - it is what a screen reader announces, and it is the
 * same word - so nothing is said twice.
 */
function ChartControl({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
      <span>{label}</span>
      {children}
    </label>
  );
}

/** One saved filter as a sentence: "Status is any of open, blocked", "Annual CTC is at least 1200000". */
function filterPhrase(f: ViewFilter, cols: TableRunColumn[]): string {
  const kind = kindOfField(f.field, cols);
  const phrase = `${labelOfField(f.field, cols)} ${opLabel(kind, f.op)}`;
  if (VALUELESS.includes(f.op)) return phrase;
  // A boolean filter is stored as the "true" the server compares against; it is READ as the Yes the editor
  // offered, because "Confirmed is true" is not a sentence anybody wrote.
  const value = kind === "bool" ? (String(f.value) === "true" ? "Yes" : "No") : String(f.value ?? "");
  return `${phrase} ${value}`;
}

/** A pill that takes itself off: an active filter, a metric the reader drilled into, a chosen column. */
function RemovableChip({ label, onRemove, removeLabel, title }: {
  label: string;
  onRemove: () => void;
  removeLabel: string;
  title?: string;
}) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-xs" title={title ?? label}>
      <span className="truncate">{label}</span>
      <button type="button" onClick={onRemove} aria-label={removeLabel} className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground">
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

const specOf = (v: TableView): ViewSpec => ({
  columns: (v.columns ?? []).map((c) => ({ field: c.field, label: c.label, hidden: c.hidden })),
  params: (v.params ?? {}) as Record<string, string>,
});

export default function TableBuilder({ openId }: { me: Me; openId?: string }) {
  return openId ? <OneTable id={openId} /> : <TableList />;
}

// ---- The saved tables -----------------------------------------------------------------------------------

/**
 * The base picker's "let AI choose" option.
 *
 * A sentinel rather than an empty value because a Select item cannot hold one, and because it says something
 * an empty picker does not: the base is not unanswered, it is being answered from the sentence above it.
 * It never leaves this dialog - the request simply omits `base`, and the answer names the one that was chosen.
 */
const AI_CHOOSES_BASE = "__ai_chooses_base__";

function TableList() {
  const { rows, state, error, reload } = useCollection<TableView>("table-views");
  const { toast } = useToast();
  const confirm = useConfirm();
  const deleted = useDeletedToast();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ display_name: "", description: "", base: "" });
  const [bases, setBases] = useState<{ collection: string; label: string }[]>([]);
  const [catalogueDenied, setCatalogueDenied] = useState(false);
  // Held apart from `form` on purpose: it is not a field of the table, it is an instruction for building one,
  // and it is not sent to the create.
  const [describe, setDescribe] = useState("");
  const canDescribe = useAiFeature("tables.describe");
  // Opened on AI_CHOOSES_BASE when the feature is on, so the easy way in is the default one: "one row is" is
  // the builder's hardest question and the last one somebody who can describe their grid in a sentence wants
  // to answer. Without the feature it opens on the first base, as it always did - the alphabetically first
  // collection is an arbitrary answer, but it is a valid one and the picker is right there.
  // Whether the picker carries an ANSWER (somebody chose one) rather than the dialog's opening default. Only
  // the default is re-decided below; a chosen base is never moved out from under the person who chose it.
  const baseAnswered = useRef(false);
  const openCreate = useCallback(() => {
    baseAnswered.current = false;
    setForm({ display_name: "", description: "", base: canDescribe ? AI_CHOOSES_BASE : bases[0]?.collection ?? "" });
    setDescribe("");
    setCreating(true);
  }, [bases, canDescribe]);
  // "Build a table" from ⌘K or the "+" menu lands here and opens the dialog straight away.
  useIntent("new-table", openCreate);

  // The bases this caller may build on - the same answer the builder's picker is filtered by.
  useEffect(() => {
    let live = true;
    get<TableCatalogue>("table-fields")
      .then((c) => { if (live) { setBases(c.bases ?? []); setCatalogueDenied(false); } })
      // The catalogue is its own capability (`table-fields.read`), so it can be missing while `table-views` is
      // held. Say which one is missing rather than leaving a New button that does nothing.
      .catch(() => { if (live) { setBases([]); setCatalogueDenied(true); } });
    return () => { live = false; };
  }, []);

  // THE OPENING DEFAULT, RE-DECIDED WHILE IT IS STILL THE DEFAULT. Both of the things `openCreate` reads
  // arrive AFTER the page does - the catalogue is its own request, and whether AI may pick the base is read
  // from the settings snapshot (`useAiFeature` answers false until it lands) - while the New button
  // deliberately waits for neither (see `newButton`). `openCreate` runs once, so a dialog opened inside that
  // window kept whatever was known then: with no catalogue yet, a picker left empty for good and a Create that
  // stayed disabled on a form that looked filled in; with the AI answer still pending, the first collection in
  // the list instead of "let AI choose", which quietly turns off the one thing the sentence above it is for.
  // This settles the default as each answer lands, and stops the moment somebody answers the picker themselves.
  useEffect(() => {
    if (!creating || baseAnswered.current) return;
    const want = canDescribe ? AI_CHOOSES_BASE : bases[0]?.collection ?? "";
    if (!want) return;
    setForm((f) => (f.base === want ? f : { ...f, base: want }));
  }, [creating, bases, canDescribe]);

  const baseLabel = useMemo(() => new Map(bases.map((b) => [b.collection, b.label])), [bases]);

  // Navigating to the new table is deferred to the dialog's CLOSE, not done inside the submit: the dialog's
  // unsaved-changes guard is re-baselined as part of closing, so leaving the page from inside `onSubmit` (while
  // the form still reads as dirty) puts a "Discard your changes?" prompt in front of the table the user just
  // made.
  //
  // A REF, not state: the dialog calls `onSubmit` and then `onClose` in the same tick, so a state value set
  // during the submit is not yet visible to the close handler's closure - the id would read as null and the
  // new table would never open.
  const createdId = useRef<string | null>(null);
  async function submit() {
    // An optional description of what the table should show. When it is given, the columns, filters and sort
    // are worked out first and the table is created already laid out; when it is not, this is exactly the
    // create it always was. A failure here must not cost the person their table, so it is caught and the
    // empty table is created anyway - they can still pick columns by hand, which is the fallback for every
    // AI feature in this app.
    type Suggested = { columns: { field: string }[]; filters?: unknown[]; sort?: unknown[] };
    let suggested: Suggested | null = null;
    // The base the sentence has to supply, because the person left it to AI. `base` is then omitted from the
    // request and the answer says which collection it settled on.
    const aiPicksBase = form.base === AI_CHOOSES_BASE;
    let base = aiPicksBase ? "" : form.base;
    const wanted = describe.trim();
    if (wanted) {
      try {
        const res = await api<{ base: string; spec: Suggested; unmatched: string[] }>("/table-fields:describe", {
          method: "POST",
          body: JSON.stringify({ question: wanted, ...(aiPicksBase ? {} : { base: form.base }) }),
        });
        suggested = res.spec;
        base = res.base;
        if (res.unmatched.length) {
          // Named, not swallowed: a grid quietly narrower than what somebody described reads as the feature
          // misunderstanding them rather than as a field that does not exist.
          toast({ title: "Some of that had no matching field", description: res.unmatched.join(", "), variant: "destructive" });
        }
      } catch (e) {
        // RETHROWN when the base came from here, because there is no table to create without one: the dialog
        // stays open with the message and the picker underneath it. With a base already chosen it stays a
        // soft failure - the empty table is created and the columns are picked by hand, which is the fallback
        // for every AI feature in this app.
        if (aiPicksBase) throw new Error(`${(e as Error).message} - or pick what one row is yourself.`);
        toast({ title: "Couldn't lay it out", description: `${(e as Error).message} - creating the table empty.`, variant: "destructive" });
      }
    }

    const created = await create<TableView>("table-views", {
      display_name: form.display_name.trim(),
      description: form.description.trim() || null,
      base,
      columns: suggested?.columns ?? [],
      ...(suggested?.filters?.length ? { filters: suggested.filters } : {}),
      ...(suggested?.sort?.length ? { sort: suggested.sort } : {}),
    });
    toast({
      title: "Table created",
      // The chosen base is NAMED when nobody chose it. It is the one decision here that was made for them,
      // and a grid built on the wrong collection is otherwise something they work out from its columns.
      description: [
        aiPicksBase ? `Rows are ${baseLabel.get(base) ?? base}.` : "",
        suggested?.columns.length ? "Check the columns it picked." : "Pick its columns to fill it in.",
      ].filter(Boolean).join(" "),
      variant: "success",
    });
    reload();
    createdId.current = idOf(created.path);
  }
  function closeCreate() {
    setCreating(false);
    const id = createdId.current;
    createdId.current = null;
    if (!id) return;
    // A closing dialog drops its own history entry with `history.back()` on the next tick
    // (lib/dialogHistory.ts), so navigating synchronously here pushes an entry that the pop immediately undoes
    // and the reader lands back on the list they just left. Go once that pop has landed.
    const go = () => navigate(`tables/${id}`);
    const onPop = () => {
      window.clearTimeout(fallback);
      setTimeout(go, 0);
    };
    window.addEventListener("popstate", onPop, { once: true });
    // A dialog that owned no entry pops nothing - don't strand the reader on the list waiting for it.
    const fallback = window.setTimeout(() => {
      window.removeEventListener("popstate", onPop);
      go();
    }, 300);
  }

  // A table is a definition, so the cheapest way to a variant of one ("the same sheet, but for Sales") is a
  // copy you then edit - not rebuilding a twelve-column pick by hand. Everything that makes the table what it
  // is comes along: its columns and their headers, its filters, its sort and its saved parameters.
  async function duplicate(view: TableView) {
    try {
      const copy = await create<TableView>("table-views", {
        display_name: `${view.display_name} (copy)`,
        description: view.description ?? null,
        base: view.base,
        columns: view.columns ?? [],
        filters: view.filters ?? [],
        sort: view.sort ?? [],
        params: view.params ?? {},
      });
      reload();
      toast({ title: "Copied", description: "Opening the copy.", variant: "success" });
      navigate(`tables/${idOf(copy.path)}`);
    } catch (e) {
      toast({ title: "Couldn't copy", description: (e as Error).message, variant: "destructive" });
    }
  }

  async function del(view: TableView) {
    if (!(await confirm({ title: `Delete "${view.display_name}"?`, description: "Anyone it was shared with loses it too.", destructive: true, confirmLabel: "Delete" }))) return;
    try {
      await remove(`table-views/${idOf(view.path)}`, view.etag);
      reload();
      deleted({ path: `table-views/${idOf(view.path)}`, noun: "table", can: view.access?.can, reload });
    } catch (e) {
      toast({ title: "Couldn't delete", description: (e as Error).message, variant: "destructive" });
    }
  }

  // What a builder's own list is worth saying: which of these are experiments nobody came back to. A shared
  // library fills up with them, and every one is offered to everybody who opens this page.
  const viewInsights = (vs: TableView[]): TableInsight[] => {
    const stale = vs.filter((v) => (daysSince(v.update_time) ?? 0) >= STALE_VIEW_DAYS);
    if (stale.length === 0) return [];
    return [{
      id: "stale",
      label: `${stale.length} untouched for ${STALE_VIEW_DAYS} days`,
      hint: "Nobody has changed these in months. Usually a question somebody answered once.",
      filters: { idle: `>=${STALE_VIEW_DAYS}` },
      sort: "idle.desc",
    }];
  };

  const columns: Column<TableView>[] = [
    {
      id: "name",
      header: "Table",
      accessor: (r) => r.display_name,
      cell: (r) => (
        <div className="min-w-0">
          <button className="truncate font-medium hover:underline" onClick={() => navigate(`tables/${idOf(r.path)}`)}>{r.display_name}</button>
          {r.description && <p className="truncate text-xs text-muted-foreground">{r.description}</p>}
        </div>
      ),
      mobilePriority: 1,
    },
    { id: "base", header: "Rows are", accessor: (r) => baseLabel.get(r.base) ?? r.base, filter: "select", groupBy: true, mobilePriority: 2 },
    { id: "columns", header: "Columns", accessor: (r) => (r.columns ?? []).length, align: "right", filter: "number" },
    { id: "updated", header: "Updated", accessor: (r) => r.update_time, filter: "date", dateHint: "past", cell: (r) => formatDate(r.update_time), mobilePriority: 3 },
    {
      // How long since anybody touched this table. A builder collects abandoned experiments faster than
      // anything else in the app, and "Updated" as a date cannot be asked "show me everything nobody has
      // opened since spring".
      id: "idle", header: "Untouched", align: "right", defaultHidden: true, filter: "number", formatTotal: fmtDaysCount,
      accessor: (r) => daysSince(r.update_time),
    },
    {
      id: "actions",
      header: "",
      cell: (r) => (
        <div className="flex justify-end gap-1">
          <AccessAction objectPath={r.path} can={r.access?.can} verb="update" label={r.display_name}>
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Open" onClick={() => navigate(`tables/${idOf(r.path)}`)}><Pencil className="h-3.5 w-3.5" /></Button>
          </AccessAction>
          <AccessAction create label="Table">
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Duplicate ${r.display_name}`} title="Duplicate" onClick={(e) => { e.stopPropagation(); return duplicate(r); }}><Copy className="h-3.5 w-3.5" /></Button>
          </AccessAction>
          <AccessAction objectPath={r.path} can={r.access?.can} verb="delete" label={r.display_name}>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" aria-label="Delete" onClick={() => del(r)}><Trash2 className="h-3.5 w-3.5" /></Button>
          </AccessAction>
        </div>
      ),
    },
  ];

  const newButton = (
    <AccessAction create label="Table">
      {/* Never disabled on the catalogue read: the bases arrive a moment after the page does, and a New
          button that is dead for that moment reads as a broken page. The dialog's own Create is what waits
          for a base to be picked. */}
      <Button onClick={openCreate}>
        <Plus className="h-4 w-4" /> New table
      </Button>
    </AccessAction>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Tables"
        description="Build a grid from any fields you can see - across modules - then keep it, share it and export it."
        accessCollection="table-views"
        actions={newButton}
      />
      {catalogueDenied && (
        <Card className="border-dashed p-3 text-sm text-muted-foreground">
          You can see saved tables, but not the field catalogue that builds them. An admin grants
          <span className="font-medium text-foreground"> table-fields</span> read access alongside
          <span className="font-medium text-foreground"> table-views</span>.
        </Card>
      )}
      <DataState state={state} error={error} onRetry={reload}>
        {rows.length === 0 ? (
          <EmptyState
            icon={Table2}
            title="No saved tables yet"
            description="A table mixes fields from anywhere you have access - a salary sheet with PAN and personal email, a ticket list with each requester's department."
            action={newButton}
          />
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            insights={viewInsights}
            getRowId={(r) => r.path}
            tableId="table-views"
            accessCollection="table-views"
            accessTargetOf={(r) => ({ objectPath: r.path, label: r.display_name, can: r.access?.can })}
            onRowClick={(r) => navigate(`tables/${idOf(r.path)}`)}
          />
        )}
      </DataState>

      <WriteDialog
        open={creating}
        onClose={closeCreate}
        title="New table"
        description={canDescribe
          ? "Say what the table should show and AI lays it out, or build it by hand. Either way its columns are only ever fields you can already read."
          : "Pick what one row of the table is. You choose its columns next, and only ever from fields you can already read."}
        collection="table-views"
        form={form}
        submitLabel="Create"
        canSubmit={!!form.display_name.trim() && !!form.base && (form.base !== AI_CHOOSES_BASE || !!describe.trim())}
        whyNot={[
          !form.display_name.trim() && "Give the table a name.",
          !form.base && "Pick what one row is.",
          form.base === AI_CHOOSES_BASE && !describe.trim() && "Say what the table should show, or pick what one row is.",
        ]}
        onSubmit={submit}
      >
        <Field label="Name">
          <Input value={form.display_name} placeholder="e.g. Salary sheet - March" onChange={(e) => setForm({ ...form, display_name: e.target.value })} autoFocus />
        </Field>
        <Field label="Description (optional)">
          <Input value={form.description} placeholder="What this table is for" onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        {/* Only when the org has the feature on - an input that cannot do anything is worse than no input.
            Optional against a base the person picked: left blank, that is the create it always was and the
            table opens empty for them to fill in by hand. Required when the base is left to it, since there
            is then nothing else to build the table from.
            ABOVE the picker, because the picker's first option defers to it: an option that points at a field
            further down the form asks somebody to answer a question before reading the answer. */}
        {canDescribe && (
          <Field
            label={form.base === AI_CHOOSES_BASE ? "What should it show?" : "What should it show? (optional)"}
            // Marked as AI at the field it belongs to, not only in the dialog's subtitle: this is the one
            // input here that goes to a model, and somebody typing a sentence into a form deserves to know
            // which of its boxes is read by one.
            action={<span className="flex items-center gap-1 text-xs text-muted-foreground"><Sparkles className="h-3.5 w-3.5" /> AI</span>}
            hint="AI turns your sentence into columns, filters and sorting. You can change all of it afterwards."
          >
            <Input
              value={describe}
              placeholder="e.g. open tickets by department, newest first"
              onChange={(e) => setDescribe(e.target.value)}
            />
          </Field>
        )}
        <Field
          label="One row is"
          hint={form.base === AI_CHOOSES_BASE
            ? "AI picks it from your sentence above. You can change it afterwards."
            : "The collection the table is built on. Everything else joins onto it."}
        >
          <Select value={form.base} onValueChange={(v) => { baseAnswered.current = true; setForm({ ...form, base: v }); }}>
            <SelectTrigger><SelectValue placeholder="Pick a base" /></SelectTrigger>
            <SelectContent>
              {/* First, and the default, because it is the answer for somebody who knows the grid they want
                  and not which of eighty collections counts it. Named for WHO decides rather than for what is
                  read: the form already has a Description box - the table's own blurb, nothing to do with this
                  - so wording it "from the description" pointed at the wrong field, and it said nothing about
                  a model being involved in a choice being made for somebody. */}
              {canDescribe && (
                <SelectItem value={AI_CHOOSES_BASE}>
                  <span className="flex items-center gap-1.5"><Sparkles className="h-3.5 w-3.5" /> Let AI choose</span>
                </SelectItem>
              )}
              {bases.map((b) => <SelectItem key={b.collection} value={b.collection}>{b.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
      </WriteDialog>
    </div>
  );
}

// ---- One table ------------------------------------------------------------------------------------------

function OneTable({ id }: { id: string }) {
  const route = useRoute();
  const { toast } = useToast();
  // Deliberately the BROAD capability, not a per-collection one: a custom grid draws columns from several
  // collections at once, so no single collection's export grant can stand for what it would put in the file.
  const canExport = usePermission("export.read");
  const [view, setView] = useState<TableView | null>(null);
  const [catalogue, setCatalogue] = useState<TableCatalogue | null>(null);
  const [result, setResult] = useState<TableRunResult | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [filtering, setFiltering] = useState(false);
  const [editing, setEditing] = useState(false);
  const [details, setDetails] = useState({ display_name: "", description: "", base: "" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const confirm = useConfirm();

  // The run's parameters live in the URL, so a narrowed report is a link somebody can send. They start from
  // the view's saved defaults and are never written back by simply looking - a shared table is not something
  // one reader's window should redefine for everyone.
  const params = useMemo(() => {
    const stored = (view?.params ?? {}) as Record<string, string>;
    const out: Record<string, string> = {};
    for (const key of ["from", "to", "pay_period", "financial_year", "department", "employee"]) {
      const v = route.query[key] ?? stored[key];
      if (v) out[key] = v;
    }
    return out;
  }, [view, route.query]);

  useEffect(() => {
    let live = true;
    setState("loading");
    get<TableView>(`table-views/${id}`)
      .then((v) => { if (live) setView(v); })
      .catch((e: unknown) => { if (live) { setState("error"); setError(e instanceof Error ? e.message : String(e)); } });
    return () => { live = false; };
  }, [id]);

  // The catalogue for this base: what the picker may offer this reader. Keyed on the BASE - the one thing the
  // fetch is about - named as a value so the dependency array says the same thing the body reads.
  const viewBase = view?.base;
  useEffect(() => {
    if (!viewBase) return;
    let live = true;
    get<TableCatalogue>(`table-fields?base=${encodeURIComponent(viewBase)}`)
      .then((c) => { if (live) setCatalogue(c); })
      .catch(() => { if (live) setCatalogue(null); });
    return () => { live = false; };
  }, [viewBase]);

  // The rows. One page, then more on request - a report is read to the end far more often than a list is.
  const runPage = useCallback(async (pageToken?: string) => {
    const qs = new URLSearchParams({ max_page_size: "100", ...params });
    if (pageToken) qs.set("page_token", pageToken);
    return api<TableRunResult>(`/table-views/${id}:run?${qs}`, { method: "POST", safeToRepeat: true });
  }, [id, params]);

  // Pages from `pageToken` until `want` rows are in hand or the report ends - see PAGE_TARGET above for why a
  // single page is not an answer. `have` is what the caller already holds, so the target is counted over the
  // whole grid rather than over this load. The LAST page's envelope is kept (its `next_page_token` is the one
  // that still names more; `columns` and `dropped` are the same on every page), with the rows concatenated.
  const runFilled = useCallback(async (pageToken: string | undefined, want: number, have = 0) => {
    let page = await runPage(pageToken);
    const rows = [...page.rows];
    for (let spent = 1; spent < MAX_PAGES_PER_LOAD; spent++) {
      const total = have + rows.length;
      if (!page.next_page_token || total >= want || total >= ROW_CEILING) break;
      page = await runPage(page.next_page_token);
      rows.push(...page.rows);
    }
    return { ...page, rows };
  }, [runPage]);

  useEffect(() => {
    if (!view) return;
    let live = true;
    setState("loading");
    runFilled(undefined, PAGE_TARGET)
      .then((r) => { if (live) { setResult(r); setState("ready"); setError(null); } })
      .catch((e: unknown) => { if (live) { setState("error"); setError(e instanceof Error ? e.message : String(e)); } });
    return () => { live = false; };
  }, [view, runFilled, reloadKey]);

  async function loadMore() {
    if (!result?.next_page_token || loadingMore || result.rows.length >= ROW_CEILING) return;
    setLoadingMore(true);
    try {
      const next = await runFilled(result.next_page_token, result.rows.length + PAGE_TARGET, result.rows.length);
      setResult({ ...next, rows: [...result.rows, ...next.rows] });
    } catch (e) {
      toast({ title: "Couldn't load more rows", description: (e as Error).message, variant: "destructive" });
    } finally {
      setLoadingMore(false);
    }
  }

  // The picker hands back the columns IN ORDER, each with the header its author gave it - so the same save
  // carries a reorder and a rename as well as a tick. `hidden` is not the picker's to touch (a hidden column
  // is one a filter judges on and the grid does not show), so it is carried over from the stored spec.
  async function saveColumns(chosen: ChosenColumn[]) {
    if (!view) return;
    const spec = specOf(view);
    const kept = new Map(spec.columns.map((c) => [c.field, c]));
    const columns = chosen.map((c) => {
      const before = kept.get(c.field);
      return { field: c.field, ...(c.label ? { label: c.label } : {}), ...(before?.hidden ? { hidden: true } : {}) };
    });
    const updated = await patch<TableView>(`table-views/${id}`, { columns }, view.etag);
    setView(updated);
  }

  /** The saved filters and sort - the report's own narrowing, applied by the server over every page. */
  async function saveFilterSort(filters: ViewFilter[], sort: ViewSort[]) {
    if (!view) return;
    const updated = await patch<TableView>(`table-views/${id}`, { filters, sort }, view.etag);
    setView(updated);
  }

  async function dropFilter(index: number) {
    if (!view) return;
    try {
      await saveFilterSort((view.filters ?? []).filter((_, i) => i !== index), view.sort ?? []);
    } catch (e) {
      // The chip is a one-click write with nowhere to report from, so it reports here rather than vanishing
      // from the toolbar while the filter is still on the saved table.
      toast({ title: "Couldn't remove the filter", description: (e as Error).message, variant: "destructive" });
    }
  }

  async function duplicate() {
    if (!view) return;
    try {
      const copy = await create<TableView>("table-views", {
        display_name: `${view.display_name} (copy)`,
        description: view.description ?? null,
        base: view.base,
        columns: view.columns ?? [],
        filters: view.filters ?? [],
        sort: view.sort ?? [],
        params: view.params ?? {},
      });
      toast({ title: "Copied", description: "Opening the copy.", variant: "success" });
      navigate(`tables/${idOf(copy.path)}`);
    } catch (e) {
      toast({ title: "Couldn't copy", description: (e as Error).message, variant: "destructive" });
    }
  }

  // Name, description and - the one people get wrong first - what a row IS. Picking the wrong base used to
  // mean deleting the table and starting again; it is an edit like any other, and the server has always taken
  // it. Changing it clears the columns (they name fields of the old base), which is asked about at the moment
  // the base is picked rather than sprung after Save.
  function openEdit() {
    if (!view) return;
    setDetails({ display_name: view.display_name, description: view.description ?? "", base: view.base });
    setEditing(true);
  }
  async function saveDetails() {
    if (!view) return;
    const body: Record<string, unknown> = {
      display_name: details.display_name.trim(),
      description: details.description.trim() || null,
    };
    // Only send the base when it actually moved - resending the same one is a no-op the server ignores, but
    // saying nothing is clearer than relying on that.
    if (details.base !== view.base) body.base = details.base;
    const updated = await patch<TableView>(`table-views/${id}`, body, view.etag);
    setView(updated);
    if (details.base !== view.base) {
      setResult(null);
      toast({ title: "Rows are now " + (catalogue?.bases.find((b) => b.collection === details.base)?.label ?? details.base), description: "Pick the columns for the new base.", variant: "success" });
    }
  }
  async function pickBase(next: string) {
    if (!view || next === details.base) return;
    // Asked HERE, while the choice is being made, not on Save: by then the columns are already gone in the
    // reader's mind and the prompt reads as an obstacle rather than as information.
    if (next !== view.base && selected.length) {
      const ok = await confirm({
        title: "Change what one row is?",
        description: `The ${selected.length} column${selected.length === 1 ? "" : "s"} on this table name fields of ${catalogue?.label ?? view.base}, so they will be cleared. Filters and sort go with them; the window and department you run it over stay.`,
        confirmLabel: "Change and clear columns",
      });
      if (!ok) return;
    }
    setDetails((d) => ({ ...d, base: next }));
  }

  // The ORG's money formatter - symbol from `org.default_currency`, precision from `currencyDecimals` - which
  // is how every other money surface in the app renders. See the note on `renderCell`.
  const money = useMoney();
  const columns: Column<TableRunResult["rows"][number]>[] = useMemo(() => {
    if (!result) return [];
    return result.columns.map((col) => ({
      id: col.key,
      header: col.label,
      // The header is as short as this grid's own columns allow; the trail that got to the column is on hover
      // for the reader who has to ask "whose?" once.
      headerTitle: col.full_label,
      align: col.kind === "money" || col.kind === "number" ? ("right" as const) : undefined,
      // The accessor is the RAW value: it is what sorts, filters and exports, so a money column exports as a
      // number rather than as "₹12,00,000" that no spreadsheet can add up.
      accessor: (row) => (row.denied?.includes(col.key) ? null : (row.cells[col.key] as string | number | boolean | null | undefined)),
      cell: (row) => renderCell(col, row, money),
      ...(col.kind === "money" ? { aggregate: "sum" as const, formatTotal: (n: number) => money(n) } : {}),
      // The field's KIND decides how it narrows, so a grid somebody assembled this morning out of pay,
      // joining dates and departments arrives with a money filter on the money column, a calendar on the
      // dates and a counted value list on the departments - without the person who built it saying so.
      // A repeated value (an enum, a yes/no, a reference to another record) can also group the grid.
      filter:
        col.kind === "money" || col.kind === "number" ? ("number" as const)
        : col.kind === "date" || col.kind === "datetime" ? ("date" as const)
        : col.kind === "enum" || col.kind === "bool" || col.kind === "ref" ? ("select" as const)
        : ("text" as const),
      ...(col.kind === "enum" || col.kind === "bool" || col.kind === "ref" ? { groupBy: true } : {}),
      // Which half of the calendar a date field lives in, read off its name. A grid of joining dates is asked
      // about the past and one of due dates about what is coming, and a reader who has to scroll past "next
      // 30 days" to reach "last 30 days" every time is being made to pay for something the field name already
      // said. Ordering only, so a wrong guess costs a scroll and never hides a window.
      ...(col.kind === "date" || col.kind === "datetime" ? { dateHint: dateHintOf(col.key, col.label) } : {}),
    }));
  }, [result, money]);

  // ---- What the grid says about itself ------------------------------------------------------------------
  //
  // Every number below is computed over the rows IN HAND and says so. A load follows the cursor until it has
  // a screenful or the report ends (PAGE_TARGET above), so on most tables that is the whole report - but on a
  // long one it is a window, and a total that quietly described a window while reading as a total would be
  // the one figure on the page nobody could check.
  const rows = useMemo(() => result?.rows ?? [], [result]);
  const cols = useMemo(() => result?.columns ?? [], [result]);

  const stats = useMemo(() => {
    const totals = cols
      .filter((c) => isNumericKind(c.kind))
      .map((col) => {
        let sum = 0;
        let n = 0;
        for (const r of rows) {
          const v = valueOf(r, col.key);
          if (typeof v === "number") { sum += v; n += 1; }
        }
        return { col, sum, n };
      })
      .filter((t) => t.n > 0);
    // EMPTY is not the same as WITHHELD, so they are counted apart: "nobody filled this in" is a data problem
    // somebody can go and fix, and "this is not yours to see" is not a problem at all.
    const incomplete = rows.filter((r) => cols.some((c) => !r.denied?.includes(c.key) && isBlank(r.cells[c.key]))).length;
    const restricted = rows.filter((r) => r.denied?.length).length;
    // The commonest value of the first column that HAS common values - which is what a grid of statuses is
    // read for, and one click away from being the filter as well.
    let top: { col: TableRunColumn; value: string; n: number } | null = null;
    for (const col of cols) {
      if (col.kind !== "enum" && col.kind !== "bool") continue;
      const tally = new Map<string, number>();
      for (const r of rows) {
        if (isBlank(valueOf(r, col.key))) continue;
        const key = groupOf(col, r);
        tally.set(key, (tally.get(key) ?? 0) + 1);
      }
      const best = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
      if (best) { top = { col, value: best[0], n: best[1] }; break; }
    }
    return { totals, incomplete, restricted, top };
  }, [rows, cols]);

  // Clicking a metric narrows the grid to the rows it counted - through the app's own drill-through, so the
  // narrowed report is a link, survives a reload and closes with the back button (lib/kpiFocus.ts).
  const focusSpecs = useMemo(() => {
    const specs: Record<string, FocusSpec<TableRunRow>> = {
      incomplete: { label: "rows with an empty cell", match: (r) => cols.some((c) => !r.denied?.includes(c.key) && isBlank(r.cells[c.key])) },
      restricted: { label: "rows with a value withheld from you", match: (r) => !!r.denied?.length },
    };
    const top = stats.top;
    if (top) specs.top = { label: `rows where ${top.col.label} is ${groupLabel(top.col, top.value)}`, match: (r) => groupOf(top.col, r) === top.value };
    return specs;
  }, [cols, stats]);
  const focus = useKpiFocus<TableRunRow, string>(focusSpecs);

  // ---- The summary ---------------------------------------------------------------------------------------
  // One group-by and one measure, both in the URL beside the run's parameters, for the same reason they are:
  // "spend by department" is a question somebody asks and then sends to somebody else.
  const groupKey = route.query.group ?? "";
  const groupCol = useMemo(() => cols.find((c) => c.key === groupKey) ?? null, [cols, groupKey]);
  const groupable = useMemo(() => cols.filter((c) => isGroupableKind(c.kind)), [cols]);
  const measure = route.query.measure ?? "count";
  const measureCol = useMemo(() => (measure === "count" ? null : cols.find((c) => c.key === measure.slice(4)) ?? null), [cols, measure]);
  const measureLabel = !measureCol ? "Rows" : `${measure.startsWith("avg:") ? "Average" : "Total"} ${measureCol.label.toLowerCase()}`;
  const formatMeasure = useCallback(
    (n: number) => (measureCol?.kind === "money" ? money(n) : (Math.round(n * 100) / 100).toLocaleString()),
    [measureCol, money],
  );

  const groups = useMemo(() => {
    if (!groupCol) return [];
    const tally = new Map<string, { n: number; sum: number; has: number }>();
    for (const r of rows) {
      const key = groupOf(groupCol, r);
      const entry = tally.get(key) ?? { n: 0, sum: 0, has: 0 };
      entry.n += 1;
      if (measureCol) {
        const v = valueOf(r, measureCol.key);
        if (typeof v === "number") { entry.sum += v; entry.has += 1; }
      }
      tally.set(key, entry);
    }
    const out = [...tally.entries()].map(([key, e]) => ({
      key,
      label: groupLabel(groupCol, key),
      n: e.n,
      value: !measureCol ? e.n : measure.startsWith("avg:") ? (e.has ? e.sum / e.has : 0) : e.sum,
    }));
    // Time reads in time order. Everything else reads biggest-first, which is the whole point of the picture.
    return groupCol.kind === "date" || groupCol.kind === "datetime"
      ? out.sort((a, b) => a.key.localeCompare(b.key))
      : out.sort((a, b) => b.value - a.value);
  }, [groupCol, measureCol, measure, rows]);

  // A bar per group, up to a readable number of them; the tail is said in words rather than drawn as a hedge
  // of one-pixel bars.
  const drawnGroups = useMemo(() => groups.slice(0, GROUP_CAP), [groups]);

  // WHICH PICTURE. The same tally answers a different question drawn a different way - a spend by department
  // is a bar chart, its share of the budget is a pie, a headcount by joining month is a line - so the shape is
  // the reader's to choose, and it rides in the URL beside the group and the measure because a chart somebody
  // sends on should arrive as the chart they were looking at.
  //
  // The default is the group column's own kind: time reads as a line, everything else as bars. It stays a
  // default rather than a one-off initial value, so a table whose group-by changes is drawn the way that
  // grouping wants until somebody says otherwise.
  const chartTypes = useMemo(
    () => CHART_TYPES.filter((t) => !t.share || (!measure.startsWith("avg:") && groups.every((g) => g.value >= 0))),
    [measure, groups],
  );
  const chart: ChartChoice =
    chartTypes.find((t) => t.value === route.query.chart) ??
    chartTypes.find((t) => t.value === (groupCol?.kind === "date" || groupCol?.kind === "datetime" ? "line" : "bar"))!;
  const sliceSpecs = useMemo(() => {
    const specs: Record<string, FocusSpec<TableRunRow>> = {};
    if (!groupCol) return specs;
    for (const g of groups) specs[g.key] = { label: `${groupCol.label}: ${g.label}`, match: (r) => groupOf(groupCol, r) === g.key };
    return specs;
  }, [groupCol, groups]);
  const slice = useKpiFocus<TableRunRow, string>(sliceSpecs, "slice");
  // The bar the grid is currently narrowed by, so the picture says what it is filtered by. -1 when the slice
  // in force is one of the groups past the cap - the narrowing still holds, no bar is lit.
  const drawnSlice = drawnGroups.findIndex((g) => g.key === slice.focus);

  // The rows the grid actually shows: the report, narrowed by whichever metric or bar the reader pressed.
  const shown = slice.apply(focus.apply(rows));
  const narrowedBy = [focus.activeLabel, slice.activeLabel].filter(Boolean) as string[];

  // A handful of items off numbers that are already computed - built in the render body rather than memoized,
  // because every part of it (the focus handlers, the narrowing) changes identity on every render anyway.
  const summary: SummaryItem[] = (() => {
    if (!result || !rows.length) return [];
    const items: SummaryItem[] = [
      {
        label: "Rows",
        value: shown.length.toLocaleString(),
        icon: Rows3,
        hint: result.next_page_token
          ? `of ${rows.length.toLocaleString()} loaded - there are more`
          : narrowedBy.length ? `of ${rows.length.toLocaleString()} in the report` : undefined,
      },
    ];
    for (const t of stats.totals.slice(0, 2)) {
      items.push({
        label: `Total ${t.col.label.toLowerCase()}`,
        value: t.col.kind === "money" ? money(t.sum) : t.sum.toLocaleString(),
        icon: Sigma,
        hint: `average ${t.col.kind === "money" ? money(t.sum / t.n) : (Math.round((t.sum / t.n) * 100) / 100).toLocaleString()} over ${t.n.toLocaleString()}`,
      });
    }
    if (stats.top) {
      items.push({
        label: stats.top.col.label,
        value: <span className="capitalize">{groupLabel(stats.top.col, stats.top.value)}</span>,
        hint: `${stats.top.n.toLocaleString()} of ${rows.length.toLocaleString()} rows`,
        ...focus.kpi("top"),
      });
    }
    if (stats.incomplete) {
      items.push({
        label: "Incomplete",
        value: stats.incomplete.toLocaleString(),
        tone: "warning",
        hint: "a cell nobody has filled in",
        ...focus.kpi("incomplete"),
      });
    }
    if (stats.restricted) {
      items.push({
        label: "Restricted",
        value: stats.restricted.toLocaleString(),
        tone: "muted",
        hint: "a value withheld from you",
        ...focus.kpi("restricted"),
      });
    }
    return items;
  })();

  // Where a row's record lives. A grid built on People opens the profile; one built on a collection with no
  // page of its own opens nothing, and says nothing about opening.
  const recordRoute = useCallback((row: TableRunRow) => (result ? resourceRoute(result.base, row.path) : null), [result]);
  const opensRecord = !!result && opensExactRecord(result.base);
  // Asked of a real row rather than of the base: a grid whose base has no page anywhere in the app must not
  // hand every row a pointer and a menu that go nowhere.
  const rowsOpen = !!rows.length && !!recordRoute(rows[0]!);

  const copyLink = useCallback(async (to: string) => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/${to}`);
      toast({ title: "Link copied", description: "Points at the record, not at this table.", variant: "success" });
    } catch {
      toast({ title: "Couldn't copy the link", description: "Your browser did not allow it.", variant: "destructive" });
    }
  }, [toast]);

  // A row of a grid IS a record, and the table had no way to reach it - which is the first thing anybody
  // wants the moment a number looks wrong. Rows whose base has no page of its own get no menu and no
  // pointer, rather than an "Open" that goes nowhere.
  const rowActions: Column<TableRunRow> = {
    id: "row-actions",
    header: "",
    cell: (row) => {
      const to = recordRoute(row);
      if (!to) return null;
      return (
        <RowActions
          objectPath={row.path}
          actions={[
            { label: opensRecord ? "Open record" : "Open in its module", icon: <ExternalLink className="h-4 w-4" />, onClick: () => navigate(to) },
            { label: "Copy link to record", icon: <Link2 className="h-4 w-4" />, onClick: () => void copyLink(to) },
          ]}
        />
      );
    },
  };

  const chosen = useMemo<ChosenColumn[]>(() => (view?.columns ?? []).map((c) => ({ field: c.field, ...(c.label ? { label: c.label } : {}) })), [view]);
  const selected = useMemo(() => chosen.map((c) => c.field), [chosen]);
  const usesMetrics = selected.some((f) => f.includes("@metric."));
  const usesPayslip = selected.some((f) => f.includes("@payslip."));
  // The department narrowing applies where the base row itself carries a department, which is exactly where
  // the base node offers a link to one. (The catalogue is one node now, so this asks the links, not a flat
  // field list that no longer holds the whole tree.)
  const hasDepartment = !!catalogue?.links?.some((l) => l.collection === "departments");

  if (!view) {
    return (
      <DataState state={state} error={error} onRetry={() => setReloadKey((k) => k + 1)}>
        <div />
      </DataState>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Tables"
        title={view.display_name}
        description={view.description || `One row per ${(catalogue?.label ?? view.base).toLowerCase().replace(/s$/, "")}.`}
        accessCollection="table-views"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => navigate("tables")}><X className="h-4 w-4" /> All tables</Button>
            <AccessAction objectPath={view.path} can={view.access?.can} verb="update" label={view.display_name}>
              <Button variant="outline" onClick={() => setPicking(true)}><Columns3 className="h-4 w-4" /> Columns{selected.length ? ` (${selected.length})` : ""}</Button>
            </AccessAction>
            <AccessAction objectPath={view.path} can={view.access?.can} verb="update" label={view.display_name}>
              <Button variant="outline" onClick={openEdit}><Pencil className="h-4 w-4" /> Edit</Button>
            </AccessAction>
            <AccessAction create label="Table">
              <Button variant="outline" onClick={() => duplicate()}><Copy className="h-4 w-4" /> Duplicate</Button>
            </AccessAction>
            <Button variant="outline" onClick={() => setReloadKey((k) => k + 1)}><RefreshCw className="h-4 w-4" /> Refresh</Button>
          </div>
        }
      />

      <ParamBar
        params={params}
        showWindow={usesMetrics}
        showPayPeriod={usesPayslip}
        showDepartment={hasDepartment}
      />

      {/* A column the reader is not entitled to is SAID, not silently dropped: knowing the table has a column
          you cannot see is the difference between "there is nothing there" and "this is not for you". */}
      {result?.dropped?.length ? (
        <Card className="border-dashed p-3 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{result.dropped.length} column{result.dropped.length > 1 ? "s" : ""} hidden from you: </span>
          {result.dropped.map((d) => d.field).join(", ")}
        </Card>
      ) : null}

      {/* The report's OWN narrowing - saved on the table, applied by the server over every page, and the
          same for everyone who opens it. Each chip says what it does in words and takes itself off. */}
      {(view.filters ?? []).length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Filters</span>
          {(view.filters ?? []).map((f, i) => (
            <RemovableChip
              key={`${f.field}-${f.op}-${i}`}
              label={filterPhrase(f, cols)}
              onRemove={() => void dropFilter(i)}
              removeLabel={`Remove filter ${filterPhrase(f, cols)}`}
            />
          ))}
        </div>
      )}

      {summary.length > 0 && <SummaryStrip items={summary} className="mb-0" />}

      {/* What the reader is looking at, when it is not the whole report. A metric or a bar they pressed is
          THEIR narrowing, not the table's, so it lives beside the grid rather than in the definition. */}
      {narrowedBy.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-sm">
          <span className="text-muted-foreground">Showing only</span>
          {focus.activeLabel && <RemovableChip label={focus.activeLabel} onRemove={focus.clear} removeLabel="Show every row again" />}
          {slice.activeLabel && <RemovableChip label={slice.activeLabel} onRemove={slice.clear} removeLabel="Show every group again" />}
        </div>
      )}

      {groupCol && (
        <ChartCard
          title={`${measureLabel} by ${groupCol.label}`}
          description={
            groups.length > GROUP_CAP
              ? `The ${GROUP_CAP} biggest of ${groups.length} groups. Click a ${chart.mark} to narrow the grid to it.`
              : `Click a ${chart.mark} to narrow the grid to that group.`
          }
          actions={
            // Every control says what it CHANGES. Three unlabelled dropdowns in a card corner are three
            // dropdowns you have to open to find out what they are, and the one that had a value the reader
            // recognised ("Department") read as a filter rather than as the axis of the picture.
            <div className="flex flex-wrap items-center gap-3">
              <ChartControl label="Group by">
                <Select value={groupKey} onValueChange={(v) => setQueryParams({ group: v, slice: null })}>
                  <SelectTrigger className="h-8 w-44" aria-label="Group by"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {groupable.map((c) => <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </ChartControl>
              <ChartControl label="Measure">
                <Select value={measure} onValueChange={(v) => setQueryParams({ measure: v === "count" ? null : v })}>
                  <SelectTrigger className="h-8 w-52" aria-label="Measure"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="count">Number of rows</SelectItem>
                    {cols.filter((c) => isNumericKind(c.kind)).flatMap((c) => [
                      <SelectItem key={`sum:${c.key}`} value={`sum:${c.key}`}>Total {c.label.toLowerCase()}</SelectItem>,
                      <SelectItem key={`avg:${c.key}`} value={`avg:${c.key}`}>Average {c.label.toLowerCase()}</SelectItem>,
                    ])}
                  </SelectContent>
                </Select>
              </ChartControl>
              <ChartControl label="Chart">
                <Select value={chart.value} onValueChange={(v) => setQueryParams({ chart: v })}>
                  <SelectTrigger className="h-8 w-32" aria-label="Chart type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {chartTypes.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </ChartControl>
              <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Close summary" onClick={() => setQueryParams({ group: null, measure: null, slice: null, chart: null })}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          }
        >
          <Chart
            type={chart.value}
            labels={drawnGroups.map((g) => g.label)}
            datasets={[{ name: measureLabel, values: drawnGroups.map((g) => g.value) }]}
            ariaLabel={`${measureLabel} for each ${groupCol.label.toLowerCase()} in this table`}
            height={240}
            // A pie reads as a picture of the biggest few and a sentence about the rest, the same bargain the
            // bars already make at GROUP_CAP.
            maxSlices={chart.value === "pie" || chart.value === "donut" ? SLICE_CAP : undefined}
            format={formatMeasure}
            emptyText="Nothing to summarise yet."
            selected={drawnSlice < 0 ? null : drawnSlice}
            onSelect={(i) => {
              const picked = drawnGroups[i];
              if (picked) slice.setFocus(slice.focus === picked.key ? null : picked.key);
            }}
          />
        </ChartCard>
      )}

      <DataState state={state} error={error} onRetry={() => setReloadKey((k) => k + 1)}>
        {selected.length === 0 ? (
          <EmptyState
            icon={Columns3}
            title="No columns yet"
            description="Pick the fields this table should show. You can only pick fields you already have access to."
            action={<Button onClick={() => setPicking(true)}><Plus className="h-4 w-4" /> Pick columns</Button>}
          />
        ) : (
          <DataTable
            columns={rowsOpen ? [...columns, rowActions] : columns}
            rows={shown}
            getRowId={(r) => r.path}
            tableId={`table-view-${id}`}
            emptyTitle="No rows"
            emptyDescription={
              narrowedBy.length
                ? `No ${narrowedBy[0]} in this table.`
                : (view.filters ?? []).length
                  ? "Nothing matches this table's filters."
                  : "Nothing you can see matches this table yet."
            }
            hasMore={!!result?.next_page_token && (result?.rows.length ?? 0) < ROW_CEILING}
            onLoadMore={loadMore}
            onRowClick={rowsOpen ? (r) => { const to = recordRoute(r); if (to) navigate(to); } : undefined}
            toolbar={
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!groupable.length}
                  title={groupable.length ? "Group the rows and chart them" : "No column on this table has repeated values to group by"}
                  onClick={() => setQueryParams(groupCol ? { group: null, measure: null, slice: null, chart: null } : { group: groupable[0]?.key ?? null, slice: null })}
                >
                  <BarChart3 className="h-4 w-4" /> Summarise
                </Button>
                <AccessAction objectPath={view.path} can={view.access?.can} verb="update" label={view.display_name}>
                  <Button variant="outline" size="sm" onClick={() => setFiltering(true)}>
                    <Filter className="h-4 w-4" /> Filter & sort
                    {(view.filters ?? []).length + (view.sort ?? []).length > 0 ? ` (${(view.filters ?? []).length + (view.sort ?? []).length})` : ""}
                  </Button>
                </AccessAction>
              </>
            }
            title={
              <span className="flex items-center gap-2">
                <span>{shown.length.toLocaleString()} rows</span>
                {(view.sort ?? []).length > 0 && (
                  <Badge variant="muted" className="gap-1">
                    {(view.sort ?? [])[0]!.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
                    {labelOfField((view.sort ?? [])[0]!.field, cols)}
                  </Badge>
                )}
                {result?.columns.some((c) => c.masked) && (
                  <Badge variant="muted" className="gap-1"><Lock className="h-3 w-3" /> Some values masked</Badge>
                )}
              </span>
            }
          />
        )}
      </DataState>

      <FilterSortSheet
        open={filtering}
        onClose={() => setFiltering(false)}
        columns={cols}
        filters={view.filters ?? []}
        sort={view.sort ?? []}
        onSave={saveFilterSort}
      />

      {catalogue && (
        <ColumnPicker
          open={picking}
          onClose={() => setPicking(false)}
          base={view.base}
          catalogue={catalogue}
          selected={chosen}
          headers={cols}
          onSave={saveColumns}
          canExport={canExport}
        />
      )}

      <WriteDialog
        open={editing}
        onClose={() => setEditing(false)}
        title="Edit table"
        description="What it is called, and what one row of it is."
        collection="table-views"
        objectPath={view.path}
        guardLabel="table"
        form={details}
        submitLabel="Save changes"
        canSubmit={!!details.display_name.trim() && !!details.base}
        whyNot="Give the table a name."
        onSubmit={saveDetails}
      >
        <Field label="Name">
          <Input value={details.display_name} onChange={(e) => setDetails({ ...details, display_name: e.target.value })} autoFocus />
        </Field>
        <Field label="Description (optional)">
          <Input value={details.description} placeholder="What this table is for" onChange={(e) => setDetails({ ...details, description: e.target.value })} />
        </Field>
        <Field
          label="One row is"
          hint={details.base !== view.base ? "The columns will be cleared - they name fields of the old base." : "Change this and the table is rebuilt on a different collection."}
        >
          <Select value={details.base} onValueChange={(v) => void pickBase(v)}>
            <SelectTrigger><SelectValue placeholder="Pick a base" /></SelectTrigger>
            <SelectContent>
              {(catalogue?.bases ?? []).map((b) => <SelectItem key={b.collection} value={b.collection}>{b.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
      </WriteDialog>
    </div>
  );
}

// ---- Cells ----------------------------------------------------------------------------------------------

// `money` is the org's formatter (`useMoney`), passed in rather than reaching for `formatMoney` directly:
// `formatMoney`'s signature is `(value, currency = "INR", decimals?)`, so a bare call renders ₹ whatever the
// org's currency is, at Intl's default of two decimals. Table Builder is the one surface that puts money from
// several collections side by side, which makes a wrong unit both hardest to notice and most likely to be
// exported - and even in INR the bare call reads ₹1,800.00 where the Payroll page reads ₹1,800.
/** Past or future, from the field's own name. Anything that has not clearly happened yet is asked about the
 *  past, because most stored dates are records of something that did. */
function dateHintOf(key: string, label: string): "past" | "future" {
  const s = `${key} ${label}`.toLowerCase();
  return /due|expir|next|end|deadline|renew|valid|target|scheduled|upcoming|last_working/.test(s) ? "future" : "past";
}

function renderCell(
  col: TableRunResult["columns"][number],
  row: TableRunResult["rows"][number],
  money: (n: number | null | undefined, code?: string) => string,
) {
  // A denied cell is NOT an empty one. Rendering it as "-" would read as "this person has no PAN"; the lock
  // says the value exists and is not yours - the same choice the profile page makes for a redacted field.
  if (row.denied?.includes(col.key)) {
    return <span className="inline-flex items-center gap-1 text-muted-foreground" title="You do not have access to this field"><Lock className="h-3 w-3" /> Restricted</span>;
  }
  const v = row.cells[col.key];
  if (v === null || v === undefined || v === "") return <span className="text-muted-foreground">-</span>;
  switch (col.kind) {
    case "money":
      return <span className="tabular-nums">{typeof v === "number" ? money(v) : String(v)}</span>;
    case "number":
      return <span className="tabular-nums">{typeof v === "number" ? v.toLocaleString() : String(v)}</span>;
    case "date":
    case "datetime":
      return <span>{formatDate(String(v))}</span>;
    case "bool":
      return <span>{v ? "Yes" : "No"}</span>;
    case "enum":
      return <Badge variant="secondary" className="capitalize">{String(v).replace(/_/g, " ").toLowerCase()}</Badge>;
    default:
      return <span className="whitespace-pre-wrap break-words">{String(v)}</span>;
  }
}

// ---- The parameter bar ----------------------------------------------------------------------------------

function ParamBar({ params, showWindow, showPayPeriod, showDepartment }: {
  params: Record<string, string>;
  showWindow: boolean;
  showPayPeriod: boolean;
  showDepartment: boolean;
}) {
  // Read only what this bar actually offers - a table with no measure column never fetches pay periods.
  const { rows: depts } = useCollection<Department>("departments", { enabled: showDepartment, all: true });
  const { rows: periods } = useCollection<PayPeriod>("pay-periods", { enabled: showPayPeriod });
  if (!showWindow && !showPayPeriod && !showDepartment) return null;
  const set = (key: string, value: string) => setQueryParams({ [key]: value || null });
  return (
    <Card className="flex flex-wrap items-end gap-3 p-3">
      {showWindow && (
        <>
          <label className="text-xs text-muted-foreground">
            <span className="mb-1 block">Measures from</span>
            <Input type="date" value={params.from ?? ""} onChange={(e) => set("from", e.target.value)} className="h-9 w-40" />
          </label>
          <label className="text-xs text-muted-foreground">
            <span className="mb-1 block">to</span>
            <Input type="date" value={params.to ?? ""} onChange={(e) => set("to", e.target.value)} className="h-9 w-40" />
          </label>
        </>
      )}
      {showPayPeriod && (
        <label className="text-xs text-muted-foreground">
          <span className="mb-1 block">Pay period</span>
          <Select value={params.pay_period ?? ""} onValueChange={(v) => set("pay_period", v)}>
            <SelectTrigger className="h-9 w-56"><SelectValue placeholder="Most recent" /></SelectTrigger>
            <SelectContent>
              {periods.map((p) => <SelectItem key={p.path} value={p.path}>{p.display_name ?? `${p.period_start} - ${p.period_end}`}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
      )}
      {showDepartment && (
        <label className="text-xs text-muted-foreground">
          <span className="mb-1 block">Department</span>
          <Select value={params.department ?? ""} onValueChange={(v) => set("department", v)}>
            <SelectTrigger className="h-9 w-56"><SelectValue placeholder="All departments" /></SelectTrigger>
            <SelectContent>
              {depts.map((d) => <SelectItem key={d.path} value={d.path}>{d.display_name}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
      )}
      {Object.keys(params).length > 0 && (
        <Button variant="ghost" size="sm" onClick={() => setQueryParams({ from: null, to: null, pay_period: null, department: null })}>Clear</Button>
      )}
    </Card>
  );
}

// ---- Filters and sort -----------------------------------------------------------------------------------

/**
 * The table's OWN narrowing and order, which the server has always taken and nothing could edit: a saved view
 * held `filters` and `sort` that only a hand-written PATCH could reach, so every grid was the whole collection
 * in cursor order and a reader's only recourse was DataTable's per-column boxes - which judge the rows already
 * loaded, not the report.
 *
 * These are saved ON the definition, so they are the same for everyone the table is shared with, and they are
 * applied where the rows are read: in SQL where the field is a plain column of the base, over the assembled
 * page otherwise (services/tableRun.ts). Only columns this reader actually GOT are offered - filtering by a
 * column is not a way to read one, and a filter on a field somebody cannot see would be exactly that.
 */
function FilterSortSheet({ open, onClose, columns, filters, sort, onSave }: {
  open: boolean;
  onClose: () => void;
  columns: TableRunColumn[];
  filters: ViewFilter[];
  sort: ViewSort[];
  onSave: (filters: ViewFilter[], sort: ViewSort[]) => Promise<void>;
}) {
  const [draft, setDraft] = useState<ViewFilter[]>(filters);
  const [order, setOrder] = useState<ViewSort[]>(sort);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  // Re-seed on OPEN only. Keyed on the props instead, a save (which replaces them) would reset the sheet
  // under the author while they were still in it.
  const latest = useRef({ filters, sort });
  latest.current = { filters, sort };
  useEffect(() => {
    if (!open) return;
    setDraft(latest.current.filters);
    setOrder(latest.current.sort);
  }, [open]);

  const kindOf = (field: string) => kindOfField(field, columns);
  const first = columns[0];

  function addFilter() {
    if (!first) return;
    setDraft((d) => [...d, { field: first.key, op: OPS_BY_KIND[first.kind][0]!.op, value: "" }]);
  }
  function setFilter(i: number, next: Partial<ViewFilter>) {
    setDraft((d) => d.map((f, n) => (n === i ? { ...f, ...next } : f)));
  }
  // Changing the column can leave an operator the new kind does not offer (a date has no "contains"). The
  // server TAKES it - its filter schema is the operator vocabulary, not a per-kind one, because the kind is
  // the catalogue's answer at run time - and the runner now gives every such pair one meaning on both halves
  // of the split. So this is about the filter still SAYING something, not about being refused: the operator
  // falls back to that kind's first, and the value goes with it, since a date typed against a text column is
  // not a date.
  function setFilterField(i: number, field: string) {
    const kind = kindOf(field);
    setDraft((d) => d.map((f, n) => {
      if (n !== i) return f;
      const keep = OPS_BY_KIND[kind].some((o) => o.op === f.op);
      return { field, op: keep ? f.op : OPS_BY_KIND[kind][0]!.op, value: keep ? f.value : "" };
    }));
  }

  // A filter with nothing in its box matches nothing and reads as a broken table, so it is not savable -
  // said on the button rather than dropped silently on the way out.
  const incomplete = draft.some((f) => !VALUELESS.includes(f.op) && (f.value === "" || f.value === null || f.value === undefined));

  // Same contract as the column sheet: this owns the write, so it owns saying when the write did not happen.
  async function save() {
    setSaving(true);
    try {
      await onSave(draft.map((f) => (VALUELESS.includes(f.op) ? { field: f.field, op: f.op } : f)), order);
      onClose();
    } catch (e) {
      toast({ title: "Couldn't save the filters", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Filter & sort</SheetTitle>
          <SheetDescription>
            Saved on the table, so everyone who opens it reads the same report - and applied to every page, not
            only the rows already on screen.
          </SheetDescription>
        </SheetHeader>
        <SheetBody className="space-y-6">
          {!columns.length ? (
            <p className="text-sm text-muted-foreground">Pick some columns first - a table is filtered by the columns it shows.</p>
          ) : (
            <>
              <section className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Rows must match all of</p>
                {draft.length === 0 && <p className="text-sm text-muted-foreground">No filters: the table shows every row you can see.</p>}
                {draft.map((f, i) => {
                  const kind = kindOf(f.field);
                  return (
                    <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
                      <Select value={f.field} onValueChange={(v) => setFilterField(i, v)}>
                        <SelectTrigger className="h-9 w-full sm:w-52" aria-label="Column"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {columns.map((c) => <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <Select value={f.op} onValueChange={(v) => setFilter(i, { op: v as FilterOp, ...(VALUELESS.includes(v as FilterOp) ? { value: "" } : {}) })}>
                        <SelectTrigger className="h-9 w-full sm:w-40" aria-label="Condition"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {OPS_BY_KIND[kind].map((o) => <SelectItem key={o.op} value={o.op}>{o.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      {!VALUELESS.includes(f.op) && <FilterValue kind={kind} op={f.op} value={f.value} onChange={(v) => setFilter(i, { value: v })} />}
                      <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" aria-label="Remove this filter" onClick={() => setDraft((d) => d.filter((_, n) => n !== i))}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  );
                })}
                <Button variant="outline" size="sm" onClick={addFilter} disabled={draft.length >= MAX_FILTERS}>
                  <Plus className="h-4 w-4" /> Add filter
                </Button>
                {draft.length >= MAX_FILTERS && <p className="text-xs text-muted-foreground">A table holds at most {MAX_FILTERS} filters.</p>}
              </section>

              <section className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Sorted by</p>
                {order.length === 0 && <p className="text-sm text-muted-foreground">No sort: rows come back in the order the records were created.</p>}
                {order.map((s, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
                    <Select value={s.field} onValueChange={(v) => setOrder((o) => o.map((x, n) => (n === i ? { ...x, field: v } : x)))}>
                      <SelectTrigger className="h-9 w-full sm:w-52" aria-label="Sort column"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {columns.map((c) => <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setOrder((o) => o.map((x, n) => (n === i ? { ...x, dir: x.dir === "asc" ? "desc" : "asc" } : x)))}
                    >
                      {s.dir === "asc" ? <><ArrowUp className="h-4 w-4" /> Smallest first</> : <><ArrowDown className="h-4 w-4" /> Largest first</>}
                    </Button>
                    <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" aria-label="Remove this sort" onClick={() => setOrder((o) => o.filter((_, n) => n !== i))}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={order.length >= MAX_SORTS || !first}
                  onClick={() => first && setOrder((o) => [...o, { field: first.key, dir: "desc" }])}
                >
                  <Plus className="h-4 w-4" /> Add sort
                </Button>
              </section>
            </>
          )}
        </SheetBody>
        <div className="flex items-center justify-between gap-2 border-t p-4">
          <span className="text-xs text-muted-foreground">
            {incomplete ? "Give every filter a value." : `${draft.length} filter${draft.length === 1 ? "" : "s"}, ${order.length} sort${order.length === 1 ? "" : "s"}`}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={() => save()} disabled={saving || incomplete}>{saving ? "Saving…" : "Save"}</Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** The right box for what is being compared: a date picker for a date, a number for money, Yes/No for a flag. */
function FilterValue({ kind, op, value, onChange }: {
  kind: TableFieldKind;
  op: FilterOp;
  value: ViewFilter["value"];
  onChange: (v: string) => void;
}) {
  const v = value === null || value === undefined ? "" : String(value);
  const className = "h-9 w-full sm:w-44";
  // `in` is a comma-separated LIST whatever the kind is, so it always takes free text.
  if (op === "in") return <Input value={v} onChange={(e) => onChange(e.target.value)} placeholder="open, blocked" className={className} aria-label="Values" />;
  if (kind === "bool") {
    return (
      <Select value={v} onValueChange={onChange}>
        <SelectTrigger className={className} aria-label="Value"><SelectValue placeholder="Yes or no" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="true">Yes</SelectItem>
          <SelectItem value="false">No</SelectItem>
        </SelectContent>
      </Select>
    );
  }
  if (kind === "date" || kind === "datetime") return <Input type="date" value={v} onChange={(e) => onChange(e.target.value)} className={className} aria-label="Value" />;
  if (kind === "money" || kind === "number") return <Input type="number" value={v} onChange={(e) => onChange(e.target.value)} className={className} aria-label="Value" />;
  return <Input value={v} onChange={(e) => onChange(e.target.value)} placeholder="Value" className={className} aria-label="Value" />;
}

// ---- The field picker -----------------------------------------------------------------------------------

function ColumnPicker({ open, onClose, base, catalogue, selected, headers, onSave, canExport }: {
  open: boolean;
  onClose: () => void;
  /**
   * What the TABLE says a row is, which is not always what the catalogue in hand describes. Changing the base
   * re-fetches the catalogue, and until it lands the picker still holds the previous base's fields: opened in
   * that window it offered a departments table the fields of a person, and the swap - when it came - reset the
   * search and the trail under whoever was standing in them. It waits instead.
   */
  base: string;
  catalogue: TableCatalogue;
  /** The table's columns, IN ORDER, each with the header its author gave it. */
  selected: ChosenColumn[];
  /** What the grid drew, so the chosen list can name a column the way the reader has just seen it named. */
  headers: TableRunColumn[];
  onSave: (columns: ChosenColumn[]) => Promise<void>;
  canExport: boolean;
}) {
  const [picked, setPicked] = useState<ChosenColumn[]>(selected);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();
  // Where in the join the picker is standing. `[]` is the base; each entry is one link, in the order they
  // were followed, so the trail doubles as the breadcrumb and as the `?path=` the server is asked for.
  const [trail, setTrail] = useState<TableLink[]>([]);
  const [node, setNode] = useState<TableCatalogue>(catalogue);
  const [loadingNode, setLoadingNode] = useState(false);
  // What each chosen column is CALLED, by key: `short` is the header it has on the grid, `full` the whole
  // trail behind it. Held here rather than looked up, so a column keeps its name after the picker has walked
  // somewhere else - and so a saved table's columns have names before it has walked anywhere at all.
  const [names, setNames] = useState<Record<string, { short: string; full: string }>>({});

  // Start over when the picker OPENS, or when the table's base changes under it - and on nothing else. Keyed
  // on the identity of `selected` and `catalogue` instead, this fired on every parent render (the grid's rows
  // arriving, a column resize): the search box emptied and the trail jumped back to the base while somebody
  // was standing in it, and a tick landed on whatever row had moved under the cursor.
  //
  // A base ARRIVING is not a base CHANGING, and that distinction is the rest of the same bug. The catalogue is
  // fetched after the page renders, so a picker opened promptly - or opened right after a rebase - sees `base`
  // go from empty to the real one a moment later. Read as a change, that wiped the search box under somebody
  // already typing into it: the faster they were, the more reliably they lost the text. Only a move between two
  // KNOWN bases starts over.
  //
  // A LAYOUT effect, so the start-over lands before the new base's fields are ever painted. As a passive effect
  // it ran after the paint, in a task a busy machine can hold back: the search box for the new base was on
  // screen and could be typed into, and React flushes a pending passive effect before rendering the keystroke.
  // That queued this `setQuery("")` BEHIND the typed text, so the text was wiped the moment it landed.
  const latest = useRef({ selected, catalogue });
  latest.current = { selected, catalogue };
  const shownBase = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      shownBase.current = null; // so the next open starts over, whatever it opens on
      return;
    }
    const base = latest.current.catalogue.base;
    const prev = shownBase.current;
    const rebased = !!base && !!prev && base !== prev;
    if (prev === null || rebased) {
      setPicked(latest.current.selected);
      setQuery("");
      setTrail([]);
      setNode(latest.current.catalogue);
    }
    shownBase.current = base || prev;
  }, [open, catalogue.base]);

  // The base's own fields can arrive (or be re-fetched) after the picker is already open. While standing AT
  // the base that is what the picker shows - and it touches nothing the reader has done: not the query, not
  // the trail, not what they have ticked. A layout effect for the same reason as the one above: painted first,
  // the new base's breadcrumb stood over the old base's fields for a frame, and anything ticked in it was a
  // field of the wrong record.
  useLayoutEffect(() => {
    if (!trail.length) setNode(catalogue);
  }, [catalogue, trail.length]);

  // What the GRID calls each column, which is the first thing the chosen list should say. Browsing filled
  // this in before, and only for the nodes somebody happened to walk: open a saved table with a column two
  // hops out and the list showed `manager_id.department_id.name` - the storage key, in the one place whose
  // job is to say what the table reads like. The running grid has already named every column it drew, so the
  // list is told rather than left to find out, and the two agree word for word.
  useEffect(() => {
    setNames((n) => {
      const next = { ...n };
      for (const c of headers) next[c.key] = { short: c.label, full: c.full_label ?? c.label };
      return next;
    });
  }, [headers]);

  // ...and every label this picker itself has seen, for a column that was ticked a moment ago and has no
  // header on the grid yet. The trail-QUALIFIED one both times: the list stands outside the node a field came
  // from, where "Name" on its own says nothing about whose name it is.
  useEffect(() => {
    setNames((n) => {
      const next = { ...n };
      for (const f of node.fields) {
        if (next[f.key]) continue; // the grid's own word for it wins - it is what the reader will see
        next[f.key] = { short: f.column_label ?? f.label, full: f.column_label ?? f.label };
      }
      return next;
    });
  }, [node]);

  // Follow a link: one request for that node's own fields and its own links. Nothing below is fetched until
  // somebody opens it, which is what lets the join go as deep as the reader cares to walk.
  async function open_(link: TableLink) {
    if (!catalogue.base) return;
    setLoadingNode(true);
    try {
      const next = await get<TableCatalogue>(`table-fields?base=${encodeURIComponent(catalogue.base)}&path=${encodeURIComponent(link.path)}`);
      setNode(next);
      setTrail((t) => [...t, link]);
      setQuery("");
    } finally {
      setLoadingNode(false);
    }
  }

  async function goTo(depth: number) {
    if (!catalogue.base) return;
    const next = trail.slice(0, depth);
    setLoadingNode(true);
    try {
      const path = next.length ? next[next.length - 1]!.path : "";
      const answer = path
        ? await get<TableCatalogue>(`table-fields?base=${encodeURIComponent(catalogue.base)}&path=${encodeURIComponent(path)}`)
        : catalogue;
      setNode(answer);
      setTrail(next);
      setQuery("");
    } finally {
      setLoadingNode(false);
    }
  }

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byGroup = new Map<string, TableField[]>();
    for (const f of node.fields) {
      if (q && !f.label.toLowerCase().includes(q) && !f.group.toLowerCase().includes(q)) continue;
      const list = byGroup.get(f.group) ?? [];
      list.push(f);
      byGroup.set(f.group, list);
    }
    return [...byGroup.entries()];
  }, [node, query]);

  const shownLinks = useMemo(() => {
    const q = query.trim().toLowerCase();
    return node.links.filter((l) => !q || l.label.toLowerCase().includes(q) || l.collection_label.toLowerCase().includes(q));
  }, [node, query]);

  const has = (key: string) => picked.some((c) => c.field === key);
  const toggle = (key: string) => setPicked((p) => (p.some((c) => c.field === key) ? p.filter((c) => c.field !== key) : [...p, { field: key }]));
  // The order of the list IS the order of the grid, so moving a column is an edit of the table like any other.
  const move = (i: number, by: -1 | 1) =>
    setPicked((p) => {
      const to = i + by;
      if (to < 0 || to >= p.length) return p;
      const next = [...p];
      const [row] = next.splice(i, 1);
      next.splice(to, 0, row!);
      return next;
    });
  // A blank rename is not a header called "": it is "use the catalogue's own name", which is what the
  // placeholder says and what the stored spec means by no label at all.
  const rename = (i: number, label: string) =>
    setPicked((p) => p.map((c, n) => (n === i ? (label.trim() ? { field: c.field, label: label.trim() } : { field: c.field }) : c)));

  // The save OWNS its failure, the way WriteDialog does for the dialogs next door: a rejected PATCH used to
  // unwind out of here as an unhandled rejection, so a conflict (the table edited in another tab, or by whoever
  // it is shared with) stopped the spinner, closed nothing, said nothing, and left the reader looking at a
  // column list that had not been saved. The sheet stays OPEN on a failure so the picking is not lost.
  async function save() {
    setSaving(true);
    try {
      await onSave(picked);
      onClose();
    } catch (e) {
      toast({ title: "Couldn't save the columns", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Columns</SheetTitle>
          <SheetDescription>
            Every field you can read on this record - and every record it points at. Fields and links you have
            no access to are not listed at all.
          </SheetDescription>
        </SheetHeader>
        <SheetBody className="space-y-4">
          {catalogue.base !== base ? (
            // A shaped placeholder, not the word "Loading": the rows are about to arrive in this geometry, and
            // a centred line of text is a zero state's shape for something that is on its way
            // (test/responsiveCoverage.test.ts holds the whole app to this).
            <RowsSkeleton rows={6} />
          ) : (
          <>
          {/* The trail through the join, and the way back up it. */}
          <nav className="flex flex-wrap items-center gap-1 text-sm" aria-label="Field path">
            <button className={cn("rounded px-1.5 py-0.5 hover:bg-muted", !trail.length && "font-medium")} onClick={() => void goTo(0)}>
              {catalogue.label ?? "Base"}
            </button>
            {trail.map((link, i) => (
              <span key={link.path} className="flex items-center gap-1">
                <ChevronRight className="h-3 w-3 text-muted-foreground" />
                <button className={cn("rounded px-1.5 py-0.5 hover:bg-muted", i === trail.length - 1 && "font-medium")} onClick={() => void goTo(i + 1)}>
                  {link.label}
                </button>
              </span>
            ))}
          </nav>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} disabled={loadingNode} placeholder={`Search ${trail.length ? trail[trail.length - 1]!.label.toLowerCase() : (catalogue.label ?? "").toLowerCase()} fields`} className="pl-8" />
          </div>
          {/* THE TABLE AS IT WILL READ. A row of chips said which fields were on it and nothing else: not what
              order they came in (the order of picking, which nobody chose), and not what their headers say
              (the catalogue's mechanical name - "Ctc annual" over a salary sheet's main column). Both are
              stored on the view and neither could be edited from anywhere. */}
          {picked.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">On the table, in order</p>
              {picked.map((col, i) => {
                // Two names, and the row says both: the header the grid shows, in the box the author types
                // over, and the trail that reaches the field underneath it. One of them is what the table
                // reads like and the other is which field it IS, and a list that gave only one always gave
                // the wrong one to somebody.
                const named = names[col.field];
                const short = named?.short ?? nameFromKey(col.field);
                const full = named?.full ?? nameFromKey(col.field);
                return (
                  <div key={col.field} className="flex items-start gap-1 rounded-md border p-1.5">
                    <GripVertical className="mt-1.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <Input
                        value={col.label ?? ""}
                        placeholder={short}
                        aria-label={`Header for ${full}`}
                        onChange={(e) => rename(i, e.target.value)}
                        className="h-8 w-full border-0 bg-transparent px-1 shadow-none focus-visible:ring-1"
                      />
                      {/* Only where it says something the header does not: a base column is its own trail. */}
                      {full !== short && <p className="truncate px-1 text-xs text-muted-foreground" title={full}>{full}</p>}
                    </div>
                    <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" disabled={i === 0} aria-label={`Move ${full} earlier`} onClick={() => move(i, -1)}>
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" disabled={i === picked.length - 1} aria-label={`Move ${full} later`} onClick={() => move(i, 1)}>
                      <ArrowDown className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label={`Remove ${full}`} onClick={() => toggle(col.field)}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
          {/* Where this record points. Following one is a join: its own fields, and its own links after that. */}
          {shownLinks.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Related records</p>
              <div className="grid gap-1 sm:grid-cols-2">
                {shownLinks.map((link) => (
                  <button
                    key={link.path}
                    onClick={() => void open_(link)}
                    disabled={loadingNode}
                    className="flex items-center justify-between gap-2 rounded-md border p-2 text-left text-sm hover:bg-muted disabled:opacity-60"
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{link.label}</span>
                      <span className="block truncate text-xs text-muted-foreground">{link.collection_label}</span>
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </button>
                ))}
              </div>
            </div>
          )}
          {/* The node being walked TO is not here yet, and the one being walked away from must not be ticked in
              the meantime: its fields look identical (a manager is a person, so "First name" is on offer at
              both) and the chip that comes back reads the same either way, so a tick landing a hop early is a
              wrong column nobody can see is wrong. The list goes away until the answer arrives. */}
          {loadingNode ? (
            <RowsSkeleton rows={6} />
          ) : (
          <div className="space-y-4">
            {groups.length === 0 && !shownLinks.length && <p className="text-sm text-muted-foreground">No fields match "{query}".</p>}
            {groups.map(([group, fields]) => (
              <div key={group}>
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{group}</p>
                <div className="grid gap-1 sm:grid-cols-2">
                  {fields.map((f) => (
                    <label key={f.key} className={cn("flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm", has(f.key) && "border-primary/40 bg-primary/5")}>
                      <Checkbox className="mt-0.5" checked={has(f.key)} onCheckedChange={() => toggle(f.key)} />
                      <span className="min-w-0">
                        <span className="block truncate">{f.label}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {f.collection}
                          {f.masked && <span className="ml-1 inline-flex items-center gap-0.5"><Lock className="h-3 w-3" /> masked</span>}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
          )}
          </>
          )}
        </SheetBody>
        <div className="flex items-center justify-between gap-2 border-t p-4">
          <span className="text-xs text-muted-foreground">
            {picked.length} column{picked.length === 1 ? "" : "s"}
            {canExport ? " · exportable from the table" : ""}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={save} disabled={saving || catalogue.base !== base}>{saving ? "Saving…" : "Save columns"}</Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
