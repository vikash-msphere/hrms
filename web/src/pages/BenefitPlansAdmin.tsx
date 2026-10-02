import { useMemo, useState } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { create, patch, remove } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { formatMoney, idOf } from "@/lib/utils";
import { useOrg, currencyDecimals } from "@/lib/org";
import type { BenefitCategory, BenefitPlan } from "@/types";
import { DataState } from "@/components/common/DataState";
import { AccessScope } from "@/components/access/AccessScope";
import { AccessAction } from "@/components/access/AccessAction";
import { AccessItem } from "@/components/access/AccessItem";
import { EmptyState } from "@/components/common/EmptyState";
import { TruncationNotice } from "@/components/common/TruncationNotice";
import { Field } from "@/components/common/Field";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { HeartPulse } from "lucide-react";
import { useConfirm } from "@/components/common/confirm";
import { useDeletedToast } from "@/hooks/useSoftDelete";
import { useToast } from "@/components/ui/use-toast";

const CATEGORIES: { value: BenefitCategory; label: string }[] = [
  { value: "health", label: "Health" }, { value: "dental", label: "Dental" }, { value: "vision", label: "Vision" },
  { value: "life", label: "Life" }, { value: "disability", label: "Disability" }, { value: "retirement", label: "Retirement" }, { value: "other", label: "Other" },
];
const perLabel = (p: "month" | "year") => (p === "year" ? "/yr" : "/mo");
const EMPTY = { name: "", category: "health" as BenefitCategory, description: "", provider: "", employee_cost: "", employer_cost: "", cost_period: "month" as "month" | "year", allows_dependents: false };

