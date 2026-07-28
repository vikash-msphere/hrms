import { useMemo, useState } from "react";
import { Plus, Gift } from "lucide-react";
import { invoke } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { usePermission } from "@/lib/perm";
import { formatDate, idOf } from "@/lib/utils";
import { useMoney } from "@/lib/org";
import type { Bonus, Department, Employee } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { Field } from "@/components/common/Field";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AccessAction } from "@/components/access/AccessAction";
import { useToast } from "@/components/ui/use-toast";

const KINDS = ["Performance Bonus", "Joining Bonus", "Retention Bonus", "Festival Bonus", "Incentive", "Spot Award"];
const todayYmd = () => new Date().toISOString().slice(0, 10);

// Every bonus (individual + company/department awards) and an "Award bonus" action. Group awards are
// materialized one row per employee (so they show on each profile); here they're collapsed back into a single
// line per award. Bonuses are paid - as a taxable earning - by the next payroll run.
export function PayrollBonuses() {
  const { rows, state, error, reload } = useCollection<Bonus>("bonuses");
  const { rows: employees } = useCollection<Employee>("employees");
  const { rows: departments } = useCollection<Department>("departments");
  const { toast } = useToast();
  const money = useMoney();
  const canAward = usePermission("bonuses.award");

  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? idOf(ref) : "-");
  }, [employees]);
  const deptName = useMemo(() => {
    const m = new Map(departments.map((d) => [idOf(d.path), d.display_name]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? idOf(ref) : "-");
  }, [departments]);

  // Collapse group awards (shared batch_id) into one line; keep individual bonuses as their own line.
  const entries = useMemo(() => {
    const byBatch = new Map<string, Bonus[]>();
    const out: { key: string; who: string; scope: string; rows: Bonus[] }[] = [];
    for (const b of rows) {
      if (b.batch_id) {
        const a = byBatch.get(b.batch_id) ?? [];
        if (!a.length) out.push({ key: b.batch_id, who: "", scope: b.scope ?? "company", rows: a });
        a.push(b);
        byBatch.set(b.batch_id, a);
      } else {
        out.push({ key: b.path, who: empName(b.employee), scope: "individual", rows: [b] });
      }
    }
    for (const e of out) {
      if (e.scope === "company") e.who = "Company-wide";
      else if (e.scope === "department") e.who = `Dept · ${deptName(e.rows[0]?.scope_ref)}`;
    }
    return out.sort((a, b) => (b.rows[0]?.award_date ?? "").localeCompare(a.rows[0]?.award_date ?? ""));
  }, [rows, empName, deptName]);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ scope: "company" as "company" | "department" | "individual", department: "", employee: "", amount: "", kind: "", reason: "", award_date: todayYmd() });

  async function submit() {
    const amount = Number(form.amount);
    if (!(amount > 0)) { toast({ variant: "destructive", title: "Enter an amount greater than 0" }); return; }
    setBusy(true);
    try {
      await invoke("bonuses", "award", undefined, {
        scope: form.scope,
        ...(form.scope === "department" ? { department: form.department } : {}),
        ...(form.scope === "individual" ? { employee: form.employee } : {}),
        amount,
        kind: form.kind || null,
        reason: form.reason || null,
        award_date: form.award_date,
      });
      toast({ title: "Bonus awarded", variant: "success" });
      setOpen(false);
      setForm({ scope: "company", department: "", employee: "", amount: "", kind: "", reason: "", award_date: todayYmd() });
      reload();
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't award", description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const awardBtn = canAward && (
    <AccessAction collection="bonuses" verb="award" label="Award bonus">
      <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Award bonus</Button>
    </AccessAction>
  );

  const valid = Number(form.amount) > 0 && (form.scope !== "department" || form.department) && (form.scope !== "individual" || form.employee);

  return (
    <div>
      <PageHeader
        title="Bonuses"
        description="All bonuses - individual and company/department awards. Paid as a taxable earning by the next payroll run."
        actions={awardBtn}
      />
      <DataState state={state} error={error} onRetry={reload}>
        {entries.length === 0 ? (
          <EmptyState icon={Gift} title="No bonuses yet" description="Award a company-wide, department, or individual bonus." action={awardBtn} />
        ) : (
          <div className="divide-y rounded-lg border">
            {entries.map((e) => {
              const b = e.rows[0]!;
              const total = e.rows.reduce((s, r) => s + r.amount, 0);
              const paidCount = e.rows.filter((r) => r.paid).length;
              return (
                <div key={e.key} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"><Gift className="h-4 w-4" /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="font-medium">{e.who}</span>
                      {e.scope !== "individual" && <Badge variant="secondary">{e.rows.length} {e.rows.length === 1 ? "person" : "people"}</Badge>}
                      {b.kind && <span className="text-xs text-muted-foreground">{b.kind}</span>}
                    </div>
                    <div className="text-xs text-muted-foreground">{formatDate(b.award_date)}{b.reason ? ` · ${b.reason}` : ""}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-medium tabular-nums">{money(b.amount, b.currency_code)}{e.scope !== "individual" ? " ea" : ""}</div>
                    {e.scope !== "individual" && <div className="text-xs tabular-nums text-muted-foreground">{money(total, b.currency_code)} total</div>}
                  </div>
                  <Badge variant={paidCount === e.rows.length ? "secondary" : "muted"} className="shrink-0">
                    {paidCount === 0 ? "Pending" : paidCount === e.rows.length ? "Paid" : `${paidCount}/${e.rows.length} paid`}
                  </Badge>
                </div>
              );
            })}
          </div>
        )}
      </DataState>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Award bonus</DialogTitle>
          </DialogHeader>
          <Field label="Who">
            <Select value={form.scope} onValueChange={(v) => setForm({ ...form, scope: v as typeof form.scope })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="company">Everyone (company-wide)</SelectItem>
                <SelectItem value="department">A department</SelectItem>
                <SelectItem value="individual">One employee</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {form.scope === "department" && (
            <Field label="Department">
              <Select value={form.department} onValueChange={(v) => setForm({ ...form, department: v })}>
                <SelectTrigger><SelectValue placeholder="Select a department…" /></SelectTrigger>
                <SelectContent>
                  {departments.filter((d) => !d.delete_time).map((d) => (
                    <SelectItem key={d.path} value={`departments/${idOf(d.path)}`}>{d.display_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          {form.scope === "individual" && (
            <Field label="Employee">
              <Combobox
                value={form.employee}
                onValueChange={(v) => setForm({ ...form, employee: v })}
                placeholder="Select an employee…"
                searchPlaceholder="Search employees…"
                options={employees.map((e) => ({ value: `employees/${idOf(e.path)}`, label: `${e.first_name} ${e.last_name}` }))}
              />
            </Field>
          )}
          <div className="grid grid-cols-2 gap-4">
            <Field label="Amount (per person)"><Input type="number" min="0" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field>
            <Field label="Award date"><Input type="date" value={form.award_date} onChange={(e) => setForm({ ...form, award_date: e.target.value })} /></Field>
          </div>
          <Field label="Kind">
            <Select value={form.kind} onValueChange={(v) => setForm({ ...form, kind: v })}>
              <SelectTrigger><SelectValue placeholder="Select a kind…" /></SelectTrigger>
              <SelectContent>
                {KINDS.map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Reason (optional)"><Textarea rows={2} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} loading={busy} disabled={!valid}>Award</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
