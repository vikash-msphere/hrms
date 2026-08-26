import { useMemo, useState } from "react";
import { HeartPulse, Plus, Pencil, Trash2, Users, Check } from "lucide-react";
import { create, patch, remove } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { formatDate, formatMoney, idOf } from "@/lib/utils";
import { useOrg, currencyDecimals } from "@/lib/org";
import type { BenefitCategory, BenefitEnrollment, BenefitPlan, Dependent, DependentRelationship, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { PageSettings } from "@/components/common/SettingsButton";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { useKpiFocus } from "@/lib/kpiFocus";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { Field } from "@/components/common/Field";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";
import { AccessAction } from "@/components/access/AccessAction";
import { AccessItem } from "@/components/access/AccessItem";

const CATEGORY: Record<BenefitCategory, string> = { health: "Health", dental: "Dental", vision: "Vision", life: "Life", disability: "Disability", retirement: "Retirement", other: "Other" };
const RELATIONSHIP: { value: DependentRelationship; label: string }[] = [
  { value: "spouse", label: "Spouse" }, { value: "child", label: "Child" }, { value: "parent", label: "Parent" }, { value: "domestic_partner", label: "Domestic partner" }, { value: "other", label: "Other" },
];
const per = (p: BenefitPlan) => (p.cost_period === "year" ? "/yr" : "/mo");
const pad = (n: number) => String(n).padStart(2, "0");
// Local-time today for the default effective date (toISOString shifts across midnight in non-UTC zones).
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const DEP_EMPTY = { name: "", relationship: "spouse" as DependentRelationship, date_of_birth: "" };

export default function Benefits({ me }: { me: Me }) {
  const { rows: plans, state, error, reload: reloadPlans } = useCollection<BenefitPlan>("benefit-plans");
  const { rows: enrollments, reload: reloadEnr } = useCollection<BenefitEnrollment>("benefit-enrollments");
  // This page is strictly self-service, and server list scoping can hand an HR viewer EVERYONE's dependents -
  // so ask for the caller's own, server-side. One person's rows instead of a page of the org's.
  const { rows: dependents, reload: reloadDeps } = useCollection<Dependent>("dependents", {
    enabled: !!me.employee_id,
    params: me.employee_id ? { employee: `employees/${me.employee_id}` } : {},
  });
  const { toast } = useToast();
  const confirm = useConfirm();
  const { org } = useOrg();
  const money = (n: number) => formatMoney(n, org.default_currency, currencyDecimals(undefined, org));
  const reloadAll = () => { reloadPlans(); reloadEnr(); reloadDeps(); };

  const [depDialog, setDepDialog] = useState<Dependent | "new" | null>(null);
  const [enrollPlan, setEnrollPlan] = useState<BenefitPlan | null>(null);
  const [waiving, setWaiving] = useState<string | null>(null);

  // Server list scoping can hand an HR viewer everyone's rows - this page is strictly self-service,
  // so pin the dependents section, the enrollment badges, and the dialog picker to the caller's own.
  const myDeps = useMemo(() => dependents.filter((d) => d.employee && idOf(d.employee) === me.employee_id), [dependents, me.employee_id]);
  const myEnrollment = useMemo(() => {
    const m = new Map<string, BenefitEnrollment>();
    for (const e of enrollments) if (e.plan && e.employee && idOf(e.employee) === me.employee_id) m.set(idOf(e.plan), e);
    return (planId: string) => m.get(planId);
  }, [enrollments, me.employee_id]);
  const depName = useMemo(() => {
    const m = new Map(dependents.map((d) => [idOf(d.path), d.name]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Dependent" : "");
  }, [dependents]);

  // Answer-first: what am I enrolled in and what does it cost me per month?
  const enrolled = useMemo(() => plans.filter((p) => myEnrollment(idOf(p.path))?.status === "enrolled"), [plans, myEnrollment]);
  const monthlyCost = enrolled.reduce((s, p) => s + (p.cost_period === "year" ? p.employee_cost / 12 : p.employee_cost), 0);
  // A plan you have neither taken nor waived is an open decision - the one thing on this page that needs doing.
  const isUndecided = (p: BenefitPlan) => !myEnrollment(idOf(p.path));
  const undecided = useMemo(() => plans.filter(isUndecided), [plans, myEnrollment]); // eslint-disable-line react-hooks/exhaustive-deps
  // Dependents you have added but not attached to any plan you are enrolled in: added, yet not covered.
  const coveredDepIds = useMemo(() => {
    const s = new Set<string>();
    for (const e of enrollments) {
      if (!e.employee || idOf(e.employee) !== me.employee_id || e.status !== "enrolled") continue;
      for (const d of e.dependents ?? []) s.add(idOf(d));
    }
    return s;
  }, [enrollments, me.employee_id]);
  const uncoveredDeps = myDeps.filter((d) => !coveredDepIds.has(idOf(d.path)));
  const kf = useKpiFocus<BenefitPlan, "all" | "enrolled" | "paid" | "undecided" | "waived">({
    all: { label: "plans", match: () => true },
    enrolled: { label: "plans you are enrolled in", match: (p) => myEnrollment(idOf(p.path))?.status === "enrolled" },
    paid: { label: "plans you pay for", match: (p) => myEnrollment(idOf(p.path))?.status === "enrolled" && p.employee_cost > 0 },
    undecided: { label: "plans you have not decided on", match: isUndecided },
    waived: { label: "plans you waived", match: (p) => myEnrollment(idOf(p.path))?.status === "waived" },
  });
  const shownPlans = kf.apply(plans);

  async function saveDependent(body: { name: string; relationship: DependentRelationship; date_of_birth: string | null }, existing: Dependent | null) {
    try {
      if (existing) await patch(`dependents/${idOf(existing.path)}`, body, existing.etag);
      else await create("dependents", body);
      toast({ title: existing ? "Dependent updated" : "Dependent added", variant: "success" });
      setDepDialog(null); reloadDeps();
    } catch (e) { toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" }); }
  }
  async function deleteDependent(d: Dependent) {
    if (!(await confirm({ title: `Remove ${d.name}?`, destructive: true, confirmLabel: "Remove" }))) return;
    try { await remove(`dependents/${idOf(d.path)}`); reloadDeps(); }
    catch (e) { toast({ title: "Couldn't remove", description: (e as Error).message, variant: "destructive" }); }
  }
  async function elect(plan: BenefitPlan, body: { status: "enrolled" | "waived"; effective_date?: string; dependents?: string[] }) {
    const existing = myEnrollment(idOf(plan.path));
    try {
      if (existing) await patch(`benefit-enrollments/${idOf(existing.path)}`, body, existing.etag);
      else await create("benefit-enrollments", { plan: `benefit-plans/${idOf(plan.path)}`, ...body });
      toast({ title: body.status === "waived" ? `Waived ${plan.name}` : `Enrolled in ${plan.name}`, variant: "success" });
      setEnrollPlan(null); reloadEnr();
    } catch (e) { toast({ title: "Couldn't update your enrollment", description: (e as Error).message, variant: "destructive" }); }
  }
  async function waive(plan: BenefitPlan) {
    const wasEnrolled = myEnrollment(idOf(plan.path))?.status === "enrolled";
    if (wasEnrolled && !(await confirm({ title: `Waive ${plan.name}?`, description: "Your enrollment (and any covered dependents) ends. You can enrol again later.", confirmLabel: "Waive" }))) return;
    setWaiving(plan.path);
    try { await elect(plan, { status: "waived" }); } finally { setWaiving(null); }
  }

  return (
    <div>
      <PageHeader title="Benefits" actions={<PageSettings me={me} host="benefits" />} />

      <DataState state={state} error={error} onRetry={reloadAll}>
        {plans.length > 0 && (
          <SummaryStrip
            items={[
              { label: "Enrolled plans", value: enrolled.length, icon: HeartPulse, tone: enrolled.length ? "default" : "muted", hint: enrolled.length ? "show only these" : "nothing elected yet", ...kf.kpi("enrolled") },
              ...(undecided.length
                ? [{ label: "Not decided", value: undecided.length, icon: HeartPulse, tone: "warning" as const, hint: "enrol or waive these", ...kf.kpi("undecided") }]
                : []),
              { label: "Your cost", value: monthlyCost > 0 ? `${money(Math.round(monthlyCost))}/mo` : "Free", tone: monthlyCost > 0 ? "default" : "success", hint: "enrolled plans", ...kf.kpi("paid") },
              {
                label: "Dependents", value: myDeps.length, icon: Users, tone: myDeps.length ? "default" : "muted",
                hint: uncoveredDeps.length ? `${uncoveredDeps.length} not covered` : myDeps.length ? "all covered" : "none added",
                onClick: () => document.getElementById("benefit-dependents")?.scrollIntoView({ behavior: "smooth", block: "start" }),
              },
            ]}
          />
        )}

        {/* Dependents */}
        <div id="benefit-dependents" className="mb-6 scroll-mt-24">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold"><Users className="h-4 w-4 text-muted-foreground" /> Your dependents</h2>
            <AccessAction collection="dependents" create label="Add dependent">
              <Button size="sm" variant="outline" onClick={() => setDepDialog("new")}><Plus className="h-3.5 w-3.5" /> Add dependent</Button>
            </AccessAction>
          </div>
          {myDeps.length === 0 ? (
            <p className="text-sm text-muted-foreground">No dependents yet - add one to cover them on a plan.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {myDeps.map((d) => (
                <span key={d.path} className="group flex items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-sm">
                  {d.name} <span className="text-xs text-muted-foreground">{RELATIONSHIP.find((r) => r.value === d.relationship)?.label}</span>
                  <button type="button" onClick={() => setDepDialog(d)} className="text-muted-foreground hover:text-foreground" aria-label="Edit"><Pencil className="h-3 w-3" /></button>
                  <button type="button" onClick={() => deleteDependent(d)} className="text-muted-foreground hover:text-destructive" aria-label="Remove"><Trash2 className="h-3 w-3" /></button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Plans */}
        {plans.length === 0 ? (
          <EmptyState icon={HeartPulse} title="No plans available" description="Benefit plans will appear here once HR adds them." />
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {shownPlans.length === 0 && (
              <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground md:col-span-2 xl:col-span-3">
                No {kf.activeLabel}.{" "}
                <button type="button" className="font-medium text-primary underline-offset-2 hover:underline" onClick={kf.clear}>Show all plans</button>
              </p>
            )}
            {shownPlans.map((p) => {
              const enr = myEnrollment(idOf(p.path));
              return (
                <AccessItem key={p.path} collection="benefit-plans" objectPath={p.path} can={p.access?.can} why={p.access?.why} label="Benefit">
                <Card className="flex flex-col gap-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="font-semibold">{p.name}</h3>
                      <p className="text-xs text-muted-foreground">{CATEGORY[p.category]}{p.provider ? ` · ${p.provider}` : ""}</p>
                    </div>
                    {enr && <Badge variant={enr.status === "enrolled" ? "success" : "muted"}>{enr.status === "enrolled" ? "Enrolled" : "Waived"}</Badge>}
                  </div>
                  {p.description && <p className="text-sm text-foreground/80">{p.description}</p>}
                  <div className="mt-auto space-y-1 text-sm">
                    <div className="flex justify-between"><span className="text-muted-foreground">You pay</span><span className="font-medium tabular-nums">{p.employee_cost > 0 ? `${money(p.employee_cost)}${per(p)}` : "Free"}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Employer pays</span><span className="tabular-nums">{money(p.employer_cost)}{per(p)}</span></div>
                    {p.allows_dependents && (
                      <p className="flex items-center gap-1 pt-1 text-xs text-muted-foreground"><Users className="h-3 w-3" /> Dependents can be covered</p>
                    )}
                    {enr?.status === "enrolled" && (
                      <p className="pt-1 text-xs text-muted-foreground">
                        {enr.effective_date ? `Enrolled since ${formatDate(enr.effective_date)}` : "Enrolled"}
                        {(enr.dependents?.length ?? 0) > 0 ? ` · covering ${(enr.dependents ?? []).map((r) => depName(r)).join(", ")}` : ""}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" className="flex-1" onClick={() => setEnrollPlan(p)}>{enr?.status === "enrolled" ? "Change" : "Enrol"}</Button>
                    {enr?.status !== "waived" && <Button size="sm" variant="outline" loading={waiving === p.path} onClick={() => waive(p)}>Waive</Button>}
                  </div>
                </Card>
                </AccessItem>
              );
            })}
          </div>
        )}
      </DataState>

      {depDialog && (
        <DependentDialog dependent={depDialog === "new" ? null : depDialog} onClose={() => setDepDialog(null)} onSave={saveDependent} />
      )}
      {enrollPlan && (
        <EnrollDialog plan={enrollPlan} dependents={myDeps} current={myEnrollment(idOf(enrollPlan.path))} onClose={() => setEnrollPlan(null)} onEnrol={(body) => elect(enrollPlan, { status: "enrolled", ...body })} />
      )}
    </div>
  );
}

function DependentDialog({ dependent, onClose, onSave }: {
  dependent: Dependent | null;
  onClose: () => void;
  onSave: (body: { name: string; relationship: DependentRelationship; date_of_birth: string | null }, existing: Dependent | null) => void;
}) {
  const [form, setForm] = useState(dependent ? { name: dependent.name, relationship: dependent.relationship, date_of_birth: dependent.date_of_birth ?? "" } : DEP_EMPTY);
  const [busy, setBusy] = useState(false);
  const dobFuture = !!form.date_of_birth && form.date_of_birth > todayStr();
  const valid = !!form.name.trim() && !dobFuture;
  async function doSave() {
    setBusy(true);
    try { await onSave({ name: form.name.trim(), relationship: form.relationship, date_of_birth: form.date_of_birth || null }, dependent); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent scrollBody onEnterSubmit={() => { if (valid && !busy) doSave(); }}>
        <DialogHeader><DialogTitle>{dependent ? "Edit dependent" : "Add dependent"}</DialogTitle></DialogHeader>
        <DialogBody>
        <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
        <Field label="Relationship">
          <Select value={form.relationship} onValueChange={(v) => setForm({ ...form, relationship: v as DependentRelationship })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{RELATIONSHIP.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Date of birth (optional)" error={dobFuture ? "Date of birth can't be in the future." : undefined}>
          <Input type="date" value={form.date_of_birth} onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })} />
        </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={doSave} loading={busy} disabled={!valid}>{dependent ? "Save" : "Add dependent"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EnrollDialog({ plan, dependents, current, onClose, onEnrol }: {
  plan: BenefitPlan;
  dependents: Dependent[];
  current?: BenefitEnrollment;
  onClose: () => void;
  onEnrol: (body: { effective_date?: string; dependents?: string[] }) => void;
}) {
  const { org } = useOrg();
  const money = (n: number) => formatMoney(n, org.default_currency, currencyDecimals(undefined, org));
  const [effective, setEffective] = useState(current?.effective_date ?? todayStr());
  const [covered, setCovered] = useState<Set<string>>(new Set((current?.dependents ?? []).map((r) => idOf(r))));
  const toggle = (id: string) => setCovered((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const [busy, setBusy] = useState(false);
  async function doEnrol() {
    setBusy(true);
    try { await onEnrol({ effective_date: effective || undefined, dependents: plan.allows_dependents ? [...covered].map((id) => `dependents/${id}`) : [] }); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent onEnterSubmit={() => { if (!busy) doEnrol(); }}>
        <DialogHeader><DialogTitle>Enrol in {plan.name}</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">You pay <span className="font-medium text-foreground tabular-nums">{plan.employee_cost > 0 ? `${money(plan.employee_cost)}${per(plan)}` : "nothing"}</span>.</p>
        <Field label="Effective date"><Input type="date" value={effective} onChange={(e) => setEffective(e.target.value)} /></Field>
        {plan.allows_dependents && (
          <Field label="Cover dependents">
            {dependents.length === 0 ? (
              <p className="text-sm text-muted-foreground">No dependents yet - add them from the Benefits page first.</p>
            ) : (
              <div className="space-y-1.5">
                {dependents.map((d) => (
                  <label key={d.path} className="flex cursor-pointer items-center gap-2 text-sm">
                    <Checkbox checked={covered.has(idOf(d.path))} onCheckedChange={() => toggle(idOf(d.path))} />
                    {d.name} <span className="text-xs text-muted-foreground">{RELATIONSHIP.find((r) => r.value === d.relationship)?.label}</span>
                  </label>
                ))}
              </div>
            )}
          </Field>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={doEnrol} loading={busy}><Check className="h-4 w-4" /> {current?.status === "enrolled" ? "Save changes" : "Enrol"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
