import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Pencil, Trash2, UserCheck, Undo2, Printer, ScanLine, BadgeCheck, HandHeart, RefreshCw, Boxes } from "lucide-react";
import { create, get, patch, remove, invoke } from "@/api";
import { navigate, setQueryParam, useRoute } from "@/router";
import { useCollection } from "@/hooks/useCollection";
import { formatDate, idOf } from "@/lib/utils";
import { cn } from "@/lib/utils";
import type { Asset, AssetCategory, Employee, Me, Stocktake as StocktakeRecord } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { Chart, ChartCard } from "@/components/common/Chart";
import { topSlices } from "@/lib/chartTheme";
import { DataState } from "@/components/common/DataState";
import { DataTable, type Column } from "@/components/common/DataTable";
import { metaColumns } from "@/components/common/metaColumns";
import { Field, FieldRow } from "@/components/common/Field";
import { WriteDialog } from "@/components/common/WriteDialog";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AccessAction } from "@/components/access/AccessAction";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";
import { AssetTagPrinter } from "@/components/assets/AssetTagPrinter";
import { BulkAddAssets } from "@/components/assets/BulkAddAssets";
import { Stocktake } from "@/components/assets/Stocktake";
import { AssetCustodyDialog, type CustodyMode } from "@/components/assets/AssetCustody";
import { SerialScanPanel } from "@/components/assets/SerialScanPanel";
import { daysSince } from "@/lib/stocktake";
import { ASSET_MANUAL_STATUSES, ASSET_STATUS_LABEL, ASSET_STATUS_TONE, ASSET_CONDITION_LABEL } from "@/lib/assetTags";
import { PageSettings } from "@/components/common/SettingsButton";

// Categories are org data (`asset-categories`), not a list in here: the category decides the code inside the
// tag the server allocates, so the two have to agree, and only the collection can guarantee that.
// Only the two states a human sets by hand are offered in the form. `in_stock` and `assigned` are EARNED (a
// scan produces them) and the pending states are what an unproven asset falls into by itself, so putting any
// of the four in a dropdown would promise an edit the server will refuse to honour.
const STATUSES: { value: Asset["status"]; label: string }[] = [
  { value: "in_stock", label: "In stock (needs a check-in scan)" },
  { value: "assigned", label: "Assigned (needs the holder's scan)" },
  ...ASSET_MANUAL_STATUSES.map((v) => ({ value: v as Asset["status"], label: ASSET_STATUS_LABEL[v]! })),
];

// The bands the summary counts in - and filters the table by. One definition for both: the tile and the rows it
// opens are the same predicate, so they cannot disagree about how many there are. `label` is what the table's
// heading says while that band is showing.
type AssetBand = "pending" | "assigned" | "in_stock" | "repair" | "untagged" | "unseen";
// Kit nobody has laid eyes on for this long is what a stocktake exists to find.
const UNSEEN_DAYS = 90;
const BANDS: { id: AssetBand; label: string; hint: string; match: (a: Asset) => boolean }[] = [
  // The to-do list rather than a fact: both pending states are somebody owing a scan.
  { id: "pending", label: "Awaiting scan", hint: "somebody owes a scan", match: (a) => a.status === "pending_verification" || a.status === "pending_ack" },
  { id: "assigned", label: "Assigned", hint: "holder confirmed", match: (a) => a.status === "assigned" },
  { id: "in_stock", label: "In stock", hint: "ready to hand out", match: (a) => a.status === "in_stock" },
  { id: "repair", label: "In repair", hint: "away being fixed", match: (a) => a.status === "repair" },
  // Two gaps that only ever show up as absences: no sticker to scan, and no sighting on record for months.
  { id: "untagged", label: "No tag", hint: "print one to scan", match: (a) => !a.asset_tag },
  {
    id: "unseen", label: `Unseen ${UNSEEN_DAYS}d+`, hint: "no sighting on record",
    match: (a) => a.status !== "retired" && (!a.last_verified_time || (Date.now() - Date.parse(a.last_verified_time)) / 86400000 > UNSEEN_DAYS),
  },
];

// Colour says whether a number wants doing something about: a queue or a repair bench with anything in it is
// amber, kit somebody holds is the page's normal state, and an empty band is just grey.
const TILE_TONE: Record<AssetBand, (n: number) => "warning" | "primary" | "default" | "muted"> = {
  pending: (n) => (n > 0 ? "warning" : "muted"),
  assigned: (n) => (n > 0 ? "primary" : "muted"),
  in_stock: () => "default",
  repair: (n) => (n > 0 ? "warning" : "muted"),
  untagged: (n) => (n > 0 ? "warning" : "muted"),
  unseen: (n) => (n > 0 ? "warning" : "muted"),
};

