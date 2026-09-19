import { useRef, useState } from "react";
import { Plus } from "lucide-react";
import { create, patch } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { useSoftDelete } from "@/hooks/useSoftDelete";
import { usePermission } from "@/lib/perm";
import { idOf, formatMoney } from "@/lib/utils";
import { useOrg, currencyDecimals } from "@/lib/org";
import type { Me, PayGrade } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { DataTable, type Column } from "@/components/common/DataTable";
import type { TableInsight } from "@/components/common/TableInsights";
import { metaColumns } from "@/components/common/metaColumns";
import { SoftDeleteRowActions } from "@/components/common/SoftDeleteRowActions";
import { Field } from "@/components/common/Field";
import { FormError } from "@/components/common/FormError";
import { MoneyInput } from "@/components/common/MoneyInput";
import { useDialogGuard } from "@/components/common/dialogGuard";
import { AccessScope } from "@/components/access/AccessScope";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

type Form = { name: string; level: string; band_min: string; band_mid: string; band_max: string; currency_code: string; description: string };
const EMPTY: Form = { name: "", level: "0", band_min: "", band_mid: "", band_max: "", currency_code: "", description: "" };
const num = (s: string) => (s.trim() === "" ? null : Number(s));

export default function PayGradesAdmin({ embedded, openId }: { me?: Me; embedded?: boolean; openId?: string }) {
  const { rows, state, error, reload } = useCollection<PayGrade>("pay-grades", { showDeleted: true });
  useDeepOpen(openId, rows, openEdit);
  const { org } = useOrg();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const sd = useSoftDelete("pay-grades", "pay grade", reload);
  const writable = usePermission("pay-grades.write");
  const canPurge = usePermission("pay-grades.admin");

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PayGrade | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [err, setErr] = useState<string | null>(null);
  // A ladder is entered as a ladder - L1 through L5 in one sitting - so the level auto-advances on each save.
  const [again, setAgain] = useState(false);
  const guard = useDialogGuard(open, form, () => setOpen(false), { label: "pay grade" });
  const nameRef = useRef<HTMLInputElement>(null);

  const money = (n: number, cc?: string) => formatMoney(n, cc || org.default_currency, currencyDecimals(cc, org));

  // Band bounds must be ordered min ≤ mid ≤ max; any can be left blank for an open end.
  const bMin = num(form.band_min), bMid = num(form.band_mid), bMax = num(form.band_max);
  const bandError =
    bMin != null && bMax != null && bMin > bMax ? "Min is above max."
      : bMin != null && bMid != null && bMin > bMid ? "Min is above the midpoint."
        : bMid != null && bMax != null && bMid > bMax ? "Midpoint is above max."
          : undefined;

  // Band width and where the midpoint sits in it - the two things a reader checks after typing three numbers.
  // A midpoint pushed off-centre is a real design choice (a wide band skewed low), so it is reported, not fixed.
  const bandSpan = bMin != null && bMax != null && bMax > bMin ? bMax - bMin : null;
  const midPct = bandSpan && bMid != null ? Math.round(((bMid - bMin!) / bandSpan) * 100) : null;

  function openCreate() {
    setEditing(null);
    setForm(EMPTY);
    setErr(null);
    setOpen(true);
  }
  function openEdit(g: PayGrade) {
    setEditing(g);
    setErr(null);
    setForm({
      name: g.display_name,
      level: String(g.level ?? 0),
      band_min: String(g.band_min ?? ""),
      band_mid: String(g.band_mid ?? ""),
      band_max: String(g.band_max ?? ""),
      currency_code: g.currency_code ?? "",
      description: g.description ?? "",
    });
    setOpen(true);
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const body = {
        display_name: form.name.trim(),
        level: Number(form.level) || 0,
        band_min: num(form.band_min),
        band_mid: num(form.band_mid),
        band_max: num(form.band_max),
        currency_code: form.currency_code.trim() || undefined,
        description: form.description.trim(),
      };
      if (editing) {
        await patch("pay-grades/" + idOf(editing.path), body, editing.etag);
        toast({ title: "Pay grade updated", variant: "success" });
      } else {
        await create("pay-grades", body);
        toast({ title: "Pay grade created", variant: "success" });
      }
      // Next rung up, blank band: the level is the one field whose next value is knowable.
      if (again && !editing) {
        const next = { ...EMPTY, level: String((Number(form.level) || 0) + 1), currency_code: form.currency_code };
        setForm(next);
        guard.markSaved(next);
        // The just-cleared Name loses focus the instant its own Create button disables with it - see
        // ReimbursementCategories' identical fix.
        nameRef.current?.focus();
      } else {
        guard.markSaved();
        setOpen(false);
      }
      reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // The two things a grade ladder is reviewed for, neither of which any single row shows: bands that were
  // never finished, and bands that overlap the grade above so far that the two are not really distinct.
  const gradeInsights = (gs: PayGrade[]): TableInsight[] => {
    const live = gs.filter((g) => !g.delete_time);
    const out: TableInsight[] = [];
    const incomplete = live.filter((g) => g.band_min == null || g.band_mid == null || g.band_max == null);
    if (incomplete.length > 0) {
      out.push({
        id: "no-band",
        label: `${incomplete.length} with an unfinished band`,
        tone: "warning",
        hint: "Nothing to anchor a compa-ratio or price an offer against.",
        filters: { band_set: "Incomplete" },
      });
    }
    // Ordered by level, then each band compared with the next one up: an overlap of more than half the lower
    // band's width means the two grades pay much the same money.
    const ladder = live
      .filter((g) => g.band_min != null && g.band_max != null)
      .sort((a, b) => (a.level ?? 0) - (b.level ?? 0));
    let overlaps = 0;
    for (let i = 0; i < ladder.length - 1; i++) {
      const lower = ladder[i]!;
      const upper = ladder[i + 1]!;
      const width = (lower.band_max ?? 0) - (lower.band_min ?? 0);
      if (width > 0 && (lower.band_max ?? 0) - (upper.band_min ?? 0) > width / 2) overlaps++;
    }
    if (overlaps > 0) {
      out.push({
        id: "overlap",
        label: `${overlaps} band${overlaps === 1 ? "" : "s"} overlap the next grade`,
        hint: "More than half of the lower band sits inside the one above it, so a promotion between them is worth little.",
        sort: "level.asc",
      });
    }
    return out;
  };

  const columns: Column<PayGrade>[] = [
    { id: "level", header: "Level", align: "right", filter: "number", accessor: (g) => g.level ?? 0 },
    { id: "name", header: "Grade", accessor: (g) => g.display_name, cell: (g) => <span className="font-medium">{g.display_name}</span> },
    {
      id: "band",
      header: "Salary band",
      sortable: false,
      filter: "none",
      // min – mid – max; the midpoint is emphasised (it's the compa-ratio anchor). A dash where unset.
      cell: (g) =>
        g.band_min == null && g.band_mid == null && g.band_max == null ? (
          <span className="text-muted-foreground">-</span>
        ) : (
          <span className="tabular-nums">
            {g.band_min != null ? money(g.band_min, g.currency_code) : "-"}
            {" – "}
            <span className="font-medium">{g.band_mid != null ? money(g.band_mid, g.currency_code) : "-"}</span>
            {" – "}
            {g.band_max != null ? money(g.band_max, g.currency_code) : "-"}
          </span>
        ),
    },
    {
      // The width of the band as a share of its own midpoint. A grade ladder is judged on whether the bands
      // are consistent, and comparing three money figures per row by eye is how an inconsistent one survives
      // for years. Blank where the band is not fully set, which is what the chip below counts separately.
      id: "spread", header: "Band width", align: "right", defaultHidden: true, filter: "number",
      formatTotal: (n) => `${Math.round(n)}%`,
      accessor: (g) => (g.band_min != null && g.band_max != null && g.band_mid ? Math.round(((g.band_max - g.band_min) / g.band_mid) * 100) : null),
      cell: (g) => {
        const pct = g.band_min != null && g.band_max != null && g.band_mid ? Math.round(((g.band_max - g.band_min) / g.band_mid) * 100) : null;
        return pct == null ? <span className="text-muted-foreground">-</span> : <span className="tabular-nums">{pct}%</span>;
      },
    },
    {
      // Whether the band is usable at all. A grade with no numbers on it cannot anchor a compa-ratio, price
      // an offer or answer a pay review, and it looks exactly like a finished one in a list of names.
      id: "band_set", header: "Band", filter: "select", groupBy: true, defaultHidden: true,
      accessor: (g) => (g.band_min != null && g.band_mid != null && g.band_max != null ? "Complete" : "Incomplete"),
    },
    { id: "description", header: "Description", defaultHidden: true, accessor: (g) => g.description ?? "" },
    ...metaColumns<PayGrade>(),
    {
      id: "actions",
      header: "",
      sortable: false,
      filter: "none",
      align: "right",
      cell: (g) => <SoftDeleteRowActions row={g} writable={writable} canPurge={canPurge} actions={sd} onEdit={openEdit} />,
    },
  ];

  const createBtn = writable ? (
    <AccessAction collection="pay-grades" create>
      <Button size="sm" variant="outline" onClick={openCreate}><Plus className="h-4 w-4" /> New grade</Button>
    </AccessAction>
  ) : undefined;

  return (
    <div className="space-y-6">
      {!embedded && <PageHeader accessCollection="pay-grades" title="Pay Grades" description="The salary-grade ladder and its bands." />}

      <DataState state={state} error={error} onRetry={reload}>
        <DataTable
          columns={columns}
          tableId="pay-grades"
          rows={rows}
          insights={gradeInsights}
          getRowId={(g) => g.path}
          rowClassName={(g) => (g.delete_time ? "opacity-60" : undefined)}
          emptyTitle="No pay grades"
          emptyDescription="Define grades (e.g. L1–L5) with a salary band (min / mid / max)."
          emptyAction={createBtn}
          toolbar={createBtn}
          accessCollection="pay-grades"
          accessTargetOf={(g) => ({ objectPath: g.path, label: g.display_name, can: g.access?.can })}
        />
      </DataState>

      <Dialog open={open} onOpenChange={guard.onOpenChange}>
        <DialogContent scrollBody onEnterSubmit={() => { if (!busy && form.name.trim() && !bandError) void submit(); }}>
          <AccessScope collection="pay-grades" objectPath={editing?.path}>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit pay grade" : "New pay grade"}</DialogTitle>
            <DialogDescription>One rung of the ladder. Its midpoint is what every employee's compa-ratio is measured against.</DialogDescription>
          </DialogHeader>
          <DialogBody>
          <FormError error={err} />
          <div className="grid grid-cols-[1fr_auto] gap-4">
            <Field label="Grade name"><Input ref={nameRef} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. L3 or Senior Engineer" autoFocus /></Field>
            <Field label="Level" hint="Orders the ladder (lower = junior)."><Input type="number" className="w-24" value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })} /></Field>
          </div>
          <Field label="Salary band" hint="Annual CTC range. Leave any blank for an open end." error={bandError}>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Minimum</span>
                <MoneyInput value={form.band_min} onChange={(v) => setForm({ ...form, band_min: v })} currency={form.currency_code || undefined} min={0} placeholder="Min" />
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Midpoint</span>
                <MoneyInput value={form.band_mid} onChange={(v) => setForm({ ...form, band_mid: v })} currency={form.currency_code || undefined} min={0} placeholder="Mid" />
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Maximum</span>
                <MoneyInput value={form.band_max} onChange={(v) => setForm({ ...form, band_max: v })} currency={form.currency_code || undefined} min={0} placeholder="Max" />
              </div>
            </div>
          </Field>
          {/* Only a bounded band can be drawn. The bar makes a lopsided midpoint - the thing that quietly skews
              every compa-ratio in the grade - visible at a glance instead of implied by three numbers. */}
          {!bandError && bandSpan && midPct != null && (
            <div className="space-y-1.5 rounded-md border bg-muted/40 px-3 py-2">
              <div className="relative h-2 rounded-full bg-primary/20">
                <div className="absolute top-1/2 h-3.5 w-0.5 -translate-y-1/2 rounded bg-primary" style={{ left: `${Math.min(100, Math.max(0, midPct))}%` }} />
              </div>
              <div className="flex justify-between text-xs tabular-nums text-muted-foreground">
                <span>{money(bMin!, form.currency_code)}</span>
                <span>Midpoint {midPct}% through the band{midPct < 40 || midPct > 60 ? " (off-centre)" : ""}</span>
                <span>{money(bMax!, form.currency_code)}</span>
              </div>
            </div>
          )}
          {bMin != null && bMax != null && bMid == null && (
            <p className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              No midpoint, so no compa-ratio for anyone on this grade.
              <button type="button" className="font-medium text-primary hover:underline" onClick={() => setForm({ ...form, band_mid: String(Math.round((bMin! + bMax!) / 2)) })}>
                Use the centre ({money((bMin + bMax) / 2, form.currency_code)})
              </button>
            </p>
          )}
          <Field label="Currency" hint="ISO code; defaults to the org currency."><Input className="w-32" value={form.currency_code} onChange={(e) => setForm({ ...form, currency_code: e.target.value.toUpperCase() })} placeholder={org.default_currency} /></Field>
          <Field label="Description (optional)"><Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          {editing && <ActivitySection resource={editing.path} className="border-t pt-3" />}
          {!editing && (
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <Checkbox checked={again} onCheckedChange={(v) => setAgain(v === true)} />
              Keep this open to add another
            </label>
          )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => guard.onOpenChange(false)}>Cancel</Button>
            <Button onClick={submit} loading={busy} disabled={!form.name.trim() || !!bandError}>{editing ? "Save changes" : again ? "Create & add another" : "Create"}</Button>
          </DialogFooter>
          </AccessScope>
        </DialogContent>
      </Dialog>
    </div>
  );
}
