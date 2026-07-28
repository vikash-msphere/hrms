import { useCallback, useState } from "react";
import { Plus } from "lucide-react";
import { create, patch } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { useSoftDelete } from "@/hooks/useSoftDelete";
import { useLifecycle } from "@/hooks/useLifecycle";
import { useSplitStaleness } from "@/hooks/useSplitStaleness";
import { SplitStaleBanner } from "@/components/common/SplitStaleBanner";
import { usePermission } from "@/lib/perm";
import { idOf } from "@/lib/utils";
import type { Me, PayComponent } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { DataTable, type Column } from "@/components/common/DataTable";
import { stateColumn } from "@/components/common/stateColumn";
import { metaColumns } from "@/components/common/metaColumns";
import { SoftDeleteRowActions } from "@/components/common/SoftDeleteRowActions";
import { Field } from "@/components/common/Field";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

const METHOD_LABEL: Record<string, string> = {
  fixed: "Fixed amount",
  percent_base: "% of base",
  rate_qty: "Rate × quantity",
  income_tax: "Income tax (TDS)",
  epf: "EPF (Provident Fund)",
  esi: "ESI (state insurance)",
  pt: "Professional Tax",
};

const KIND_LABEL: Record<string, string> = {
  earning: "Earning",
  deduction: "Deduction",
  employer_contribution: "Employer contribution",
};

// Tax regimes available for an income-tax (TDS) component. Only the new regime is implemented today; an "old"
// regime can be added (config block + calc path) later without changing this list's shape.
const REGIMES: { value: string; label: string }[] = [{ value: "new", label: "New regime (AY 2026-27)" }];

type Form = { name: string; kind: string; method: string; rate: string; cap: string; regime: string; recurring: boolean };
const EMPTY: Form = { name: "", kind: "earning", method: "fixed", rate: "", cap: "", regime: "new", recurring: true };