// `quantity` is a create-time multiplier, never a column: things arriving in bulk (a bag of twenty adapters)
// still become twenty records, because a sticker, a scan and a holder are all per object. Above one, the create
// goes through `assets:batchCreate` so the tags come out as one contiguous run.
const EMPTY = { asset_tag: "", name: "", category: "", serial_number: "", status: "in_stock" as Asset["status"], assigned_to: "", assigned_on: "", purchase_date: "", notes: "", quantity: 1 };
type Form = typeof EMPTY;

export default function Assets({ me, openId }: { me: Me; openId?: string }) {
  const { rows, state, error, reload } = useCollection<Asset>("assets");
  const route = useRoute();
  // A deep link WITH a tag secret is a scan, not a request to edit the row - the custody dialog below claims it.
  useDeepOpen(route.query.s ? undefined : openId, rows, openEdit);
  const { rows: employees } = useCollection<Employee>("employees");
  const { rows: categories } = useCollection<AssetCategory>("asset-categories");
  const { toast } = useToast();
  const confirm = useConfirm();

  const [open, setOpen] = useState(false);
  const [bulk, setBulk] = useState(false);
  // What the bulk dialog created while it was open, held until it closes (see its onClose below).
  const bulkCreated = useRef<string[]>([]);
  const [printer, setPrinter] = useState<{ initialAssetIds?: string[] } | null>(null);
  // `?stocktake=new` opens the walk on a fresh count, `?stocktake=<id>` resumes that one: the Stocktakes page
  // sends people here to scan, since the camera and the tag secrets live on this page.
  const [stocktake, setStocktake] = useState<string | null>(route.query.stocktake ?? null);
  const [editing, setEditing] = useState<Asset | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [custody, setCustody] = useState<{ asset: Asset; mode: CustodyMode; scan?: string } | null>(null);
  // Camera open on the serial field of the form. Closed on every open of the dialog (see openEdit/openNew).
  const [scanSerial, setScanSerial] = useState(false);
  const myId = me.employee_id ?? undefined;

  // A tag's QR is a deep link carrying the asset's secret (`#/assets/<id>?s=…`), so pointing a phone at the
  // sticker lands here with the proof already in hand. Open the one action that scan makes possible for THIS
  // viewer - confirm receipt if it is theirs to confirm, count it in if they may verify - rather than
  // dropping them on a list they then have to search.
  useEffect(() => {
    const secret = route.query.s;
    if (!secret || !route.id || custody) return;
    const asset = rows.find((r) => idOf(r.path) === route.id);
    if (!asset) return;
    const mode: CustodyMode | null =
      asset.assigned_to && idOf(asset.assigned_to) === myId && asset.status === "pending_ack" ? "acknowledge"
      : asset.access?.can?.includes("verify") ? "verify"
      : null;
    if (mode) setCustody({ asset, mode, scan: `${window.location.origin}/#/assets/${route.id}?s=${secret}` });
    // Scanning a tag should never look like nothing happened: say what was scanned and why there is no action.
    else toast({ title: `Scanned ${asset.name}`, description: asset.status === "pending_ack" ? "It is waiting on the person it was assigned to." : "Nothing to confirm on this one right now." });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.id, route.query.s, rows, myId]);

  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (p?: string) => (p ? m.get(idOf(p)) ?? idOf(p) : "-");
  }, [employees]);

  // The category the form currently names, for the serial-number hint (the server enforces it either way).
  const selectedCategory = useMemo(() => categories.find((c) => c.path === form.category), [categories, form.category]);

  const catName = useMemo(() => {
    const m = new Map(categories.map((c) => [idOf(c.path), c.display_name ?? ""]));
    return (p?: string) => (p ? m.get(idOf(p)) ?? idOf(p) : "");
  }, [categories]);

  // Inventory summary across the assets the caller can see (server-scoped). "Awaiting scan" leads because it
  // is the only number here that is a to-do list rather than a fact.
  //
  // Each number is also the filter for it: a count you have to re-create by hand in the table's own status
  // filter is a count you mostly read and move on from. Both come off the SAME predicate (BANDS below), so a
  // tile that says 12 always opens 12 rows.
  const summary = useMemo(
    () => ({ total: rows.length, ...Object.fromEntries(BANDS.map((b) => [b.id, rows.filter(b.match).length])) as Record<AssetBand, number> }),
    [rows],
  );
  // The same rows the strip counts, as proportions. States come from the shared status labels so the chart
  // and every status badge in the app read the same word for the same state.
  const assetCharts = useMemo(() => ({
    states: topSlices(rows, (a) => ASSET_STATUS_LABEL[a.status] ?? a.status, () => 1, 7),
    categories: topSlices(rows, (a) => catName(a.category) || "Uncategorised", () => 1, 7),
  }), [rows, catName]);
  const [band, setBand] = useState<AssetBand | null>(null);
  const shown = useMemo(() => {
    const match = BANDS.find((b) => b.id === band)?.match;
    return match ? rows.filter(match) : rows;
  }, [rows, band]);

  // The assets THIS viewer personally owes a scan for - the one thing on this page they cannot delegate. Held
  // to rows they may actually `acknowledge`, so the banner and its tile never offer a scan the server refuses.
  const mineToConfirm = useMemo(
    () => rows.filter((a) => a.status === "pending_ack" && a.assigned_to && idOf(a.assigned_to) === myId && (a.access?.can ?? []).includes("acknowledge")),
    [rows, myId],
  );

  function openCreate() {
    setEditing(null);
    setForm(EMPTY);
    setScanSerial(false);
    setOpen(true);
  }
  function openEdit(a: Asset) {
    setEditing(a);
    setScanSerial(false);
    setForm({
      asset_tag: a.asset_tag ?? "",
      name: a.name ?? "",
      category: a.category ?? "",
      serial_number: a.serial_number ?? "",
      status: a.status,
      assigned_to: a.assigned_to ?? "",
      assigned_on: a.assigned_on ?? "",
      purchase_date: a.purchase_date ?? "",
      notes: a.notes ?? "",
      quantity: 1, // an existing record is one thing; the multiplier only ever applies to a create
    });
    setOpen(true);
  }

  // Whether a scanned serial is already on another asset. Not a validation (the server allows it, and two
  // labels genuinely can repeat across vendors) - it is there to catch the same machine being added twice.
  const serialOwner = useCallback(
    (serial: string) => {
      const s = serial.trim().toLowerCase();
      if (!s) return undefined;
      return rows.find((a) => a.path !== editing?.path && (a.serial_number ?? "").trim().toLowerCase() === s)?.name;
    },
    [rows, editing],
  );

  // Changing the assignee nudges the status (assigned <-> in stock); the user can still override it (e.g. repair).
  function setAssignee(v: string) {
    setForm((f) => ({ ...f, assigned_to: v, status: v ? (f.status === "in_stock" ? "assigned" : f.status) : (f.status === "assigned" ? "in_stock" : f.status) }));
  }

  // Above one, this form is a delivery rather than a thing: the serial and the assignee stop making sense (a
  // serial names ONE device, and twenty things are handed over one scan at a time), so they step aside.
  const many = !editing && form.quantity > 1;

  async function save() {
    if (many) {
      const { results } = await invoke<{ results: Asset[] }>("assets", "batchCreate", undefined, {
        items: [{
          name: form.name.trim(),
          ...(form.category ? { category: form.category } : {}),
          ...(form.purchase_date ? { purchase_date: form.purchase_date } : {}),
          ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
          quantity: form.quantity,
        }],
      });
      toast({ title: `Added ${results.length} - print their stickers, then scan them into stock`, variant: "success" });
      await reload();
      // Straight to the printer with the run that was just created: twenty new records want twenty stickers,
      // and finding them again in the picker is the boring half of that job.
      setPrinter({ initialAssetIds: results.map((r) => idOf(r.path)) });
      return;
    }
    const body = {
      // The tag is the server's to allocate, and it cannot be cleared - so an untouched (or emptied) field
      // is simply not sent, and only a typed override travels.
      ...(form.asset_tag.trim() ? { asset_tag: form.asset_tag.trim() } : {}),
      name: form.name.trim(),
      category: form.category,
      serial_number: form.serial_number.trim(),
      assigned_to: form.assigned_to,
      // Date fields are `format: date`, and "" is not a date - an empty one is left out.
      ...(form.assigned_to && form.assigned_on ? { assigned_on: form.assigned_on } : {}),
      ...(form.purchase_date ? { purchase_date: form.purchase_date } : {}),
      notes: form.notes.trim(),
      // A new asset has no status to send: it lands awaiting a check-in scan, or - if it is being handed
      // straight to somebody - awaiting that person's. Only an existing row can be moved to repair/retired.
      ...(editing ? { status: form.status } : {}),
    };
    if (editing) await patch(editing.path, body, editing.etag);
    else await create("assets", body);
    toast({
      title: editing ? "Asset updated" : form.assigned_to ? "Added - they now scan its tag to confirm" : "Added - scan its tag to check it into stock",
      variant: "success",
    });
    await reload();
  }

  const [returning, setReturning] = useState<string | null>(null);
  // Taking an asset off somebody is a custody change with consequences on both sides: their acknowledgement
  // is voided, and the row cannot count as stock again until a human scans it back in. Not a click to make by
  // accident on the wrong row.
  async function returnToStock(a: Asset) {
    const ok = await confirm({
      title: "Return this asset to the company?",
      description: `"${a.name}" stops being ${empName(a.assigned_to)}'s, and waits as “Awaiting check-in” until someone scans its tag back into stock.`,
      confirmLabel: "Return",
    });
    if (!ok) return;
    setReturning(a.path);
    try {
      await patch(a.path, { assigned_to: null, status: "in_stock" }, a.etag);
      // A return is a claim like any other: the row waits in "awaiting check-in" until someone scans the
      // thing back in, which is what stops assets from being returned only on paper.
      toast({ title: "Returned - scan it to check it into stock", variant: "success" });
      await reload();
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't return asset", description: (e as Error).message });
    } finally {
      setReturning(null);
    }
  }

  // A lost or defaced sticker is a live credential until it is rotated: whoever holds the old label could
  // still confirm custody with it. Reissuing mints a new secret and queues the asset for reprinting.
  async function reissue(a: Asset) {
    const ok = await confirm({
      title: "Reissue this asset's tag?",
      description: `The sticker currently on "${a.name}" stops working, and the asset goes back into the print queue.`,
      confirmLabel: "Reissue",
    });
    if (!ok) return;
    try {
      await invoke(a.path, "reissueTag");
      toast({ title: "Tag reissued - print a new sticker", variant: "success" });
      await reload();
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't reissue the tag", description: (e as Error).message });
    }
  }

  // Assets hard-delete (no soft-delete/restore on this collection), so always confirm.
  async function del(a: Asset) {
    const ok = await confirm({
      title: "Remove this asset?",
      description: `"${a.name}" is permanently deleted - there is no undo.${a.assigned_to ? ` It is currently assigned to ${empName(a.assigned_to)}.` : ""}`,
      destructive: true,
      confirmLabel: "Remove",
    });
    if (!ok) return;
    try {
      await remove(a.path, a.etag);
      toast({ title: "Asset removed", variant: "success" });
      await reload();
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't remove asset", description: (e as Error).message });
    }
  }

  const columns: Column<Asset>[] = [
    { id: "asset_tag", header: "Tag", accessor: (r) => r.asset_tag ?? "", cell: (r) => <span className="font-mono text-xs">{r.asset_tag || "-"}</span> },
    { id: "name", header: "Name", accessor: (r) => r.name, cell: (r) => <span className="font-medium">{r.name}</span> },
    { id: "category", header: "Category", filter: "select", accessor: (r) => (r.category ? catName(r.category) : "-") },
    { id: "serial", header: "Serial", defaultHidden: true, accessor: (r) => r.serial_number ?? "", cell: (r) => r.serial_number || "-" },
    { id: "status", header: "Status", filter: "select", accessor: (r) => ASSET_STATUS_LABEL[r.status] ?? r.status, cell: (r) => (
      <span className="flex items-center gap-1.5">
        <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", ASSET_STATUS_TONE[r.status])}>{ASSET_STATUS_LABEL[r.status] ?? r.status}</span>
        {r.condition && r.condition !== "good" && <span className="text-xs text-amber-600 dark:text-amber-400">{ASSET_CONDITION_LABEL[r.condition] ?? r.condition}</span>}
      </span>
    ) },
    { id: "assigned_to", header: "Assigned to", filter: "select", accessor: (r) => (r.assigned_to ? empName(r.assigned_to) : ""), cell: (r) => (r.assigned_to ? empName(r.assigned_to) : <span className="text-muted-foreground">-</span>) },
    { id: "assigned_on", header: "Assigned", defaultHidden: true, accessor: (r) => r.assigned_on ?? "", cell: (r) => (r.assigned_on ? formatDate(r.assigned_on) : "-") },
    { id: "purchase_date", header: "Purchased", defaultHidden: true, accessor: (r) => r.purchase_date ?? "", cell: (r) => (r.purchase_date ? formatDate(r.purchase_date) : "-") },
    { id: "tag_printed", header: "Tag printed", defaultHidden: true, accessor: (r) => r.tag_printed_time ?? "", cell: (r) => (r.tag_printed_time ? formatDate(r.tag_printed_time.slice(0, 10)) : "-") },
    // A sighting is worth only as much as its evidence, so the date says whether a scan proved it.
    { id: "last_verified", header: "Last verified", defaultHidden: true, accessor: (r) => r.last_verified_time ?? "", cell: (r) => (
      r.last_verified_time ? (
        <span className="flex items-center gap-1.5">
          {formatDate(r.last_verified_time.slice(0, 10))}
          {r.last_verified_scanned === false && <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">no scan</span>}
        </span>
      ) : "-"
    ) },
    { id: "last_verified_by", header: "Sighted by", defaultHidden: true, accessor: (r) => (r.last_verified_by ? empName(r.last_verified_by) : ""), cell: (r) => (r.last_verified_by ? empName(r.last_verified_by) : "-") },
    ...metaColumns<Asset>(),
    {
      id: "actions", header: "", sortable: false, filter: "none", align: "right",
      cell: (r) => (
        // Wraps: on a phone this column is the card's action cluster, and "Confirm receipt" + "Check in" +
        // "Return" together are wider than the screen.
        <div className="flex flex-wrap justify-end gap-1">
          {/* The scan that the row is waiting for, offered on the row itself. Confirming receipt is the
              holder's alone; checking one into stock is anybody's who may verify. */}
          {r.status === "pending_ack" && r.assigned_to && idOf(r.assigned_to) === myId && (
            <AccessAction collection="assets" objectPath={r.path} can={r.access?.can} verb="acknowledge" label="Confirm receipt">
              <Button size="sm" variant="outline" onClick={() => setCustody({ asset: r, mode: "acknowledge" })}><HandHeart className="h-4 w-4" /> Confirm receipt</Button>
            </AccessAction>
          )}
          {r.status === "pending_verification" && (
            <AccessAction collection="assets" objectPath={r.path} can={r.access?.can} verb="verify" label="Check into stock">
              <Button size="sm" variant="outline" onClick={() => setCustody({ asset: r, mode: "verify" })}><BadgeCheck className="h-4 w-4" /> Check in</Button>
            </AccessAction>
          )}
          <AccessAction collection="assets" objectPath={r.path} can={r.access?.can} verb="printTag" label="Print sticker tag">
            <Button size="sm" variant="ghost" title="Print sticker tag" onClick={() => setPrinter({ initialAssetIds: [idOf(r.path)] })}><Printer className="h-4 w-4" /></Button>
          </AccessAction>
          <AccessAction collection="assets" objectPath={r.path} can={r.access?.can} verb="reissueTag" label="Reissue tag">
            <Button size="sm" variant="ghost" title="Reissue tag - the sticker out there stops working" onClick={() => reissue(r)}><RefreshCw className="h-4 w-4" /></Button>
          </AccessAction>
          {r.assigned_to && (
            <AccessAction collection="assets" objectPath={r.path} can={r.access?.can} verb="update" label="Return to stock">
              <Button size="sm" variant="ghost" loading={returning === r.path} onClick={() => returnToStock(r)}><Undo2 className="h-4 w-4" /> Return</Button>
            </AccessAction>
          )}
          <AccessAction collection="assets" objectPath={r.path} can={r.access?.can} verb="update" label="Edit asset">
            <Button size="sm" variant="ghost" onClick={() => openEdit(r)}><Pencil className="h-4 w-4" /></Button>
          </AccessAction>
          <AccessAction collection="assets" objectPath={r.path} can={r.access?.can} verb="delete" label="Remove asset">
            <Button size="sm" variant="ghost" onClick={() => del(r)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
          </AccessAction>
        </div>
      ),
    },
  ];

  const addBtn = (
    <div className="flex flex-wrap gap-2">
      {rows.length > 0 && (
        <>
          {/* A count is a `stocktakes` row, so the button is gated on being able to create one: without it
              the modal could scan but never open a walk to scan into. Access mode still shows the affordance
              so an admin can grant it from here. */}
          <AccessAction collection="stocktakes" create label="Stocktake">
            <Button variant="outline" onClick={() => setStocktake("new")}><ScanLine className="h-4 w-4" /> Stocktake</Button>
          </AccessAction>
          {/* Printing a sheet of stickers is the `printTag` verb, one collection-level press instead of a row's:
              gated on holding it, and still carrying its key icon in access mode so an admin can grant it here. */}
          <AccessAction collection="assets" verb="printTag" label="Print sticker tags">
            <Button variant="outline" onClick={() => setPrinter({})}><Printer className="h-4 w-4" /> Print tags</Button>
          </AccessAction>
        </>
      )}
      {/* A delivery is its own act, so it gets its own button rather than hiding inside the single form: the
          quantity field there covers "a box of the same thing", this covers a mixed van-load of serials.
          Gated on the verb the server checks - and still carrying its key icon in access mode when the caller
          does not hold it, so an admin can grant it from the page it belongs to. */}
      <AccessAction collection="assets" verb="batchCreate" label="Add many assets">
        <Button variant="outline" onClick={() => setBulk(true)}><Boxes className="h-4 w-4" /> Add many</Button>
      </AccessAction>
      <AccessAction collection="assets" create label="Add asset">
        <Button onClick={openCreate}><Plus className="h-4 w-4" /> Add asset</Button>
      </AccessAction>
      <PageSettings me={me} host="assets" />
    </div>
  );

  return (
    <div className="space-y-4">
      <PageHeader title="Assets" description="Company asset inventory. Assign items to employees." accessCollection="assets" actions={addBtn} />
      {/* An inventory is two questions: what state is the kit in, and what IS the kit. The strip answers the
          first as counts; these answer both as proportions, which is what tells you whether "12 in repair"
          is a crisis or a rounding error. */}
      {rows.length > 2 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartCard title="Inventory by state" description="Where every asset on file currently sits.">
            <Chart
              type="donut"
              height={200}
              labels={assetCharts.states.labels}
              datasets={[{ name: "Assets", values: assetCharts.states.values }]}
              ariaLabel="Assets by state"
            />
          </ChartCard>
          <ChartCard title="What the fleet is made of" description="Assets by category, biggest first.">
            <Chart
              type="bar"
              height={200}
              labels={assetCharts.categories.labels}
              datasets={[{ name: "Assets", values: assetCharts.categories.values }]}
              ariaLabel="Assets by category"
            />
          </ChartCard>
        </div>
      )}
      {/* Clicking a number narrows the table to it; "Total" is how you come back. Pressing the tile that is
          already showing also clears, so the strip is a toggle rather than a trap. It rides under the charts
          and against the table, because it is the table's filter surface. */}
      {rows.length > 0 && (
        <SummaryStrip
          items={[
            { label: "Total", value: summary.total, tone: "muted", hint: "everything on file", onClick: () => setBand(null), active: band === null },
            // The one thing on this page only the reader can clear, so it leads them to the scan prompt below.
            ...(mineToConfirm.length
              ? [{
                  label: "Yours to confirm", value: mineToConfirm.length, tone: "warning" as const, hint: "scan to accept",
                  onClick: () => setCustody({ asset: mineToConfirm[0]!, mode: "acknowledge" as const }),
                }]
              : []),
            ...BANDS.map((b) => ({
              label: b.label,
              value: summary[b.id],
              hint: b.hint,
              tone: TILE_TONE[b.id](summary[b.id]),
              onClick: () => setBand(band === b.id ? null : b.id),
              active: band === b.id,
            })),
          ]}
        />
      )}
      {/* Nobody else can clear this for you, so it sits above the table rather than inside it. */}
      {mineToConfirm.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm">
          <HandHeart className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          <span className="min-w-0 flex-1">
            {mineToConfirm.length === 1 ? <><span className="font-medium">{mineToConfirm[0]!.name}</span> is waiting for you to confirm you have it.</> : <>{mineToConfirm.length} assets are waiting for you to confirm you have them.</>}
          </span>
          <Button size="sm" onClick={() => setCustody({ asset: mineToConfirm[0]!, mode: "acknowledge" })}><ScanLine className="h-4 w-4" /> Scan to confirm</Button>
        </div>
      )}
      <DataState state={state} error={error} onRetry={reload}>
        <DataTable
          tableId="assets"
          // The heading says which band is showing and how to leave it - a table quietly holding a subset is
          // how somebody concludes their assets have vanished.
          title={
            band ? (
              <span className="flex items-center gap-2 text-sm">
                <span className="font-medium">{BANDS.find((b) => b.id === band)!.label}</span>
                <span className="text-muted-foreground">{shown.length} of {rows.length}</span>
                <button type="button" className="font-medium text-primary hover:underline" onClick={() => setBand(null)}>Show all</button>
              </span>
            ) : (
              <span className="flex items-center gap-2 text-sm text-muted-foreground"><UserCheck className="h-4 w-4" /> {rows.filter((r) => r.assigned_to).length} of {rows.length} assigned</span>
            )
          }
          columns={columns}
          rows={shown}
          getRowId={(r) => r.path}
          accessCollection="assets"
          accessTargetOf={(r) => ({ collection: "assets", objectPath: r.path, label: r.name, can: r.access?.can })}
          emptyTitle={band ? `Nothing ${BANDS.find((b) => b.id === band)!.label.toLowerCase()}` : "No assets yet"}
          emptyDescription={band ? "Pick another number above, or Show all." : "Add laptops, phones and other company assets to track who holds what."}
          emptyAction={band ? undefined : addBtn}
        />
      </DataState>

      <WriteDialog
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? "Edit asset" : many ? `Add ${form.quantity} assets` : "Add asset"}
        description={editing ? undefined : "One thing, or - with a quantity - a box of identical ones. Add a whole mixed delivery with “Add many”."}
        collection="assets"
        objectPath={editing?.path}
        guardLabel="asset"
        form={form}
        // Only a create gets a draft: on an edit a restored draft would silently overwrite what the record says.
        draftKey={editing ? undefined : "assets.new"}
        applyDraft={(d) => setForm({ ...EMPTY, ...d })}
        onStartOver={() => setForm(EMPTY)}
        submitLabel={editing ? "Save changes" : many ? `Add ${form.quantity}` : "Add asset"}
        canSubmit={!!form.name.trim()}
        whyNot="Give the asset a name."
        // Entering a run of distinct machines is a sitting - keep the category and purchase date, drop the rest.
        addAnother={editing ? undefined : () => setForm({ ...EMPTY, category: form.category, purchase_date: form.purchase_date })}
        addAnotherLabel="Add & another"
        onSubmit={save}
      >
        <FieldRow>
          <Field label="Asset tag" hint={editing ? "What the sticker on it says." : "Allocated for you from the category, e.g. MS-LAP-014. Type one only to override it."} field="asset_tag">
            <Input value={form.asset_tag} onChange={(e) => setForm({ ...form, asset_tag: e.target.value })} placeholder={many ? "Allocated as one run" : editing ? "" : "Allocated automatically"} disabled={many} />
          </Field>
          <Field label="Category" hint={selectedCategory?.requires_serial ? "A serial number is required for this kind." : undefined} field="category">
            <Select value={form.category || "none"} onValueChange={(v) => setForm({ ...form, category: v === "none" ? "" : v })}>
              <SelectTrigger><SelectValue placeholder="Uncategorised" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Uncategorised</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c.path} value={c.path}>{c.display_name}{c.tag_code ? ` (${c.tag_code})` : ""}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </FieldRow>
        <Field label="Name" field="name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder='e.g. MacBook Pro 14"' autoFocus /></Field>
        {/* Quantity is a create-only field, and only for things with nothing to tell them apart: a box of
            adapters or cables that arrived together. Each one still becomes its own record - see EMPTY above. */}
        {!editing && !selectedCategory?.requires_serial && (
          <Field
            label="Quantity"
            hint={many
              ? `${form.quantity} separate records, tagged as one run. Serial number and assignment step aside - a serial names one device, and handing things over is one scan each.`
              : "More than one when they arrived in a box and nothing tells them apart (adapters, cables, mice)."}
          >
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={100}
                value={form.quantity}
                onChange={(e) => setForm({ ...form, quantity: Math.max(1, Math.min(100, Math.round(Number(e.target.value) || 1))) })}
                className="w-24 text-center tabular-nums"
              />
              <div className="flex flex-wrap gap-1">
                {[1, 5, 10, 20].map((n) => (
                  <Button key={n} type="button" size="sm" variant={form.quantity === n ? "secondary" : "ghost"} className="h-7 px-2 text-xs tabular-nums" onClick={() => setForm({ ...form, quantity: n })}>{n}</Button>
                ))}
              </div>
            </div>
          </Field>
        )}
        {!many && (
          <FieldRow>
            {/* Most devices carry their serial as a barcode next to the printed one, and a hand-typed serial is
                where this record picks up its typos - so the field offers the camera instead. */}
            <Field
              label="Serial number"
              field="serial_number"
              action={
                <Button type="button" size="sm" variant="ghost" className="-my-1 h-6 gap-1 px-1.5 text-xs" onClick={() => setScanSerial((v) => !v)}>
                  <ScanLine className="h-3.5 w-3.5" /> {scanSerial ? "Close scanner" : "Scan"}
                </Button>
              }
            >
              <Input value={form.serial_number} onChange={(e) => setForm({ ...form, serial_number: e.target.value })} placeholder="Type it, or scan the label" />
            </Field>
            <Field label="Purchase date" field="purchase_date"><Input type="date" value={form.purchase_date} onChange={(e) => setForm({ ...form, purchase_date: e.target.value })} /></Field>
            {scanSerial && (
              <SerialScanPanel
                onFound={(serial) => setForm((f) => ({ ...f, serial_number: serial }))}
                onClose={() => setScanSerial(false)}
                duplicateOf={serialOwner}
              />
            )}
          </FieldRow>
        )}
        {many && <Field label="Purchase date" field="purchase_date"><Input type="date" value={form.purchase_date} onChange={(e) => setForm({ ...form, purchase_date: e.target.value })} /></Field>}
        {!many && (
          <FieldRow>
            <Field label="Assigned to" field="assigned_to">
              <Combobox
                value={form.assigned_to || "none"}
                onValueChange={(v) => setAssignee(v === "none" ? "" : v)}
                placeholder="Unassigned"
                searchPlaceholder="Search employees…"
                options={[{ value: "none", label: "Unassigned (stays in the store cupboard)" }, ...employees.map((e) => ({ value: `employees/${idOf(e.path)}`, label: `${e.first_name} ${e.last_name}` }))]}
              />
            </Field>
            {/* Status is not a field on a NEW asset: nobody has laid eyes on it through this app yet, so it
                lands in the pending state its assignment implies. On an existing row the picker offers the
                two states a human sets by hand, plus the two that re-open the check-in loop. */}
            {editing && (
              <Field label="Status" field="status">
                <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v as Asset["status"] })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{STATUSES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
            )}
          </FieldRow>
        )}
        {!editing && (
          <p className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <ScanLine className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            {many
              ? "All of them wait as “Awaiting check-in” until their tags are printed and scanned. The printer opens on the new run as soon as they are added."
              : form.assigned_to
                ? "It will wait as “Awaiting holder” until that person scans its tag - nobody can confirm receipt on their behalf."
                : "It will wait as “Awaiting check-in” until someone scans its tag. Print the sticker first; the scan is what puts it into stock."}
          </p>
        )}
        {form.assigned_to && !many && (
          <Field label="Assigned on" hint="Defaults to today." field="assigned_on"><Input type="date" value={form.assigned_on} onChange={(e) => setForm({ ...form, assigned_on: e.target.value })} /></Field>
        )}
        <Field label="Notes (optional)" field="notes"><Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        {/* Where this thing was last actually SEEN, and how well that is proved. The custody columns are
            otherwise buried in hidden table columns, and they are the answer to the only question an
            inventory record really has to settle. */}
        {editing && <LastSighted asset={editing} empName={empName} />}
        {editing && <ActivitySection resource={editing.path} className="border-t pt-3" />}
      </WriteDialog>

      {bulk && (
        <BulkAddAssets
          categories={categories}
          assets={rows}
          onCreated={async (created) => {
            bulkCreated.current.push(...created.map((r) => idOf(r.path)));
            await reload();
          }}
          // The stickers are the next step for a whole delivery, so closing hands that exact run to the
          // printer - including a run that only partly landed, since those assets are out there tagged.
          onClose={() => {
            setBulk(false);
            const ids = bulkCreated.current;
            bulkCreated.current = [];
            if (ids.length) setPrinter({ initialAssetIds: ids });
          }}
        />
      )}

      {printer && <AssetTagPrinter me={me} assets={rows} onClose={() => setPrinter(null)} onReload={reload} initialAssetIds={printer.initialAssetIds} />}
      {/* The stocktake modal reads the inventory and the counts through the shared store (so it reuses what
          this page already fetched) and folds each `:verify` response back into these same rows. */}
      {stocktake && (
        <Stocktake
          initialCountId={stocktake === "new" ? undefined : stocktake}
          onClose={() => {
            setStocktake(null);
            if (route.query.stocktake) setQueryParam("stocktake", null); // leave a clean, shareable URL behind
          }}
        />
      )}
      {custody && (
        <AssetCustodyDialog
          asset={custody.asset}
          mode={custody.mode}
          presetScan={custody.scan}
          onClose={() => setCustody(null)}
          onDone={reload}
        />
      )}
    </div>
  );
}

