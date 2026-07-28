import { useState } from "react";
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
import { metaColumns } from "@/components/common/metaColumns";
import { SoftDeleteRowActions } from "@/components/common/SoftDeleteRowActions";
import { Field } from "@/components/common/Field";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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

  const money = (n: number, cc?: string) => formatMoney(n, cc || org.default_currency, currencyDecimals(cc, org));

  // Band bounds must be ordered min ≤ mid ≤ max; any can be left blank for an open end.
  const bMin = num(form.band_min), bMid = num(form.band_mid), bMax = num(form.band_max);
  const bandError =
    bMin != null && bMax != null && bMin > bMax ? "Min is above max."
      : bMin != null && bMid != null && bMin > bMid ? "Min is above the midpoint."
        : bMid != null && bMax != null && bMid > bMax ? "Midpoint is above max."
          : undefined;

  function openCreate() {
    setEditing(null);
    setForm(EMPTY);
    setOpen(true);
  }
  function openEdit(g: PayGrade) {
    setEditing(g);
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
    try {
      const body = {
        display_name: form.name.trim(),
        level: Number(form.level) || 0,
        band_min: num(form.band_min),
        band_mid: num(form.band_mid),
        band_max: num(form.band_max),
        currency_code: form.currency_code.trim() || undefined,
        description: form.description.trim() || null,
      };
      if (editing) {
        await patch("pay-grades/" + idOf(editing.path), body, editing.etag);
        toast({ title: "Pay grade updated", variant: "success" });
      } else {
        await create("pay-grades", body);
        toast({ title: "Pay grade created", variant: "success" });
      }
      setOpen(false);
      reload();
    } catch (e) {
      toast({ title: "Couldn't save pay grade", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<PayGrade>[] = [
    { id: "level", header: "Level", align: "right", accessor: (g) => g.level ?? 0 },
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
          getRowId={(g) => g.path}
          rowClassName={(g) => (g.delete_time ? "opacity-60" : undefined)}
          emptyTitle="No pay grades"
          emptyDescription="Define grades (e.g. L1–L5) with a salary band (min / mid / max)."
          toolbar={createBtn}
          accessCollection="pay-grades"
          accessTargetOf={(g) => ({ objectPath: g.path, label: g.display_name, can: g.access?.can })}
        />
      </DataState>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onEnterSubmit={() => { if (!busy && form.name.trim() && !bandError) submit(); }}>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit pay grade" : "New pay grade"}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-[1fr_auto] gap-4">
            <Field label="Grade name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. L3 or Senior Engineer" autoFocus /></Field>
            <Field label="Level" hint="Orders the ladder (lower = junior)."><Input type="number" className="w-24" value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })} /></Field>
          </div>
          <Field label="Salary band" hint="Annual CTC range. Leave blank for an open end. The midpoint anchors the compa-ratio." error={bandError}>
            <div className="grid grid-cols-3 gap-2">
              <Input type="number" value={form.band_min} onChange={(e) => setForm({ ...form, band_min: e.target.value })} placeholder="Min" />
              <Input type="number" value={form.band_mid} onChange={(e) => setForm({ ...form, band_mid: e.target.value })} placeholder="Mid" />
              <Input type="number" value={form.band_max} onChange={(e) => setForm({ ...form, band_max: e.target.value })} placeholder="Max" />
            </div>
          </Field>
          <Field label="Currency" hint="ISO code; defaults to the org currency."><Input className="w-32" value={form.currency_code} onChange={(e) => setForm({ ...form, currency_code: e.target.value })} placeholder={org.default_currency} /></Field>
          <Field label="Description (optional)"><Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          {editing && <ActivitySection resource={editing.path} className="border-t pt-3" />}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} loading={busy} disabled={!form.name.trim() || !!bandError}>{editing ? "Save changes" : "Create"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
