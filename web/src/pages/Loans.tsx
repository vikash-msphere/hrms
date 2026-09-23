import { useMemo, useState } from "react";
import { HandCoins, Plus, Check, X, Banknote, Trash2 } from "lucide-react";
import { create, invoke, remove, type ApiError } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { cn, formatMoney, idOf, round2 } from "@/lib/utils";
import { thisMonthStr } from "@/lib/orgDay";
import { useOrg, currencyDecimals } from "@/lib/org";
import type { Employee, Loan, LoanStatus, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { useIntent } from "@/lib/intent";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { TruncationNotice } from "@/components/common/TruncationNotice";
import { useKpiFocus } from "@/lib/kpiFocus";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { Field, FieldRow } from "@/components/common/Field";
import { FormError } from "@/components/common/FormError";
import { MoneyInput } from "@/components/common/MoneyInput";
import { useDialogGuard } from "@/components/common/dialogGuard";
import { AccessScope } from "@/components/access/AccessScope";
import { ActivitySection } from "@/components/common/ActivitySection";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
  const { rows: employees } = useCollection<Employee>("employees", { all: true });
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
      // Decided but the money hasn't moved: the finance queue, invisible in a "pending" count.
      toDisburse: rows.filter((l) => l.status === "APPROVED").length,
      // What the caller can act on right now, not merely what is outstanding somewhere.
      awaitingMe: rows.filter((l) => l.status === "PENDING" && (l.access?.can ?? []).some((v) => v === "approve" || v === "reject")).length,
      mineOutstanding: rows.filter((l) => mine(l) && l.status === "DISBURSED").reduce((s, l) => s + (l.outstanding ?? 0), 0),
      mineCount: rows.filter((l) => mine(l) && l.status === "DISBURSED").length,
    };
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  // Each metric narrows the card grid to the loans it counted. The key IS the selection, so every metric gets
  // its own even where two count the same loans - sharing one would light both segments off a single click.
  const kf = useKpiFocus<Loan, "active" | "outstanding" | "pending" | "toDisburse" | "awaitingMe" | "mine">({
    active: { label: "active loans", match: (l) => l.status === "DISBURSED" },
    outstanding: { label: "loans still to recover", match: (l) => l.status === "DISBURSED" && (l.outstanding ?? 0) > 0 },
    pending: { label: "pending requests", match: (l) => l.status === "PENDING" },
    toDisburse: { label: "loans awaiting disbursal", match: (l) => l.status === "APPROVED" },
    awaitingMe: { label: "requests awaiting your decision", match: (l) => l.status === "PENDING" && (l.access?.can ?? []).some((v) => v === "approve" || v === "reject") },
    mine: { label: "loans of your own", match: (l) => mine(l) && l.status === "DISBURSED" },
  });
  const shown = useMemo(() => kf.apply(sorted), [sorted, kf.focus]); // eslint-disable-line react-hooks/exhaustive-deps

  // `rethrow` is for callers inside a dialog: the reason belongs in the form, and the dialog must stay open on
  // a failure rather than closing over a toast nobody read.
  async function act(l: Loan, verb: string, body?: Record<string, unknown>, rethrow = false) {
    const done: Record<string, string> = {
      approve: "Request approved",
      reject: "Request rejected",
      disburse: "Marked disbursed - EMI deductions start with the next payroll run",
      recordRepayment: "Repayment recorded",
    };
    setActing(`${l.path}:${verb}`);
    // The row's etag rides along so a decision is refused if the loan changed since it was shown here (a
    // borrower raising the principal while the approver reads the old figure).
    try { await invoke(`loans/${idOf(l.path)}`, verb, l.etag, body); toast({ title: done[verb] ?? "Updated", variant: "success" }); reload(); }
    catch (e) {
      if (rethrow) throw e;
      toast({ title: "Couldn't update the loan", description: (e as Error).message, variant: "destructive" });
    }
    finally { setActing(null); }
  }
  async function del(l: Loan) {
    if (!(await confirm({ title: "Delete this loan request?", destructive: true, confirmLabel: "Delete" }))) return;
    try { await remove(`loans/${idOf(l.path)}`); toast({ title: "Request deleted", variant: "success" }); reload(); }
    catch (e) { toast({ title: "Couldn't delete the request", description: (e as Error).message, variant: "destructive" }); }
  }
  // The server refuses a manual repayment identical to one recorded moments ago, because from the request
  // alone a double-click and a second, separate payment of the same amount look the same - and it used to
  // guess "double-click", answer 200, and record nothing. Only the person at the keyboard knows which it is,
  // so the refusal comes back here as a question. Confirming resends it with `allow_duplicate`.
  async function recordRepayment(l: Loan, amount: number) {
    try {
      await act(l, "recordRepayment", { amount }, true);
    } catch (e) {
      if (!((e as ApiError).problem?.type === "/errors/already-exists")) throw e;
      const again = await confirm({
        title: "Record this repayment again?",
        description: `A repayment of ${money(amount)} was recorded on this loan moments ago. Record another one only if the employee really paid twice - otherwise cancel, the first one already counted.`,
        confirmLabel: "Record anyway",
      });
      if (!again) return;
      await act(l, "recordRepayment", { amount, allow_duplicate: true }, true);
    }
  }
  // Disbursal starts payroll deductions - worth a beat of confirmation.
  async function disburse(l: Loan) {
    if (!(await confirm({ title: "Mark this loan as disbursed?", description: `EMI of ${l.monthly_amount ? money(l.monthly_amount) : "the agreed amount"} will be deducted from payroll starting with the next run.`, confirmLabel: "Mark disbursed" }))) return;
    void act(l, "disburse");
  }

  const requestBtn = (
    <AccessAction collection="loans" create label="Request a loan">
      <Button onClick={() => setRequesting(true)}><Plus className="h-4 w-4" /> Request loan</Button>
    </AccessAction>
  );

  return (
    <div>
      <PageHeader title="Loans & Advances" description="Salary advances and loans for employees." actions={requestBtn} />
      {/* The strip below sums the LOADED rows, and a list page is a window on the collection. An outstanding
          figure that silently omits everything past the first page is the kind of number somebody quotes. */}
      <TruncationNotice collection="loans" what="loans" className="mb-3" />

      <DataState state={state} error={error} onRetry={reload}>
        {sorted.length === 0 ? (
          <EmptyState illustration="payroll" icon={HandCoins} title="No loans" description="Request a loan or salary advance to get started." action={requestBtn} />
        ) : (
          <>
          <SummaryStrip
            items={[
              { label: "Active", value: summary.active, icon: HandCoins, hint: "currently disbursed", ...kf.kpi("active") },
              { label: "Outstanding", value: money(summary.outstanding), tone: summary.outstanding > 0 ? "primary" : "success", hint: "still to recover", ...kf.kpi("outstanding") },
              ...(summary.awaitingMe
                ? [{ label: "Awaiting your decision", value: summary.awaitingMe, icon: Check, tone: "warning" as const, hint: "yours to approve", ...kf.kpi("awaitingMe") }]
                : []),
              { label: "Pending", value: summary.pending, icon: Banknote, tone: summary.pending > 0 ? "warning" : "muted", hint: summary.pending > 0 ? "awaiting decision" : "all clear", ...kf.kpi("pending") },
              { label: "To disburse", value: summary.toDisburse, tone: summary.toDisburse > 0 ? "warning" : "muted", hint: summary.toDisburse ? "money not sent" : "nothing waiting", ...kf.kpi("toDisburse") },
              ...(summary.mineCount
                ? [{ label: "You owe", value: money(summary.mineOutstanding), hint: `${summary.mineCount} of your own`, tone: "primary" as const, ...kf.kpi("mine") }]
                : []),
              { label: "Total requests", value: summary.total, tone: "muted", hint: "every loan on file", onClick: () => kf.setFocus(null), active: kf.focus === null },
            ]}
          />
          {shown.length === 0 && (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              No {kf.activeLabel ?? "loans"}.{" "}
              <button type="button" className="font-medium text-primary underline-offset-2 hover:underline" onClick={kf.clear}>Show all loans</button>
            </p>
          )}
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {shown.map((l) => {
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

      {requesting && <RequestDialog onClose={() => setRequesting(false)} onCreated={() => { setRequesting(false); reload(); }} />}
      {repay && <RepayDialog loan={repay} onClose={() => setRepay(null)} onSave={async (amount) => { await recordRepayment(repay, amount); setRepay(null); }} />}
    </div>
  );
}

// Self-service only: a loan/advance is always requested for the signed-in employee, so there is no "For"
// picker. The server forces it too (`employee` is readOnly on the wire), this just keeps the form honest.
function RequestDialog({ onClose, onCreated }: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const { org } = useOrg();
  const money = (n: number) => formatMoney(n, org.default_currency, currencyDecimals(undefined, org));
  const [kind, setKind] = useState<"loan" | "advance">("loan");
  const [principal, setPrincipal] = useState("");
  const [installments, setInstallments] = useState("6");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const amount = Number(principal);
  const valid = amount > 0 && Number(installments) >= 1;
  // Always open (this dialog only exists while requesting), so the guard's baseline is the empty form and any
  // typing counts as work worth protecting.
  const guard = useDialogGuard(true, { kind, principal, installments, reason }, onClose, { label: "request" });
  const months = Number(installments);
  // `round2` (lib/utils), never an inline `Math.round(n * 100) / 100`: the inline form multiplies in float, so
  // a decimal half-case rounds the WRONG way (₹100,050 over 100 months is 1000.5, and `1000.5 * 100` is
  // `100049.99…`). The server derives the deduction with `round2` (src/domain/loans.ts), and this dialog is the
  // single screen that tells a borrower what will come out of their salary each month - the two must agree.
  const emi = valid ? round2(amount / months) : 0;
  // When the recovery ends, in months a borrower can picture: payroll takes one EMI per calendar month from
  // the first run after disbursal, so the schedule is knowable the moment the two numbers are typed. Stepped
  // from the ORG's month, not the viewer's - lib/orgDay exists to give one answer to "what month is it".
  const lastMonth = valid
    ? new Date(Date.UTC(Number(thisMonthStr().slice(0, 4)), Number(thisMonthStr().slice(5, 7)) - 1 + months, 1)).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" })
    : "";

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      await create("loans", { kind, principal: amount, installments: months, reason: reason.trim() || undefined });
      onCreated();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={guard.onOpenChange}>
      <DialogContent scrollBody onEnterSubmit={() => { if (!busy && valid) void submit(); }}>
        <AccessScope collection="loans">
        <DialogHeader>
          <DialogTitle>Request a loan or advance</DialogTitle>
          <DialogDescription>Goes to payroll for approval. Once disbursed, repayment is deducted from your salary automatically - one installment a month.</DialogDescription>
        </DialogHeader>
        <DialogBody>
        <FormError error={err} />
        <Field label="Type" hint={kind === "advance" ? "An advance on pay you'll earn - usually repaid over a month or two." : "A larger amount repaid over a longer schedule."}>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant={kind === "loan" ? "default" : "outline"} onClick={() => setKind("loan")}>Loan</Button>
            <Button type="button" size="sm" variant={kind === "advance" ? "default" : "outline"} onClick={() => setKind("advance")}>Salary advance</Button>
          </div>
        </Field>
        <FieldRow>
          <Field label="Amount" error={principal !== "" && Number(principal) <= 0 ? "Enter an amount greater than 0." : undefined}>
            <MoneyInput value={principal} onChange={setPrincipal} min={0} autoFocus />
          </Field>
          <Field label="Repay over (months)" error={installments !== "" && months < 1 ? "At least 1 month." : undefined}>
            <Input type="number" min={1} value={installments} onChange={(e) => setInstallments(e.target.value)} />
          </Field>
        </FieldRow>
        {/* Most requests are steered by what the monthly bite is, not the headline amount, so the repayment is
            shown as a schedule and the common terms are one tap away. */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Repay over</span>
          {[3, 6, 12, 24].map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setInstallments(String(m))}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-xs transition-colors hover:bg-accent",
                months === m && "border-primary bg-primary/10 text-primary",
              )}
            >
              {m} months
            </button>
          ))}
        </div>
        {valid && (
          <div className="space-y-1 rounded-md border bg-muted/40 px-3 py-2 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Deducted each month</span><span className="font-semibold tabular-nums">{money(emi)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Installments</span><span className="tabular-nums">{months}, ending around {lastMonth}</span></div>
          </div>
        )}
        <Field label="Reason (optional)" hint="Helps whoever approves it decide."><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => guard.onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} loading={busy} disabled={!valid}>Request</Button>
        </DialogFooter>
        </AccessScope>
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
  const [err, setErr] = useState<string | null>(null);
  const n = Number(amount);
  const valid = n > 0 && n <= loan.outstanding + 0.001;
  const remaining = valid ? Math.max(0, Math.round((loan.outstanding - n) * 100) / 100) : loan.outstanding;
  async function doSave() {
    setBusy(true);
    setErr(null);
    try { await onSave(n); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent onEnterSubmit={() => { if (valid && !busy) void doSave(); }}>
        <AccessScope collection="loans" objectPath={loan.path}>
        <DialogHeader>
          <DialogTitle>Record repayment</DialogTitle>
          <DialogDescription>For money paid back outside payroll - a cheque, a transfer, a lump sum. Payroll deductions are recorded on their own as each run is published.</DialogDescription>
        </DialogHeader>
        <FormError error={err} />
        <div className="space-y-1 rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Outstanding now</span><span className="font-medium tabular-nums">{money(loan.outstanding)}</span></div>
          {valid && <div className="flex justify-between"><span className="text-muted-foreground">After this repayment</span><span className="font-semibold tabular-nums">{remaining === 0 ? `${money(0)} · cleared` : money(remaining)}</span></div>}
        </div>
        <Field label="Amount" error={amount !== "" && !valid ? `Enter an amount between 0 and ${money(loan.outstanding)}.` : undefined}>
          <MoneyInput value={amount} onChange={setAmount} min={0} max={loan.outstanding} autoFocus />
        </Field>
        {/* Clearing the balance in one go is the other common case; the exact figure is fiddly to type. */}
        {loan.outstanding > 0 && n !== loan.outstanding && (
          <button type="button" className="self-start text-xs font-medium text-primary hover:underline" onClick={() => setAmount(String(loan.outstanding))}>
            Settle the full {money(loan.outstanding)}
          </button>
        )}
        <ActivitySection resource={loan.path} className="border-t pt-3" />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={doSave} loading={busy} disabled={!valid}>Record repayment</Button>
        </DialogFooter>
        </AccessScope>
      </DialogContent>
    </Dialog>
  );
}