// The custody line for one asset: when it was last sighted, by whom, whether a scan proved it, and which count
// claimed the sighting. The count's NAME needs its row, so it is fetched only when this dialog opens (one read,
// never on the list) - and it links straight to that count's record.
function LastSighted({ asset, empName }: { asset: Asset; empName: (p?: string) => string }) {
  const [count, setCount] = useState<StocktakeRecord | null>(null);
  useEffect(() => {
    setCount(null);
    if (!asset.last_stocktake) return;
    let live = true;
    get<StocktakeRecord>(asset.last_stocktake)
      .then((c) => { if (live) setCount(c); })
      .catch(() => {/* no read access to counts, or it was purged: the sighting still stands on its own */});
    return () => { live = false; };
  }, [asset.last_stocktake]);

  const days = daysSince(asset.last_verified_time);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
      <ScanLine className="h-3.5 w-3.5" />
      {asset.last_verified_time ? (
        <>
          <span className="text-foreground">Last sighted {formatDate(asset.last_verified_time.slice(0, 10))}</span>
          <span>({days === 0 ? "today" : `${days}d ago`})</span>
          {asset.last_verified_by && <span>by {empName(asset.last_verified_by)}</span>}
          {asset.last_verified_scanned === false
            ? <span className="rounded-full bg-muted px-1.5 py-0.5">confirmed without a scan</span>
            : <span className="rounded-full bg-success/10 px-1.5 py-0.5 text-success">scan-proved</span>}
          {count && (
            <button className="underline decoration-dotted underline-offset-2 hover:text-foreground" onClick={() => navigate(`stocktakes/${idOf(count.path)}`)}>
              in {count.label}
            </button>
          )}
        </>
      ) : (
        <span>Never sighted. Nobody has scanned this tag, so its location is a claim rather than a record.</span>
      )}
    </div>
  );
}