export default function PayComponents({ embedded, openId }: { me?: Me; embedded?: boolean; openId?: string }) {
  const { rows, state, error, reload } = useCollection<PayComponent>("pay-components", { showDeleted: true });
  useDeepOpen(openId, rows, openEdit);
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const writable = usePermission("pay-components.write");
  const canPurge = usePermission("pay-components.admin");

  // Staleness of employee salary splits vs the live component catalog (shared hook - same banner/prompt on the
  // salary-structure and CTC panels). Changing an earning or employer contribution shifts the CTC build-up, so
  // every current employee's cached basic / Special-Allowance split (annual CTC held fixed) needs re-solving.
  const { canReapply, staleCount, skippedCount, reapplying, refresh: refreshSplitStatus, reapply: doReapply, promptReapply } = useSplitStaleness();

  // Delete / enable / disable / restore all funnel through here: reload the table AND recheck staleness so the
  // banner reflects the change immediately (these paths don't prompt - the banner is the signal).
  const afterMutation = useCallback(() => { reload(); refreshSplitStatus(); }, [reload, refreshSplitStatus]);
  const sd = useSoftDelete("pay-components", "pay component", afterMutation);
  const lc = useLifecycle("pay-components", "pay component", afterMutation);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PayComponent | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);

  function openCreate(kind: Form["kind"] = "earning") {
    setEditing(null);
    setForm({ ...EMPTY, kind });
    setOpen(true);
  }
  function openEdit(pc: PayComponent) {
    setEditing(pc);
    setForm({ name: pc.display_name, kind: pc.kind, method: pc.method, rate: String(pc.rate ?? ""), cap: String(pc.cap ?? ""), regime: pc.regime ?? "new", recurring: pc.recurring });
    setOpen(true);
  }

  async function submit() {
    setBusy(true);
    try {
      const isTax = form.method === "income_tax";
      const isEpf = form.method === "epf";
      const isEsi = form.method === "esi";
      const isPt = form.method === "pt";
      // TDS + PT are employee-only (forced deduction). EPF/ESI can be the employee share (deduction) OR the
      // employer share (employer_contribution) - the user picks, so the kind is honoured.
      const employeeOnly = isTax || isPt;
      const body = {
        display_name: form.name,
        kind: (employeeOnly ? "deduction" : form.kind) as "earning" | "deduction" | "employer_contribution",
        method: form.method as "fixed" | "percent_base" | "rate_qty" | "income_tax" | "epf" | "esi" | "pt",
        // TDS + PT are engine-computed (no rate); EPF defaults 12%, ESI defaults 0.75%.
        rate: isTax || isPt ? null : isEpf ? (form.rate ? Number(form.rate) : 12) : isEsi ? (form.rate ? Number(form.rate) : (form.kind === "employer_contribution" ? 3.25 : 0.75)) : form.rate ? Number(form.rate) : null,
        cap: isEpf ? (form.cap ? Number(form.cap) : null) : isEsi ? (form.cap ? Number(form.cap) : 21000) : null,
        regime: isTax ? form.regime : null,
        recurring: form.recurring,
      };
      if (editing) {
        await patch("pay-components/" + idOf(editing.path), body, editing.etag);
        toast({ title: "Pay component updated", variant: "success" });
      } else {
        await create("pay-components", body);
        toast({ title: "Pay component created", variant: "success" });
      }
      setOpen(false);
      reload();
      // Earning / employer-contribution changes shift the CTC split; offer to propagate. Deductions don't.
      if (body.kind === "earning" || body.kind === "employer_contribution") await promptReapply();
      else refreshSplitStatus();
    } catch (e) {
      toast({ title: "Couldn't save component", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<PayComponent>[] = [
    { id: "name", header: "Name", accessor: (pc) => pc.display_name, cell: (pc) => <span className="font-medium">{pc.display_name}</span> },
    { id: "kind", header: "Kind", filter: "select", accessor: (pc) => KIND_LABEL[pc.kind] ?? "Earning", cell: (pc) => <Badge variant={pc.kind === "deduction" ? "warning" : pc.kind === "employer_contribution" ? "info" : "success"}>{KIND_LABEL[pc.kind] ?? "Earning"}</Badge> },
    { id: "method", header: "Method", filter: "select", accessor: (pc) => METHOD_LABEL[pc.method] ?? pc.method },
    {
      id: "amount",
      header: "Amount",
      align: "right",
      // Signed + coloured: earnings (+, green), deductions (−, red), employer contributions (+, blue - a company
      // cost, not paid to the employee). income_tax has no fixed rate (computed per employee); show "computed".
      accessor: (pc) => (pc.method === "income_tax" ? null : pc.rate ?? null),
      cell: (pc) => {
        if (pc.method === "income_tax") return <span className="text-muted-foreground">computed</span>;
        const isDeduction = pc.kind === "deduction";
        const cls = isDeduction ? "text-destructive" : pc.kind === "employer_contribution" ? "text-blue-600 dark:text-blue-400" : "text-emerald-600 dark:text-emerald-400";
        if (pc.method === "epf") return <span className={cls}>{isDeduction ? "−" : "+"}{pc.rate ?? 12}%{pc.cap ? ` (cap ${pc.cap})` : ""}</span>;
        if (pc.rate == null) return "-";
        const unit = pc.method === "percent_base" ? "%" : "";
        return <span className={cls}>{isDeduction ? "−" : "+"}{pc.rate}{unit}</span>;
      },
    },
    { id: "recurring", header: "Recurring", defaultHidden: true, filter: "select", accessor: (pc) => (pc.recurring ? "Yes" : "No"), cell: (pc) => <Badge variant={pc.recurring ? "secondary" : "muted"}>{pc.recurring ? "Yes" : "No"}</Badge> },
    stateColumn<PayComponent>(),
    ...metaColumns<PayComponent>(),
    {
      id: "actions",
      header: "",
      sortable: false,
      filter: "none",
      align: "right",
      cell: (pc) => <SoftDeleteRowActions row={pc} writable={writable} canPurge={canPurge} actions={sd} onEdit={openEdit} lifecycle={lc} />,
    },
  ];

  const createBtn = writable ? (
    <AccessAction collection="pay-components" create>
      <Button size="sm" variant="outline" onClick={() => openCreate()}><Plus className="h-4 w-4" /> New component</Button>
    </AccessAction>
  ) : undefined;

  return (
    <div className="space-y-6">
      {!embedded && <PageHeader accessCollection="pay-components" title="Pay Components" description="Reusable earning and deduction lines used to build payroll." />}

      <SplitStaleBanner staleCount={staleCount} skippedCount={skippedCount} reapplying={reapplying} canReapply={canReapply} onReapply={doReapply} />

      <DataState state={state} error={error} onRetry={reload}>
        <DataTable
          columns={columns}
          tableId="pay-components"
          rows={rows}
          getRowId={(pc) => pc.path}
          rowClassName={(pc) => (pc.delete_time ? "opacity-60" : undefined)}
          emptyTitle="No pay components"
          emptyDescription="Create earnings (salary, bonus) and deductions (PF, TDS)."
          toolbar={createBtn}
          accessCollection="pay-components"
          accessTargetOf={(pc) => ({ objectPath: pc.path, label: pc.display_name, can: pc.access?.can })}
        />
      </DataState>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onEnterSubmit={() => { if (!busy && form.name.trim()) submit(); }}>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit pay component" : "New pay component"}</DialogTitle>
          </DialogHeader>
          <Field label="Name">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Base Salary" autoFocus />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Kind">
              <Select value={form.kind} onValueChange={(v) => setForm({ ...form, kind: v })} disabled={["income_tax", "pt"].includes(form.method)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {/* EPF/ESI can be the employee share (deduction) or the employer share (employer_contribution),
                      never an earning; fixed/percent_base can be any kind (gratuity = percent_base employer). */}
                  {!["epf", "esi"].includes(form.method) && <SelectItem value="earning">Earning</SelectItem>}
                  <SelectItem value="deduction">Deduction</SelectItem>
                  <SelectItem value="employer_contribution">Employer contribution</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Method">
              <Select value={form.method} onValueChange={(v) => setForm({ ...form, method: v, kind: ["income_tax", "pt"].includes(v) ? "deduction" : (["epf", "esi"].includes(v) && form.kind === "earning") ? "deduction" : form.kind })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="fixed">Fixed amount</SelectItem>
                  <SelectItem value="percent_base">% of base</SelectItem>
                  <SelectItem value="rate_qty">Rate × quantity</SelectItem>
                  <SelectItem value="income_tax">Income tax (TDS)</SelectItem>
                  <SelectItem value="epf">EPF (Provident Fund)</SelectItem>
                  <SelectItem value="esi">ESI (state insurance)</SelectItem>
                  <SelectItem value="pt">Professional Tax</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          {form.method === "income_tax" ? (
            <Field label="Tax regime" hint="The amount is computed each payroll run from the employee's projected annual income.">
              <Select value={form.regime} onValueChange={(v) => setForm({ ...form, regime: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {REGIMES.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          ) : form.method === "epf" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Employee rate %" hint="Statutory employee contribution is 12%.">
                <Input type="number" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} placeholder="12" />
              </Field>
              <Field label="Wage ceiling" hint="Cap on the base, e.g. 15000. Leave blank to apply to the full base.">
                <Input type="number" value={form.cap} onChange={(e) => setForm({ ...form, cap: e.target.value })} placeholder="15000" />
              </Field>
            </div>
          ) : form.method === "esi" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Employee rate %" hint="Statutory employee contribution is 0.75% of gross.">
                <Input type="number" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} placeholder="0.75" />
              </Field>
              <Field label="Eligibility ceiling" hint="No ESI when monthly gross exceeds this (default 21000).">
                <Input type="number" value={form.cap} onChange={(e) => setForm({ ...form, cap: e.target.value })} placeholder="21000" />
              </Field>
            </div>
          ) : form.method === "pt" ? (
            <p className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">Professional Tax is computed each run from the configured state slabs (default: nil up to ₹25,000/month, ₹200 above); this component just enables the deduction.</p>
          ) : (
            <Field label="Rate" hint="Amount, percentage, or per-unit rate depending on the method.">
              <Input type="number" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} />
            </Field>
          )}
          <div className="flex items-center gap-2">
            <Checkbox id="recurring" checked={form.recurring} onCheckedChange={(v) => setForm({ ...form, recurring: v === true })} />
            <Label htmlFor="recurring">Recurring</Label>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">Use the Disable action to stop a component from being applied in payroll.</p>
          {editing && <ActivitySection resource={editing.path} className="border-t pt-3" />}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} loading={busy} disabled={!form.name.trim()}>{editing ? "Save changes" : "Create"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
