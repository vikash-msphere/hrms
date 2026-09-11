import { useCallback, useRef, useState } from "react";
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
import { Field, FieldRow } from "@/components/common/Field";
import { FormError } from "@/components/common/FormError";
import { MoneyInput } from "@/components/common/MoneyInput";
import { useDialogGuard } from "@/components/common/dialogGuard";
import { AccessScope } from "@/components/access/AccessScope";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

const METHOD_LABEL: Record<string, string> = {
  fixed: "Fixed amount",
  percent_base: "% of base",
  income_tax: "Income tax (TDS)",
  epf: "EPF (Provident Fund)",
  esi: "ESI (state insurance)",
  pt: "Professional Tax",
  edli: "EDLI charges (employer)",
  pf_admin: "PF admin charges (employer)",
};

// Methods priced on PF wages (the employer's EDLI + administration charges alongside EPF itself): employer-only
// for the two charges, and all three capped by the same wage ceiling.
const PF_CHARGE_METHODS = ["edli", "pf_admin"];

const KIND_LABEL: Record<string, string> = {
  earning: "Earning",
  deduction: "Deduction",
  employer_contribution: "Employer contribution",
};

// Tax regimes available for an income-tax (TDS) component. Only the new regime is implemented today; an "old"
// regime can be added (config block + calc path) later without changing this list's shape.
const REGIMES: { value: string; label: string }[] = [{ value: "new", label: "New regime (AY 2026-27)" }];

