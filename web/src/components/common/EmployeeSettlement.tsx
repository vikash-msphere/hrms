import { useCallback, useEffect, useState } from "react";
import { Calculator, Plus } from "lucide-react";
import { get, create } from "@/api";
import { formatMoney } from "@/lib/utils";
import { todayStr as todayYmd } from "@/lib/orgDay";
import { useOrg, currencyDecimals } from "@/lib/org";
import type { Settlement } from "@/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Input } from "@/components/ui/input";
import { Field, FieldRow } from "@/components/common/Field";
import { DetailSkeleton } from "@/components/common/Skeletons";
import { FormError } from "@/components/common/FormError";
import { useDialogGuard } from "@/components/common/dialogGuard";
import { AccessScope } from "@/components/access/AccessScope";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";


// Full & final settlement (FnF): compute a snapshot at exit + view the breakdown. The FnF letter renders the
// most recent snapshot. HR + super only (gated by the caller).
export function EmployeeSettlement({ employeeId, canEdit }: { employeeId: string; canEdit: boolean }) {
  const { toast } = useToast();
  const { org } = useOrg();
  const [latest, setLatest] = useState<Settlement | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ settlement_date: todayYmd(), leave_days: "", notice_shortfall_days: "0" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const guard = useDialogGuard(open, form, () => setOpen(false), { label: "settlement inputs" });
  const money = (n: number) => formatMoney(n, latest?.currency_code || org.default_currency, currencyDecimals(latest?.currency_code, org));

  // The loader is the effect's dependency (see the note in EmployeeBankDetails).
  const load = useCallback(async () => {
    try {
      // One row is all this panel shows, and the list is ordered by settlement date descending
      // (services/settlements.ts), so ask for one rather than letting the server's default of 50 apply to a
      // read whose other 49 rows are dropped on the floor.
      const r = await get<{ results: Settlement[] }>(`settlements?employee=${encodeURIComponent("employees/" + employeeId)}&max_page_size=1`);
      setLatest(r.results?.[0] ?? null);
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't load settlement", description: (e as Error).message });
    } finally {
      setLoaded(true);
    }
  }, [employeeId, toast]);
  useEffect(() => {
    void load();
  }, [load]);

  async function compute() {
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = { employee: "employees/" + employeeId, notice_shortfall_days: Number(form.notice_shortfall_days) || 0 };
      if (form.settlement_date) body.settlement_date = form.settlement_date;
      if (form.leave_days.trim() !== "") body.leave_days = Number(form.leave_days);
      await create("settlements", body);
      toast({ title: "Settlement computed" });
      setOpen(false);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="sentry-mask">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">
          <AccessAction collection="settlements" label="Full & final settlement">
            <span className="flex items-center gap-2"><Calculator className="h-4 w-4 text-primary" /> Full & final settlement</span>
          </AccessAction>
        </CardTitle>
        {canEdit && (
          <AccessAction collection="settlements" create label="Compute settlement">
            <Button size="sm" onClick={() => { setForm({ settlement_date: todayYmd(), leave_days: "", notice_shortfall_days: "0" }); setErr(null); setOpen(true); }}><Plus className="h-4 w-4" /> {latest ? "Recompute" : "Compute"}</Button>
          </AccessAction>
        )}
      </CardHeader>
      <CardContent>
        {!loaded ? (
          <DetailSkeleton rows={6} />
        ) : !latest ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No settlement computed.{canEdit ? " Use Compute to generate the FnF for this employee." : ""}</p>
        ) : (
          <>
            <p className="mb-3 text-xs text-muted-foreground">As of {latest.settlement_date}</p>
            {/* Two columns, but a settlement line name ("Less: notice period recovery") plus its amount can
                still outgrow a narrow phone; the wrapper keeps that overflow local to the table. */}
            <div className="scroll-shadow-x [--scroll-ground:hsl(var(--card))] overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {latest.lines.map((l, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="py-1.5 pr-3">
                      {l.kind === "deduction" ? `Less: ${l.name}` : l.name}
                      {/* A partly exempt earning (gratuity u/s 10(10), exit leave encashment u/s 10(10AA)) says how
                          much of it is chargeable, since that is what the withholding below is computed on. */}
                      {l.kind === "earning" && l.taxable != null && l.taxable < l.amount && (
                        <span className="ml-1 text-xs text-muted-foreground">{l.taxable > 0 ? `(${money(l.taxable)} taxable)` : "(exempt)"}</span>
                      )}
                    </td>
                    <td className={`py-1.5 text-right tabular-nums ${l.kind === "deduction" ? "text-destructive" : ""}`}>{l.kind === "deduction" ? `-${money(l.amount)}` : money(l.amount)}</td>
                  </tr>
                ))}
                <tr className="border-t-2">
                  <td className="py-2 font-semibold">Net settlement payable</td>
                  <td className="py-2 text-right font-semibold tabular-nums">{money(latest.net)}</td>
                </tr>
              </tbody>
            </table>
            </div>
            {/* The exit payout withholds income tax like a payroll run: state the chargeable base + the tax on it,
                because this is also what the employee's Form 16 will report for the year. */}
            {latest.tds != null && latest.tds > 0 && (
              <p className="mt-3 text-xs text-muted-foreground">Income tax withheld: {money(latest.tds)} on {money(latest.taxable_earnings ?? 0)} of chargeable pay (the balance of the year's liability - there is no later payroll to collect it in).</p>
            )}
          </>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={guard.onOpenChange}>
        {/* scrollBody: a six-field form under a four-line description, so on a phone Compute was below the
            fold of its own dialog. */}
        <DialogContent className="sentry-mask" scrollBody onEnterSubmit={() => { if (!busy) void compute(); }}>
          <AccessScope collection="settlements">
          <DialogHeader>
            <DialogTitle>{latest ? "Recompute full & final settlement" : "Compute full & final settlement"}</DialogTitle>
            <DialogDescription>
              Collects everything still owed either way - final salary, leave encashment, pending bonuses and reimbursements, less any outstanding loan and unserved notice - and withholds tax on the balance.
              {latest ? " Recomputing replaces the current snapshot; a settlement already paid out is left alone." : " It's a snapshot you can recompute until it's paid."}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
          <FormError error={err} />
          <FieldRow>
            <Field label="Settlement date" hint="Defaults to the employee's end date."><Input type="date" value={form.settlement_date} onChange={(e) => setForm({ ...form, settlement_date: e.target.value })} autoFocus /></Field>
            <Field
              label="Notice shortfall (days)"
              hint={Number(form.notice_shortfall_days) > 0 ? "Recovered from the payout at their daily rate." : "Days of notice not served."}
            >
              <Input type="number" min={0} value={form.notice_shortfall_days} onChange={(e) => setForm({ ...form, notice_shortfall_days: e.target.value })} />
            </Field>
          </FieldRow>
          <Field label="Encashable leave (days)" hint="Blank uses their leave balance as it stands on the settlement date."><Input type="number" min={0} value={form.leave_days} onChange={(e) => setForm({ ...form, leave_days: e.target.value })} placeholder="Leave balance" /></Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => guard.onOpenChange(false)}>Cancel</Button>
            <Button onClick={compute} loading={busy}>{latest ? "Recompute" : "Compute"}</Button>
          </DialogFooter>
          </AccessScope>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
