import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Columns3, Lock, Plus, RefreshCw, Table2, Trash2, Pencil, Search, X } from "lucide-react";
import { api, create, get, patch, remove } from "@/api";
import { navigate, useRoute, setQueryParams } from "@/router";
import { cn, formatDate, idOf } from "@/lib/utils";
import { useMoney } from "@/lib/org";
import { usePermission } from "@/lib/perm";
import { useCollection } from "@/hooks/useCollection";
import { useIntent } from "@/lib/intent";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";
import type { Department, Me, PayPeriod, TableCatalogue, TableField, TableLink, TableRunResult, TableView } from "@/types";
import { DataTable, type Column } from "@/components/common/DataTable";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/common/PageHeader";
import { RowsSkeleton } from "@/components/common/Skeletons";
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

type ViewSpec = {
  columns: { field: string; label?: string; hidden?: boolean }[];
  params: Record<string, string>;
};

const specOf = (v: TableView): ViewSpec => ({
  columns: (v.columns ?? []).map((c) => ({ field: c.field, label: c.label, hidden: c.hidden })),
  params: (v.params ?? {}) as Record<string, string>,
});

export default function TableBuilder({ openId }: { me: Me; openId?: string }) {
  return openId ? <OneTable id={openId} /> : <TableList />;
}

// ---- The saved tables -----------------------------------------------------------------------------------