type Form = { name: string; kind: string; method: string; rate: string; cap: string; regime: string; recurring: boolean; in_ctc: boolean; pf_wages: boolean };
const EMPTY: Form = { name: "", kind: "earning", method: "fixed", rate: "", cap: "", regime: "new", recurring: true, in_ctc: true, pf_wages: false };

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
  const { canReapply, staleCount, skippedCount, reapplying, reapply: doReapply, promptReapply } = useSplitStaleness();

  // Delete / enable / disable / restore all funnel through here: reload the table AND recheck staleness so the
  // banner reflects the change immediately (these paths don't prompt - the banner is the signal).
  // Delete / enable / disable / restore change the live catalog just as much as an edit does, so they prompt to
  // propagate too. promptReapply runs the server dry-run and returns SILENTLY when nothing actually moved, so
  // acting on a component that can't affect any split (a deduction, say) costs a check and shows nothing.
  const afterMutation = useCallback(() => { reload(); void promptReapply(); }, [reload, promptReapply]);
  const sd = useSoftDelete("pay-components", "pay component", afterMutation);
  const lc = useLifecycle("pay-components", "pay component", afterMutation);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PayComponent | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [err, setErr] = useState<string | null>(null);
  const [again, setAgain] = useState(false);
  const guard = useDialogGuard(open, form, () => setOpen(false), { label: "pay component" });
  const nameRef = useRef<HTMLInputElement>(null);

  // EPF/ESI: the server keeps one component per side (a second would double-charge that side). Which side is
  // already held - by whom - so the dialog can offer it as taken instead of letting the save 400.
  const sideHolder = (kind: string) =>
    ["epf", "esi", "edli", "pf_admin"].includes(form.method)
      ? rows.find((r) => r.method === form.method && r.kind === kind && !r.delete_time && r.path !== editing?.path)
      : undefined;
  const sideTaken = (kind: string) => !!sideHolder(kind);
  const sideOwner = (kind: string) => sideHolder(kind)?.display_name ?? "";

  function openCreate(kind: Form["kind"] = "earning") {
    setEditing(null);
    setForm({ ...EMPTY, kind });
    setErr(null);
    setOpen(true);
  }
  function openEdit(pc: PayComponent) {
    setEditing(pc);
    setForm({ name: pc.display_name, kind: pc.kind, method: pc.method, rate: String(pc.rate ?? ""), cap: String(pc.cap ?? ""), regime: pc.regime ?? "new", recurring: pc.recurring, in_ctc: pc.in_ctc !== false, pf_wages: pc.pf_wages === true });
    setErr(null);
    setOpen(true);
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const isTax = form.method === "income_tax";
      const isEpf = form.method === "epf";
      const isEsi = form.method === "esi";
      const isPt = form.method === "pt";
      const isPfCharge = PF_CHARGE_METHODS.includes(form.method);
      // TDS + PT are employee-only (forced deduction), EDLI + PF admin charges employer-only (an employer levy).
      // EPF/ESI can be the employee share (deduction) OR the employer share (employer_contribution) - the user
      // picks, so the kind is honoured.
      const employeeOnly = isTax || isPt;
      const body = {
        display_name: form.name,
        kind: (employeeOnly ? "deduction" : isPfCharge ? "employer_contribution" : form.kind) as "earning" | "deduction" | "employer_contribution",
        method: form.method as "fixed" | "percent_base" | "income_tax" | "epf" | "esi" | "pt" | "edli" | "pf_admin",
        // TDS + PT are engine-computed (no rate); EPF defaults 12%, ESI 0.75%, EDLI/admin charges 0.5% each.
        rate: isTax || isPt ? null : isEpf ? (form.rate ? Number(form.rate) : 12) : isEsi ? (form.rate ? Number(form.rate) : (form.kind === "employer_contribution" ? 3.25 : 0.75)) : isPfCharge ? (form.rate ? Number(form.rate) : 0.5) : form.rate ? Number(form.rate) : null,
        cap: isEpf || isPfCharge ? (form.cap ? Number(form.cap) : null) : isEsi ? (form.cap ? Number(form.cap) : 21000) : null,
        regime: isTax ? form.regime : "",
        recurring: form.recurring,
        // Which side of CTC an employer contribution lands on. Only meaningful for that kind; the server pins
        // everything else to "inside CTC".
        in_ctc: form.kind === "employer_contribution" || isPfCharge ? form.in_ctc : true,
        // Whether this allowance counts as PF wages - only meaningful for an earning, and only under the
        // "basic_plus" PF wage basis (Settings → CTC).
        pf_wages: form.kind === "earning" && !employeeOnly && !isPfCharge ? form.pf_wages : false,
      };
      if (editing) {
        await patch("pay-components/" + idOf(editing.path), body, editing.etag);
        toast({ title: "Pay component updated", variant: "success" });
      } else {
        await create("pay-components", body);
        toast({ title: "Pay component created", variant: "success" });
      }
      // "Add another" keeps the kind: components are catalogued in families (three earnings, then the deductions).
      if (again && !editing) {
        const next = { ...EMPTY, kind: form.kind };
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
      // Always ask the dry-run rather than guessing from the SAVED kind: an edit that moves a component OFF
      // employer_contribution (or off earning) shifts the CTC build-up exactly as much as one that moves it on,
      // and so does flipping a contribution's CTC side. The prompt stays silent when no split actually moved.
      await promptReapply();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<PayComponent>[] = [
    { id: "name", header: "Name", accessor: (pc) => pc.display_name, cell: (pc) => <span className="font-medium">{pc.display_name}</span> },
    {
      id: "kind", header: "Kind", filter: "select",
      // Employer contributions carry their CTC side here: the two states differ in every CTC figure, so the
      // catalog says which one this row is rather than making you open it.
      accessor: (pc) => (pc.kind === "employer_contribution" && pc.in_ctc === false ? "Employer contribution (over & above CTC)" : KIND_LABEL[pc.kind] ?? "Earning"),
      cell: (pc) => (
        <div className="flex flex-wrap items-center gap-1">
          <Badge variant={pc.kind === "deduction" ? "warning" : pc.kind === "employer_contribution" ? "info" : "success"}>{KIND_LABEL[pc.kind] ?? "Earning"}</Badge>
          {pc.kind === "employer_contribution" && <Badge variant={pc.in_ctc === false ? "warning" : "muted"}>{pc.in_ctc === false ? "over & above CTC" : "in CTC"}</Badge>}
        </div>
      ),
    },
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
        if (pc.method === "epf" || PF_CHARGE_METHODS.includes(pc.method)) return <span className={cls}>{isDeduction ? "−" : "+"}{pc.rate ?? (pc.method === "epf" ? 12 : 0.5)}%{pc.cap ? ` (cap ${pc.cap})` : ""}</span>;
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
          emptyAction={createBtn}
          toolbar={createBtn}
          accessCollection="pay-components"
          accessTargetOf={(pc) => ({ objectPath: pc.path, label: pc.display_name, can: pc.access?.can })}
        />
      </DataState>

      <Dialog open={open} onOpenChange={guard.onOpenChange}>
        {/* The longest form in this domain (kind, method, rate, ceiling, CTC side, two flags, activity): its
            Save belongs on screen the whole way down, not below the fold. */}
        <DialogContent scrollBody onEnterSubmit={() => { if (!busy && form.name.trim()) submit(); }}>
          <AccessScope collection="pay-components" objectPath={editing?.path}>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit pay component" : "New pay component"}</DialogTitle>
            <DialogDescription>
              {editing
                ? "Changing a component re-prices every payroll run built after the change - existing runs keep their numbers until rebuilt."
                : "A reusable line on the payslip. What it is (earning, deduction, employer cost) and how its amount is worked out."}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
          <FormError error={err} />
          <Field label="Name">
            <Input ref={nameRef} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Base Salary" autoFocus />
          </Field>
          <FieldRow>
            <Field label="Kind">
              <Select value={form.kind} onValueChange={(v) => setForm({ ...form, kind: v })} disabled={["income_tax", "pt", ...PF_CHARGE_METHODS].includes(form.method)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {/* EPF/ESI can be the employee share (deduction) or the employer share (employer_contribution),
                      never an earning; fixed/percent_base can be any kind (gratuity = percent_base employer). */}
                  {!["epf", "esi", ...PF_CHARGE_METHODS].includes(form.method) && <SelectItem value="earning">Earning</SelectItem>}
                  {/* EPF/ESI allow one component per side, so a side another component already holds is offered
                      as taken rather than as a choice the save would reject. */}
                  <SelectItem value="deduction" disabled={sideTaken("deduction")}>Deduction{sideTaken("deduction") ? ` - taken by ${sideOwner("deduction")}` : ""}</SelectItem>
                  <SelectItem value="employer_contribution" disabled={sideTaken("employer_contribution")}>Employer contribution{sideTaken("employer_contribution") ? ` - taken by ${sideOwner("employer_contribution")}` : ""}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Method">
              <Select value={form.method} onValueChange={(v) => setForm({ ...form, method: v, kind: ["income_tax", "pt"].includes(v) ? "deduction" : PF_CHARGE_METHODS.includes(v) ? "employer_contribution" : (["epf", "esi"].includes(v) && form.kind === "earning") ? "deduction" : form.kind })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="fixed">Fixed amount</SelectItem>
                  <SelectItem value="percent_base">% of base</SelectItem>
                  <SelectItem value="income_tax">Income tax (TDS)</SelectItem>
                  <SelectItem value="epf">EPF (Provident Fund)</SelectItem>
                  <SelectItem value="esi">ESI (state insurance)</SelectItem>
                  <SelectItem value="pt">Professional Tax</SelectItem>
                  <SelectItem value="edli">EDLI charges (employer)</SelectItem>
                  <SelectItem value="pf_admin">PF admin charges (employer)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </FieldRow>
          {/* The CTC question for an employer contribution: inside the CTC figure (the common Indian convention)
              or paid over and above it. Per component, so employer PF, employer ESI and gratuity can differ. It
              changes every CTC surface (comp tab, letters, run totals, payslip) but never the employee's net. */}
          {form.kind === "employer_contribution" && (
            <Field label="Cost to company" hint="Either way the company pays it and payroll costs it - this only decides whether it sits inside the CTC number.">
              <Select value={form.in_ctc ? "in" : "above"} onValueChange={(v) => setForm({ ...form, in_ctc: v === "in" })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="in">Included in CTC</SelectItem>
                  <SelectItem value="above">Over &amp; above CTC (excluded from CTC)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}
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
            <FieldRow>
              <Field label="Employee rate %" hint="Statutory employee contribution is 12%.">
                <Input type="number" min={0} max={100} step="0.01" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} placeholder="12" />
              </Field>
              <Field label="Wage ceiling" hint="Cap on the base. Leave blank to apply to the full base.">
                <MoneyInput value={form.cap} onChange={(v) => setForm({ ...form, cap: v })} placeholder="15000" min={0} suffix="ceiling" />
              </Field>
            </FieldRow>
          ) : form.method === "esi" ? (
            <FieldRow>
              <Field label="Employee rate %" hint="Statutory employee contribution is 0.75% of gross.">
                <Input type="number" min={0} max={100} step="0.01" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} placeholder="0.75" />
              </Field>
              <Field label="Eligibility ceiling" hint="No ESI when monthly gross exceeds this (default 21000).">
                <MoneyInput value={form.cap} onChange={(v) => setForm({ ...form, cap: v })} placeholder="21000" min={0} suffix="a month" />
              </Field>
            </FieldRow>
          ) : PF_CHARGE_METHODS.includes(form.method) ? (
            <FieldRow>
              <Field label="Rate %" hint="Statutory EDLI and PF administration charges are 0.5% of PF wages each.">
                <Input type="number" min={0} max={100} step="0.01" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} placeholder="0.5" />
              </Field>
              <Field label="Wage ceiling" hint="Cap on PF wages - the same ceiling EPF uses.">
                <MoneyInput value={form.cap} onChange={(v) => setForm({ ...form, cap: v })} placeholder="15000" min={0} suffix="ceiling" />
              </Field>
            </FieldRow>
          ) : form.method === "pt" ? (
            <p className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">Professional Tax is computed each run from the configured state slabs (default: nil up to ₹25,000/month, ₹200 above); this component just enables the deduction.</p>
          ) : form.method === "fixed" ? (
            /* A fixed component is the only method whose rate IS an amount, so it gets the money field - the
               currency in view and the figure echoed back, because a stray zero here is a stray zero on every
               payslip that carries this line. */
            <Field label="Amount" hint="Paid in full each period this component applies to.">
              <MoneyInput value={form.rate} onChange={(v) => setForm({ ...form, rate: v })} min={0} suffix={form.recurring ? "per period" : "one-off"} />
            </Field>
          ) : form.method === "percent_base" ? (
            <Field label="Rate %" hint="Percentage of the employee's basic pay.">
              <Input type="number" min={0} max={100} step="0.01" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} placeholder="e.g. 40" />
            </Field>
          ) : (
            <Field label="Rate per unit" hint="Multiplied by the quantity entered on the run (e.g. overtime hours).">
              <MoneyInput value={form.rate} onChange={(v) => setForm({ ...form, rate: v })} min={0} suffix="per unit" />
            </Field>
          )}
          {/* PF wages: only asked for an earning, and only bites when Settings → CTC sets the PF wage basis to
              "basic + universally-paid allowances". HRA, overtime and bonus are excluded from PF wages by statute,
              so they stay off. */}
          {form.kind === "earning" && !["income_tax", "pt"].includes(form.method) && (
            <div className="flex items-start gap-2">
              <Checkbox id="pf_wages" checked={form.pf_wages} onCheckedChange={(v) => setForm({ ...form, pf_wages: v === true })} />
              <div className="grid gap-0.5">
                <Label htmlFor="pf_wages">Counts as PF wages</Label>
                <span className="text-xs text-muted-foreground">Applies only when the PF wage basis is "basic + allowances" (Settings → CTC). Never tick HRA.</span>
              </div>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Checkbox id="recurring" checked={form.recurring} onCheckedChange={(v) => setForm({ ...form, recurring: v === true })} />
            <Label htmlFor="recurring">Recurring</Label>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">Use the Disable action to stop a component from being applied in payroll.</p>
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
            <Button onClick={submit} loading={busy} disabled={!form.name.trim()}>{editing ? "Save changes" : again ? "Create & add another" : "Create"}</Button>
          </DialogFooter>
          </AccessScope>
        </DialogContent>
      </Dialog>
    </div>
  );
}