// HR catalog editor for benefit plans (Settings → Benefits).
export default function BenefitPlansAdmin({ openId }: { openId?: string }) {
  // `all`, for the same reason ProjectsAdmin needs it: a card grid is the other shape a catalog comes in, and
  // it has nowhere to admit that the server capped the page and no Load more for a reader to press - so the
  // first hundred plans silently read as the whole catalog, and a deep link to any plan past them opened
  // nothing. The walk only runs while a cursor keeps coming back, so an ordinary catalog pays nothing.
  //
  // And the TruncationNotice below for the same reason ProjectsAdmin carries one: the walk stops at the
  // hook's `ALL_CAP`, so `all` moves the window rather than removing it, and the grid still needs somewhere
  // to admit that it is showing part of the catalog.
  const { rows, state, error, reload } = useCollection<BenefitPlan>("benefit-plans", { all: true });
  useDeepOpen(openId, rows, openEdit);
  const { toast } = useToast();
  const confirm = useConfirm();
  const deleted = useDeletedToast();
  const { org } = useOrg();
  const money = (n: number) => formatMoney(n, org.default_currency, currencyDecimals(undefined, org));
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<BenefitPlan | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);

  const sorted = useMemo(() => [...rows].sort((a, b) => a.name.localeCompare(b.name)), [rows]);

  function openCreate() { setEditing(null); setForm(EMPTY); setOpen(true); }
  function openEdit(p: BenefitPlan) {
    setEditing(p);
    setForm({ name: p.name, category: p.category, description: p.description ?? "", provider: p.provider ?? "", employee_cost: String(p.employee_cost ?? 0), employer_cost: String(p.employer_cost ?? 0), cost_period: p.cost_period ?? "month", allows_dependents: p.allows_dependents });
    setOpen(true);
  }
  async function save() {
    const body = { name: form.name.trim(), category: form.category, description: form.description.trim() || null, provider: form.provider.trim() || null, employee_cost: Number(form.employee_cost) || 0, employer_cost: Number(form.employer_cost) || 0, cost_period: form.cost_period, allows_dependents: form.allows_dependents };
    setBusy(true);
    try {
      if (editing) await patch(`benefit-plans/${idOf(editing.path)}`, body, editing.etag);
      else await create("benefit-plans", body);
      toast({ title: editing ? "Plan updated" : "Plan added", variant: "success" });
      setOpen(false); reload();
    } catch (e) { toast({ title: "Couldn't save the plan", description: (e as Error).message, variant: "destructive" }); }
    finally { setBusy(false); }
  }
  async function del(p: BenefitPlan) {
    if (!(await confirm({ title: `Delete the "${p.name}" plan?`, destructive: true, confirmLabel: "Delete" }))) return;
    try { await remove(`benefit-plans/${idOf(p.path)}`); reload(); deleted({ path: `benefit-plans/${idOf(p.path)}`, noun: "plan", can: p.access?.can, reload }); }
    catch (e) { toast({ title: "Couldn't delete", description: (e as Error).message, variant: "destructive" }); }
  }

  return (
    // Settings-embedded editor: no route scope to inherit, so bind the benefit-plans collection explicitly.
    <AccessScope collection="benefit-plans">
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold">
            <AccessAction collection="benefit-plans" label="Benefit plans"><span>Benefit plans</span></AccessAction>
          </h3>
          <p className="text-sm text-muted-foreground">The catalog employees can enrol in. Costs are monthly.</p>
        </div>
        <AccessAction create label="Benefit plan">
          <Button onClick={openCreate}><Plus className="h-4 w-4" /> New plan</Button>
        </AccessAction>
      </div>

      <DataState state={state} error={error} onRetry={reload}>
        {sorted.length === 0 ? (
          <EmptyState icon={HeartPulse} title="No plans" description="Add a benefit plan for employees to enrol in." action={<AccessAction create label="Benefit plan"><Button onClick={openCreate}><Plus className="h-4 w-4" /> New plan</Button></AccessAction>} />
        ) : (
          <div className="space-y-2">
            <TruncationNotice collection="benefit-plans" what="plans" />
            {sorted.map((p) => (
              <AccessItem key={p.path} objectPath={p.path} can={p.access?.can} label={p.name}>
              <Card className="flex flex-wrap items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{p.name}</span>
                    <Badge variant="muted">{CATEGORIES.find((c) => c.value === p.category)?.label}</Badge>
                    {p.allows_dependents && <Badge variant="secondary">Dependents</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground">{p.provider ?? "-"} · you {money(p.employee_cost)}{perLabel(p.cost_period)} · employer {money(p.employer_cost)}{perLabel(p.cost_period)}</p>
                </div>
                <div className="flex items-center gap-1">
                  <AccessAction objectPath={p.path} can={p.access?.can} verb="update" label={p.name}>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(p)} aria-label="Edit"><Pencil className="h-3.5 w-3.5" /></Button>
                  </AccessAction>
                  <AccessAction objectPath={p.path} can={p.access?.can} verb="delete" label={p.name}>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => del(p)} aria-label="Delete"><Trash2 className="h-3.5 w-3.5" /></Button>
                  </AccessAction>
                </div>
              </Card>
              </AccessItem>
            ))}
          </div>
        )}
      </DataState>

      <Dialog open={open} onOpenChange={setOpen}>
        {/* scrollBody: a dozen fields plus the activity trail, so the save action needed pinning. */}
        <DialogContent scrollBody onEnterSubmit={() => { if (!busy && form.name.trim()) void save(); }}>
          <DialogHeader><DialogTitle>{editing ? "Edit plan" : "New benefit plan"}</DialogTitle></DialogHeader>
          <DialogBody>
          <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Category">
              <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v as BenefitCategory })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{CATEGORIES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Provider"><Input value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} /></Field>
            <Field label="Billing period">
              <Select value={form.cost_period} onValueChange={(v) => setForm({ ...form, cost_period: v as "month" | "year" })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="month">Per month</SelectItem>
                  <SelectItem value="year">Per year</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label={`Employee cost ${perLabel(form.cost_period)}`}><Input type="number" min={0} value={form.employee_cost} onChange={(e) => setForm({ ...form, employee_cost: e.target.value })} /></Field>
            <Field label={`Employer cost ${perLabel(form.cost_period)}`}><Input type="number" min={0} value={form.employer_cost} onChange={(e) => setForm({ ...form, employer_cost: e.target.value })} /></Field>
          </div>
          <Field label="Description"><Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={form.allows_dependents} onCheckedChange={(v) => setForm({ ...form, allows_dependents: v === true })} />
            Dependents can be covered under this plan
          </label>
          {editing && <ActivitySection resource={editing.path} className="border-t pt-3" />}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={save} loading={busy} disabled={!form.name.trim()}>{editing ? "Save changes" : "Create"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </AccessScope>
  );
}