function TableList() {
  const { rows, state, error, reload } = useCollection<TableView>("table-views");
  const { toast } = useToast();
  const confirm = useConfirm();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ display_name: "", description: "", base: "" });
  const [bases, setBases] = useState<{ collection: string; label: string }[]>([]);
  const [catalogueDenied, setCatalogueDenied] = useState(false);
  const openCreate = useCallback(() => {
    setForm({ display_name: "", description: "", base: bases[0]?.collection ?? "" });
    setCreating(true);
  }, [bases]);
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
    const created = await create<TableView>("table-views", {
      display_name: form.display_name.trim(),
      description: form.description.trim() || null,
      base: form.base,
      columns: [],
    });
    toast({ title: "Table created", description: "Pick its columns to fill it in.", variant: "success" });
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

  async function del(view: TableView) {
    if (!(await confirm({ title: `Delete "${view.display_name}"?`, description: "Anyone it was shared with loses it too.", destructive: true, confirmLabel: "Delete" }))) return;
    try {
      await remove(`table-views/${idOf(view.path)}`, view.etag);
      reload();
    } catch (e) {
      toast({ title: "Couldn't delete", description: (e as Error).message, variant: "destructive" });
    }
  }

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
    { id: "base", header: "Rows are", accessor: (r) => baseLabel.get(r.base) ?? r.base, filter: "select", mobilePriority: 2 },
    { id: "columns", header: "Columns", accessor: (r) => (r.columns ?? []).length, align: "right" },
    { id: "updated", header: "Updated", accessor: (r) => r.update_time, cell: (r) => formatDate(r.update_time), mobilePriority: 3 },
    {
      id: "actions",
      header: "",
      cell: (r) => (
        <div className="flex justify-end gap-1">
          <AccessAction objectPath={r.path} can={r.access?.can} verb="update" label={r.display_name}>
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Open" onClick={() => navigate(`tables/${idOf(r.path)}`)}><Pencil className="h-3.5 w-3.5" /></Button>
          </AccessAction>
          <AccessAction objectPath={r.path} can={r.access?.can} verb="delete" label={r.display_name}>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" aria-label="Delete" onClick={() => void del(r)}><Trash2 className="h-3.5 w-3.5" /></Button>
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
        description="Pick what one row of the table is. You choose its columns next, and only ever from fields you can already read."
        collection="table-views"
        form={form}
        submitLabel="Create"
        canSubmit={!!form.display_name.trim() && !!form.base}
        whyNot={!form.display_name.trim() ? "Give the table a name." : "Pick what one row is."}
        onSubmit={submit}
      >
        <Field label="Name">
          <Input value={form.display_name} placeholder="e.g. Salary sheet - March" onChange={(e) => setForm({ ...form, display_name: e.target.value })} autoFocus />
        </Field>
        <Field label="Description (optional)">
          <Input value={form.description} placeholder="What this table is for" onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <Field label="One row is" hint="The collection the table is built on. Everything else joins onto it.">
          <Select value={form.base} onValueChange={(v) => setForm({ ...form, base: v })}>
            <SelectTrigger><SelectValue placeholder="Pick a base" /></SelectTrigger>
            <SelectContent>
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
  const canExport = usePermission("export.read");
  const [view, setView] = useState<TableView | null>(null);
  const [catalogue, setCatalogue] = useState<TableCatalogue | null>(null);
  const [result, setResult] = useState<TableRunResult | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
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

  async function saveColumns(fields: string[]) {
    if (!view) return;
    const spec = specOf(view);
    const kept = new Map(spec.columns.map((c) => [c.field, c]));
    const updated = await patch<TableView>(`table-views/${id}`, { columns: fields.map((f) => kept.get(f) ?? { field: f }) }, view.etag);
    setView(updated);
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
      align: col.kind === "money" || col.kind === "number" ? ("right" as const) : undefined,
      // The accessor is the RAW value: it is what sorts, filters and exports, so a money column exports as a
      // number rather than as "₹12,00,000" that no spreadsheet can add up.
      accessor: (row) => (row.denied?.includes(col.key) ? null : (row.cells[col.key] as string | number | boolean | null | undefined)),
      cell: (row) => renderCell(col, row, money),
      ...(col.kind === "money" ? { aggregate: "sum" as const, formatTotal: (n: number) => money(n) } : {}),
      filter: col.kind === "enum" || col.kind === "bool" ? ("select" as const) : ("text" as const),
    }));
  }, [result, money]);

  const selected = useMemo(() => (view?.columns ?? []).map((c) => c.field), [view]);
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
            columns={columns}
            rows={result?.rows ?? []}
            getRowId={(r) => r.path}
            tableId={`table-view-${id}`}
            emptyTitle="No rows"
            emptyDescription="Nothing you can see matches this table yet."
            hasMore={!!result?.next_page_token && (result?.rows.length ?? 0) < ROW_CEILING}
            onLoadMore={loadMore}
            title={
              <span className="flex items-center gap-2">
                <span>{(result?.rows.length ?? 0).toLocaleString()} rows</span>
                {result?.columns.some((c) => c.masked) && (
                  <Badge variant="muted" className="gap-1"><Lock className="h-3 w-3" /> Some values masked</Badge>
                )}
              </span>
            }
          />
        )}
      </DataState>

      {catalogue && (
        <ColumnPicker
          open={picking}
          onClose={() => setPicking(false)}
          catalogue={catalogue}
          selected={selected}
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

// ---- The field picker -----------------------------------------------------------------------------------

function ColumnPicker({ open, onClose, catalogue, selected, onSave, canExport }: {
  open: boolean;
  onClose: () => void;
  catalogue: TableCatalogue;
  selected: string[];
  onSave: (fields: string[]) => Promise<void>;
  canExport: boolean;
}) {
  const [picked, setPicked] = useState<string[]>(selected);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  // Where in the join the picker is standing. `[]` is the base; each entry is one link, in the order they
  // were followed, so the trail doubles as the breadcrumb and as the `?path=` the server is asked for.
  const [trail, setTrail] = useState<TableLink[]>([]);
  const [node, setNode] = useState<TableCatalogue>(catalogue);
  const [loadingNode, setLoadingNode] = useState(false);
  // Labels for keys that came from a node this session is no longer standing on, so a chip keeps its name
  // after the picker has walked somewhere else.
  const [labels, setLabels] = useState<Record<string, string>>({});

  // Start over when the picker OPENS, or when the table's base changes under it - and on nothing else. Keyed
  // on the identity of `selected` and `catalogue` instead, this fired on every parent render (the grid's rows
  // arriving, a column resize): the search box emptied and the trail jumped back to the base while somebody
  // was standing in it, and a tick landed on whatever row had moved under the cursor.
  const latest = useRef({ selected, catalogue });
  latest.current = { selected, catalogue };
  useEffect(() => {
    if (!open) return;
    setPicked(latest.current.selected);
    setQuery("");
    setTrail([]);
    setNode(latest.current.catalogue);
  }, [open, catalogue.base]);

  // The base's own fields can arrive (or be re-fetched) after the picker is already open. While standing AT
  // the base that is what the picker shows - and it touches nothing the reader has done: not the query, not
  // the trail, not what they have ticked.
  useEffect(() => {
    if (!trail.length) setNode(catalogue);
  }, [catalogue, trail.length]);

  // Remember every label this picker has seen, so a chip for a field two hops away still reads as a name.
  useEffect(() => {
    setLabels((l) => {
      const next = { ...l };
      for (const f of node.fields) next[f.key] = f.label;
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

  const toggle = (key: string) => setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));

  async function save() {
    setSaving(true);
    try {
      await onSave(picked);
      onClose();
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
          {picked.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {picked.map((key) => (
                <button key={key} onClick={() => toggle(key)} className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-xs hover:bg-muted">
                  {labels[key] ?? key} <X className="h-3 w-3" />
                </button>
              ))}
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
                    <label key={f.key} className={cn("flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm", picked.includes(f.key) && "border-primary/40 bg-primary/5")}>
                      <Checkbox className="mt-0.5" checked={picked.includes(f.key)} onCheckedChange={() => toggle(f.key)} />
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
        </SheetBody>
        <div className="flex items-center justify-between gap-2 border-t p-4">
          <span className="text-xs text-muted-foreground">
            {picked.length} column{picked.length === 1 ? "" : "s"}
            {canExport ? " · exportable from the table" : ""}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save columns"}</Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
