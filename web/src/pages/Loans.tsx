import { useMemo, useState } from "react";
import { HandCoins, Plus, Check, X, Banknote, Trash2 } from "lucide-react";
import { create, invoke, remove } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { cn, formatMoney, idOf } from "@/lib/utils";
import { useOrg, currencyDecimals } from "@/lib/org";
import type { Employee, Loan, LoanStatus, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { useIntent } from "@/lib/intent";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { Field, FieldRow } from "@/components/common/Field";
import { ActivitySection } from "@/components/common/ActivitySection";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AccessAction } from "@/components/access/AccessAction";
import { AccessItem } from "@/components/access/AccessItem";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";

const STATUS: Record<LoanStatus, { label: string; variant: "muted" | "secondary" | "success" | "destructive" }> = {
  PENDING: { label: "Pending", variant: "secondary" },
  APPROVED: { label: "Approved", variant: "secondary" },
  DISBURSED: { label: "Disbursed", variant: "success" },
  CLOSED: { label: "Closed", variant: "muted" },
  REJECTED: { label: "Rejected", variant: "destructive" },
};

export default function Loans({ me }: { me: Me }) {
  const { rows, state, error, reload } = useCollection<Loan>("loans");
  const { rows: employees } = useCollection<Employee>("employees");
  const { toast } = useToast();
  const confirm = useConfirm();
  const { org } = useOrg();
  const money = (n: number) => formatMoney(n, org.default_currency, currencyDecimals(undefined, org));
  const [requesting, setRequesting] = useState(false);
  useIntent("new-loan", () => setRequesting(true));
  const [repay, setRepay] = useState<Loan | null>(null);
  // Per-card verb busy: "<path>:<verb>" while its request is in flight, so the clicked button spins.
  const [acting, setActing] = useState<string | null>(null);

  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Employee" : "");
  }, [employees]);
  const mine = (l: Loan) => !!l.employee && idOf(l.employee) === me.employee_id;
  const sorted = useMemo(() => [...rows].sort((a, b) => (b.create_time ?? "").localeCompare(a.create_time ?? "")), [rows]);

  // Portfolio summary across the loans the caller can see (server-scoped) - shown as a compact strip above
  // the grid so the page opens on the numbers that matter, not just a wall of cards.
  const summary = useMemo(() => {
    const active = rows.filter((l) => l.status === "DISBURSED");
    return {
      active: active.length,
      outstanding: active.reduce((s, l) => s + (l.outstanding ?? 0), 0),
      pending: rows.filter((l) => l.status === "PENDING").length,
      total: rows.length,
    };
  }, [rows]);

  async function act(l: Loan, verb: string, body?: Record<string, unknown>) {
    const done: Record<string, string> = {
      approve: "Request approved",
      reject: "Request rejected",
      disburse: "Marked disbursed - EMI deductions start with the next payroll run",
      recordRepayment: "Repayment recorded",
    };
    setActing(`${l.path}:${verb}`);
    try { await invoke(`loans/${idOf(l.path)}`, verb, undefined, body); toast({ title: done[verb] ?? "Updated", variant: "success" }); reload(); }
    catch (e) { toast({ title: "Couldn't update the loan", description: (e as Error).message, variant: "destructive" }); }
    finally { setActing(null); }
  }
  async function del(l: Loan) {
    if (!(await confirm({ title: "Delete this loan request?", destructive: true, confirmLabel: "Delete" }))) return;
    try { await remove(`loans/${idOf(l.path)}`); toast({ title: "Request deleted", variant: "success" }); reload(); }
    catch (e) { toast({ title: "Couldn't delete the request", description: (e as Error).message, variant: "destructive" }); }
  }
  // Disbursal starts payroll deductions - worth a beat of confirmation.
  async function disburse(l: Loan) {
    if (!(await confirm({ title: "Mark this loan as disbursed?", description: `EMI of ${l.monthly_amount ? money(l.monthly_amount) : "the agreed amount"} will be deducted from payroll starting with the next run.`, confirmLabel: "Mark disbursed" }))) return;
    act(l, "disburse");
  }

  const requestBtn = (
    <AccessAction collection="loans" create label="Request a loan">
      <Button onClick={() => setRequesting(true)}><Plus className="h-4 w-4" /> Request loan</Button>
    </AccessAction>
  );

  return (
    <div>
      <PageHeader title="Loans & Advances" description="Salary advances and loans for employees." actions={requestBtn} />

      <DataState state={state} error={error} onRetry={reload}>
        {sorted.length === 0 ? (
          <EmptyState illustration="payroll" icon={HandCoins} title="No loans" description="Request a loan or salary advance to get started." action={requestBtn} />
        ) : (
          <>
          <SummaryStrip
            items={[
              { label: "Active", value: summary.active, icon: HandCoins, hint: "currently disbursed" },
              { label: "Outstanding", value: money(summary.outstanding), tone: summary.outstanding > 0 ? "primary" : "success" },
              { label: "Pending", value: summary.pending, icon: Banknote, tone: summary.pending > 0 ? "warning" : "muted", hint: summary.pending > 0 ? "awaiting decision" : "all clear" },
              { label: "Total requests", value: summary.total, tone: "muted" },
            ]}
          />
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {sorted.map((l) => {
              const can = l.access?.can ?? [];
              const pct = l.principal > 0 ? Math.round((l.repaid / l.principal) * 100) : 0;
              return (
                <AccessItem key={l.path} collection="loans" objectPath={l.path} can={l.access?.can} why={l.access?.why} label="Loan">
                <Card className="flex flex-col gap-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold tabular-nums">{money(l.principal)}</span>
                        <Badge variant="muted">{l.kind === "advance" ? "Advance" : "Loan"}</Badge>
                        <Badge variant={STATUS[l.status].variant}>{STATUS[l.status].label}</Badge>
                      </div>
                      {!mine(l) && <p className="text-xs text-muted-foreground">{empName(l.employee)}</p>}
                    </div>
                    {l.status === "PENDING" && can.includes("delete") && mine(l) && (
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => del(l)} aria-label="Delete"><Trash2 className="h-3.5 w-3.5" /></Button>
                    )}
                  </div>
                  {l.reason && <p className="text-sm text-foreground/80">{l.reason}</p>}
                  <div className="space-y-1 text-sm">
                    <div className="flex justify-between"><span className="text-muted-foreground">EMI</span><span className="tabular-nums">{l.monthly_amount ? `${money(l.monthly_amount)}/mo · ` : ""}{l.installments} month{l.installments === 1 ? "" : "s"}</span></div>
                    {(l.status === "DISBURSED" || l.status === "CLOSED") && (
                      <>
                        {/* Outstanding is THE number the borrower cares about - lead with it. */}
                        <div className="flex items-baseline justify-between"><span className="text-muted-foreground">Outstanding</span><span className={cn("text-base font-semibold tabular-nums", l.outstanding === 0 && "text-success")}>{money(l.outstanding)}</span></div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} /></div>
                        <div className="flex justify-between text-xs text-muted-foreground"><span>Repaid {money(l.repaid)} of {money(l.principal)}</span><span className="tabular-nums">{pct}%</span></div>
                      </>
                    )}
                  </div>
                  <div className="mt-auto flex flex-wrap gap-2">
                    {l.status === "PENDING" && can.includes("approve") && <AccessAction verb="approve" can={can} label="Approve loan"><Button size="sm" loading={acting === `${l.path}:approve`} onClick={() => act(l, "approve")}><Check className="h-3.5 w-3.5" /> Approve</Button></AccessAction>}
                    {l.status === "PENDING" && can.includes("reject") && <AccessAction verb="reject" can={can} label="Reject loan"><Button size="sm" variant="outline" loading={acting === `${l.path}:reject`} onClick={() => act(l, "reject")}><X className="h-3.5 w-3.5" /> Reject</Button></AccessAction>}
                    {l.status === "APPROVED" && can.includes("disburse") && <AccessAction verb="disburse" can={can} label="Disburse loan"><Button size="sm" loading={acting === `${l.path}:disburse`} onClick={() => disburse(l)}><Banknote className="h-3.5 w-3.5" /> Mark disbursed</Button></AccessAction>}
                    {l.status === "DISBURSED" && can.includes("recordRepayment") && <AccessAction verb="recordRepayment" can={can} label="Record loan repayment"><Button size="sm" variant="outline" onClick={() => setRepay(l)}>Record repayment</Button></AccessAction>}
                  </div>
                </Card>
                </AccessItem>
              );
            })}
          </div>
          </>
        )}
      </DataState>

      {requesting && <RequestDialog onClose={() => setRequesting(false)} onCreated={() => { setRequesting(false); reload(); }} toastErr={(m) => toast({ title: "Couldn't request", description: m, variant: "destructive" })} />}
      {repay && <RepayDialog loan={repay} onClose={() => setRepay(null)} onSave={async (amount) => { await act(repay, "recordRepayment", { amount }); setRepay(null); }} />}
    </div>
  );
}

