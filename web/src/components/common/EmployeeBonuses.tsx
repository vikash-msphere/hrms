import { useEffect, useState } from "react";
import { Gift, Plus } from "lucide-react";
import { get, create } from "@/api";
import { formatMoney } from "@/lib/utils";
import { useOrg, currencyDecimals } from "@/lib/org";
import type { Bonus } from "@/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/common/Field";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

const todayYmd = () => new Date().toISOString().slice(0, 10);
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

  async function load() {
    try {
      const r = await get<{ results: Bonus[] }>(`bonuses?employee=${encodeURIComponent("employees/" + employeeId)}`);
      setRows(r.results ?? []);
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't load awards", description: (e as Error).message });
    } finally {
      setLoaded(true);
    }
  }
  useEffect(() => {
    void load();
  }, [employeeId]);

  async function record() {
    setBusy(true);
    try {
      await create("bonuses", {
        employee: "employees/" + employeeId,
        amount: Math.round(Number(form.amount) * 100) / 100,
        kind: form.kind.trim() || null,
        award_date: form.award_date,
        reason: form.reason.trim() || null,
      });
      toast({ title: "Award recorded" });
      setOpen(false);
      setForm({ amount: "", kind: "", award_date: todayYmd(), reason: "" });
      await load();
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't record award", description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">
          <AccessAction collection="bonuses" label="Bonuses & incentives">
            <span className="flex items-center gap-2"><Gift className="h-4 w-4 text-primary" /> Bonuses & incentives</span>
          </AccessAction>
        </CardTitle>
        {canEdit && (
          <AccessAction collection="bonuses" create label="Record bonus">
            <Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Record bonus</Button>
          </AccessAction>
        )}
      </CardHeader>
      <CardContent>
        {!loaded ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No awards on record.{canEdit ? " Use Record bonus to add one." : ""}</p>
        ) : (
          <table className="w-full text-sm">
            <thead><tr className="border-b text-left text-muted-foreground"><th className="py-2 pr-3 font-medium">Date</th><th className="py-2 pr-3 font-medium">Type</th><th className="py-2 pr-3 font-medium">Amount</th><th className="py-2 font-medium">Reason</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.path} className="border-b last:border-0">
                  <td className="py-1.5 pr-3 font-medium">{r.award_date}</td>
                  <td className="py-1.5 pr-3">{r.kind ?? "Bonus"}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{money(r.amount, r.currency_code)}</td>
                  <td className="py-1.5 text-muted-foreground">{r.reason ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onEnterSubmit={() => { if (!busy && form.amount && Number(form.amount) > 0 && form.award_date) record(); }}>
          <DialogHeader><DialogTitle>Record bonus / incentive</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">Record a one-off award. It's paid out through payroll.</p>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Amount"><Input type="number" min={1} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} autoFocus /></Field>
            <Field label="Award date"><Input type="date" value={form.award_date} onChange={(e) => setForm({ ...form, award_date: e.target.value })} /></Field>
          </div>
          <Field label="Type">
            <Input list="bonus-kinds" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} placeholder="e.g. Performance Bonus" />
            <datalist id="bonus-kinds">{KINDS.map((k) => <option key={k} value={k} />)}</datalist>
          </Field>
          <Field label="Reason (optional)" hint="Cited in the letter, e.g. exceptional delivery on the Q2 launch."><Input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={record} loading={busy} disabled={!form.amount || Number(form.amount) <= 0 || !form.award_date}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
