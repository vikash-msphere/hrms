import { useCallback, useEffect, useState } from "react";
import { Gift, Plus } from "lucide-react";
import { get, create } from "@/api";
import { formatMoney } from "@/lib/utils";
import { todayStr as todayYmd } from "@/lib/orgDay";
import { useOrg, currencyDecimals } from "@/lib/org";
import type { Bonus } from "@/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Input } from "@/components/ui/input";
import { Field, FieldRow } from "@/components/common/Field";
import { TableSkeleton } from "@/components/common/Skeletons";
import { FormError } from "@/components/common/FormError";
import { MoneyInput } from "@/components/common/MoneyInput";
import { useDialogGuard } from "@/components/common/dialogGuard";
import { AccessScope } from "@/components/access/AccessScope";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

const KINDS = ["Performance Bonus", "Joining Bonus", "Retention Bonus", "Festival Bonus", "Incentive", "Spot Award"];

// One-off awards (bonus/incentive) + a "Record bonus" action. The bonus letter cites the most recent award.
// HR + super only (gated by the caller).
export function EmployeeBonuses({ employeeId, canEdit }: { employeeId: string; canEdit: boolean }) {
  const { toast } = useToast();
  const { org } = useOrg();
  const money = (n: number, cc?: string) => formatMoney(n, cc || org.default_currency, currencyDecimals(cc, org));
  const [rows, setRows] = useState<Bonus[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ amount: "", kind: "", award_date: todayYmd(), reason: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const guard = useDialogGuard(open, form, () => setOpen(false), { label: "award" });
  // Same person, same amount, same day: nearly always a re-submit rather than two genuine awards.
  const duplicate = rows.find((r) => Number(form.amount) > 0 && Math.abs(r.amount - Number(form.amount)) < 0.01 && (r.award_date ?? "").slice(0, 10) === form.award_date);

  // The loader is the effect's dependency (see the note in EmployeeBankDetails): its identity moves with
  // `employeeId`, so the fetch follows the person being viewed instead of the one this mounted with. `toast`
  // is a module-level function, so naming it costs nothing.
  const load = useCallback(async () => {
    try {
      const r = await get<{ results: Bonus[] }>(`bonuses?employee=${encodeURIComponent("employees/" + employeeId)}`);
      setRows(r.results ?? []);
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't load awards", description: (e as Error).message });
    } finally {
      setLoaded(true);
    }
  }, [employeeId, toast]);
  useEffect(() => {
    void load();
  }, [load]);

  async function record() {
    setBusy(true);
    setErr(null);
    try {
      await create("bonuses", {
        employee: "employees/" + employeeId,
        amount: Math.round(Number(form.amount) * 100) / 100,
        kind: form.kind.trim(),
        award_date: form.award_date,
        reason: form.reason.trim(),
      });
      toast({ title: "Award recorded" });
      setOpen(false);
      setForm({ amount: "", kind: "", award_date: todayYmd(), reason: "" });
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
          <AccessAction collection="bonuses" label="Bonuses & incentives">
            <span className="flex items-center gap-2"><Gift className="h-4 w-4 text-primary" /> Bonuses & incentives</span>
          </AccessAction>
        </CardTitle>
        {canEdit && (
          <AccessAction collection="bonuses" create label="Record bonus">
            <Button size="sm" onClick={() => { setErr(null); setOpen(true); }}><Plus className="h-4 w-4" /> Record bonus</Button>
          </AccessAction>
        )}
      </CardHeader>
      <CardContent>
        {!loaded ? (
          <TableSkeleton rows={3} cols={4} />
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No awards on record.{canEdit ? " Use Record bonus to add one." : ""}</p>
        ) : (
          // Stacked into labelled rows below `sm` and a table from there up. Reason is free text and the
          // column that would otherwise force the width, so it gets the flexible remainder and wraps.
          <div className="scroll-shadow-x -mx-1 overflow-x-auto px-1 [--scroll-ground:hsl(var(--card))]">
          <table className="table-stack w-full text-sm sm:min-w-[24rem]">
            <thead><tr className="border-b text-left text-muted-foreground"><th className="py-2 pr-3 font-medium">Date</th><th className="py-2 pr-3 font-medium">Type</th><th className="py-2 pr-3 font-medium">Amount</th><th className="py-2 font-medium">Reason</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.path} className="border-b last:border-0">
                  <td data-label="Date" className="whitespace-nowrap py-1.5 pr-3 font-medium">{r.award_date}</td>
                  <td data-label="Type" className="whitespace-nowrap py-1.5 pr-3">{r.kind ?? "Bonus"}</td>
                  <td data-label="Amount" className="whitespace-nowrap py-1.5 pr-3 tabular-nums">{money(r.amount, r.currency_code)}</td>
                  <td data-label="Reason" className="py-1.5 text-muted-foreground">{r.reason ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={guard.onOpenChange}>
        {/* scrollBody so Save stays on screen: the duplicate-award warning can appear mid-form and push the
            footer off the bottom of a phone. */}
        <DialogContent className="sentry-mask" scrollBody onEnterSubmit={() => { if (!busy && form.amount && Number(form.amount) > 0 && form.award_date) void record(); }}>
          <AccessScope collection="bonuses">
          <DialogHeader>
            <DialogTitle>Record bonus / incentive</DialogTitle>
            <DialogDescription>A one-off award, paid as a taxable earning by the next payroll run covering the award date.</DialogDescription>
          </DialogHeader>
          <DialogBody>
          <FormError error={err} />
          <FieldRow>
            <Field label="Amount"><MoneyInput value={form.amount} onChange={(v) => setForm({ ...form, amount: v })} min={1} autoFocus /></Field>
            <Field label="Award date" hint="Decides which payroll run pays it."><Input type="date" value={form.award_date} onChange={(e) => setForm({ ...form, award_date: e.target.value })} /></Field>
          </FieldRow>
          <Field label="Type">
            <Input list="bonus-kinds" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} placeholder="e.g. Performance Bonus" />
            <datalist id="bonus-kinds">{KINDS.map((k) => <option key={k} value={k} />)}</datalist>
          </Field>
          <Field label="Reason (optional)" hint="Cited in the letter, e.g. exceptional delivery on the Q2 launch."><Input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
          {duplicate && (
            <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
              This employee already has a {money(duplicate.amount, duplicate.currency_code)} award dated {duplicate.award_date}. Saving records a second one.
            </p>
          )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => guard.onOpenChange(false)}>Cancel</Button>
            <Button onClick={record} loading={busy} disabled={!form.amount || Number(form.amount) <= 0 || !form.award_date}>Save</Button>
          </DialogFooter>
          </AccessScope>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