// Self-service only: a loan/advance is always requested for the signed-in employee, so there is no "For"
// picker. The server forces it too (`employee` is readOnly on the wire), this just keeps the form honest.
function RequestDialog({ onClose, onCreated, toastErr }: {
  onClose: () => void;
  onCreated: () => void;
  toastErr: (msg: string) => void;
}) {
  const { org } = useOrg();
  const money = (n: number) => formatMoney(n, org.default_currency, currencyDecimals(undefined, org));
  const [kind, setKind] = useState<"loan" | "advance">("loan");
  const [principal, setPrincipal] = useState("");
  const [installments, setInstallments] = useState("6");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const amount = Number(principal);
  const valid = amount > 0 && Number(installments) >= 1;

  async function submit() {
    setBusy(true);
    try {
      await create("loans", { kind, principal: amount, installments: Number(installments), reason: reason.trim() || undefined });
      onCreated();
    } catch (e) { toastErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent onEnterSubmit={() => { if (!busy && valid) submit(); }}>
        <DialogHeader><DialogTitle>Request a loan or advance</DialogTitle></DialogHeader>
        <Field label="Type">
          <div className="flex gap-2">
            <Button type="button" size="sm" variant={kind === "loan" ? "default" : "outline"} onClick={() => setKind("loan")}>Loan</Button>
            <Button type="button" size="sm" variant={kind === "advance" ? "default" : "outline"} onClick={() => setKind("advance")}>Salary advance</Button>
          </div>
        </Field>
        <FieldRow>
          <Field label="Amount" error={principal !== "" && Number(principal) <= 0 ? "Enter an amount greater than 0." : undefined}><Input type="number" min={0} value={principal} onChange={(e) => setPrincipal(e.target.value)} autoFocus /></Field>
          <Field label="Installments (months)" error={installments !== "" && Number(installments) < 1 ? "At least 1 month." : undefined}><Input type="number" min={1} value={installments} onChange={(e) => setInstallments(e.target.value)} /></Field>
        </FieldRow>
        {valid && <p className="text-xs text-muted-foreground">EMI ≈ {money(Math.round((amount / Number(installments)) * 100) / 100)}/month, deducted from payroll after disbursal.</p>}
        <Field label="Reason (optional)"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={busy} disabled={!valid}>Request</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RepayDialog({ loan, onClose, onSave }: { loan: Loan; onClose: () => void; onSave: (amount: number) => Promise<void> }) {
  const { org } = useOrg();
  const money = (n: number) => formatMoney(n, org.default_currency, currencyDecimals(undefined, org));
  // Suggest one EMI, capped at what's actually left.
  const suggested = Math.min(loan.monthly_amount ?? 0, loan.outstanding);
  const [amount, setAmount] = useState(suggested > 0 ? String(suggested) : "");
  const [busy, setBusy] = useState(false);
  const n = Number(amount);
  const valid = n > 0 && n <= loan.outstanding + 0.001;
  async function doSave() {
    setBusy(true);
    try { await onSave(n); } finally { setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent onEnterSubmit={() => { if (valid && !busy) doSave(); }}>
        <DialogHeader><DialogTitle>Record repayment</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">Outstanding <span className="font-medium tabular-nums text-foreground">{money(loan.outstanding)}</span>. Record only payments made outside payroll here.</p>
        <Field label="Amount" error={amount !== "" && !valid ? `Enter an amount between 0 and ${money(loan.outstanding)}.` : undefined}><Input type="number" min={0} max={loan.outstanding} value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus /></Field>
        <ActivitySection resource={loan.path} className="border-t pt-3" />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={doSave} loading={busy} disabled={!valid}>Record repayment</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
