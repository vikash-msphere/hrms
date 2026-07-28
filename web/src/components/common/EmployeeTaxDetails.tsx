import { useEffect, useState } from "react";
import { CalendarClock, Landmark, Pencil, ShieldCheck } from "lucide-react";
import { get, patch } from "@/api";
import type { TaxDetails } from "@/types";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/common/Field";
import { AccessAction } from "@/components/access/AccessAction";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { useOrg } from "@/lib/org";

const inr = (n?: number | null) => (n == null ? "-" : `₹${Math.round(n).toLocaleString("en-IN")}`);

/** Per-employee India income-tax (TDS) projection for the financial year. Tax is computed server-side from
 *  compensation + declarations; only prior-employer income/TDS (mid-year joiners) is editable here.
 *  Access: owner, HR, payroll, super_admin. */
export function EmployeeTaxDetails({ employeeId, canEdit, canVerify = false }: { employeeId: string; canEdit: boolean; canVerify?: boolean }) {
  const { toast } = useToast();
  const { org } = useOrg();
  const [data, setData] = useState<TaxDetails | null>(null);
  const [denied, setDenied] = useState(false);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<{ prior_employer_income: string; prior_employer_tds: string }>({ prior_employer_income: "", prior_employer_tds: "" });
  const [saving, setSaving] = useState(false);
  const [deciding, setDeciding] = useState(false);

  async function load() {
    try {
      setData(await get<TaxDetails>(`employees/${employeeId}/tax`));
    } catch (e) {
      if ((e as { status?: number }).status === 403) setDenied(true);
    }
  }
  useEffect(() => {
    load();
  }, [employeeId]);

  function openEdit() {
    setForm({
      prior_employer_income: data?.prior_employer_income ? String(data.prior_employer_income) : "",
      prior_employer_tds: data?.prior_employer_tds ? String(data.prior_employer_tds) : "",
    });
    setOpen(true);
  }

  async function save() {
    setSaving(true);
    try {
      const values = {
        prior_employer_income: form.prior_employer_income ? Number(form.prior_employer_income) : 0,
        prior_employer_tds: form.prior_employer_tds ? Number(form.prior_employer_tds) : 0,
      };
      setData(await patch<TaxDetails>(`employees/${employeeId}/tax`, { values }));
      toast({ title: "Tax declarations saved", description: "Awaiting HR/payroll verification before they affect withholding.", variant: "success" });
      setOpen(false);
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  // HR/payroll verify or reject the declared figures (maker-checker: the server rejects verifying your own).
  async function decide(action: "verify" | "reject") {
    setDeciding(true);
    try {
      setData(await patch<TaxDetails>(`employees/${employeeId}/tax`, { values: { action } }));
      toast({ title: action === "verify" ? "Previous employer details verified" : "Declaration rejected", variant: "success" });
    } catch (e) {
      toast({ title: "Couldn't update", description: (e as Error).message, variant: "destructive" });
    } finally {
      setDeciding(false);
    }
  }

  if (denied || !data) return null;
  const d = data;
  const status = d.verification_status ?? null;
  const verified = status === "VERIFIED";
  // Only VERIFIED prior-employer TDS counts toward collection (the server projects verified-only); declared-
  // but-unverified figures don't move the bar. Capped because over-deduction can exceed the year's tax.
  const priorTdsCounted = d.prior_employer_tds_effective ?? 0;
  const priorIncomeCounted = d.prior_employer_income_effective ?? 0;
  const collected = d.deducted_so_far + priorTdsCounted;
  const pct = d.total_tax > 0 ? Math.min(100, Math.round((collected / d.total_tax) * 100)) : 0;
  const yearDone = d.total_tax > 0 && collected >= d.total_tax;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">
          <AccessAction collection="employees" objectPath={`employees/${employeeId}`} field="tax" label="Tax">
            <span className="flex items-center gap-2">
              <Landmark className="h-4 w-4 text-primary" /> Income tax (TDS)
            </span>
          </AccessAction>
        </CardTitle>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{d.regime_label}</Badge>
          <Badge variant="outline">FY {d.financial_year}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {!d.tds_configured && (
          <p className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
            This is a projection - TDS is not being deducted yet. Add an "Income tax" deduction in Settings → Pay components to start withholding.
          </p>
        )}

        {/* Hero: the number that hits the payslip, plus how far through the year's tax we are. */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border bg-muted/30 p-4">
            <p className="text-xs text-muted-foreground">Monthly TDS on the payslip</p>
            <p className="mt-1 text-3xl font-bold tabular-nums text-primary">
              {inr(d.monthly_tds)}<span className="text-sm font-medium text-muted-foreground">/month</span>
            </p>
            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <CalendarClock className="h-3.5 w-3.5" />
              {d.remaining_months > 0
                ? `Balance spread over the ${d.remaining_months} month${d.remaining_months === 1 ? "" : "s"} left in FY ${d.financial_year}`
                : `No months left in FY ${d.financial_year}`}
            </p>
          </div>
          <div className="rounded-lg border p-4">
            <div className="flex items-baseline justify-between">
              <p className="text-xs text-muted-foreground">Collected so far</p>
              <p className="text-xs tabular-nums text-muted-foreground">{pct}%</p>
            </div>
            <p className="mt-1 text-lg font-semibold tabular-nums">
              {inr(collected)} <span className="text-sm font-normal text-muted-foreground">of {inr(d.total_tax)}</span>
            </p>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
              <div className={cn("h-full rounded-full transition-all", yearDone ? "bg-emerald-500" : "bg-primary")} style={{ width: `${pct}%` }} />
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {priorTdsCounted ? <>{inr(priorTdsCounted)} at a previous employer · {inr(d.deducted_so_far)} at {org.name}</> : <>Deducted at {org.name} this financial year</>}
            </p>
          </div>
        </div>

        <div className="grid gap-x-8 gap-y-5 lg:grid-cols-2">
          {/* Left: how the year's tax is computed. */}
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Year's tax computation</p>
            <dl className="space-y-1.5 text-sm">
              <Row label="Projected income for the year" value={inr(d.annual_gross)} />
              {priorIncomeCounted ? <Row label={`Includes ${inr(priorIncomeCounted)} from a previous employer`} value="" muted /> : null}
              <Row label="Standard deduction" value={`− ${inr(d.standard_deduction)}`} muted />
              <Row label="Taxable income" value={inr(d.taxable_income)} strong />
              <div className="my-2 border-t" />
              {d.slabs.map((s) => (
                <Row key={`${s.from}`} label={`${inr(s.from)}${s.to ? ` – ${inr(s.to)}` : " and above"} @ ${s.rate}%`} value={inr(s.amount)} muted />
              ))}
              {d.rebate ? <Row label="Rebate u/s 87A" value={`− ${inr(d.rebate)}`} muted /> : null}
              {d.surcharge ? <Row label="Surcharge" value={inr(d.surcharge)} muted /> : null}
              <Row label="Health & education cess (4%)" value={inr(d.cess)} muted />
              <div className="mt-1 flex items-center justify-between border-t pt-2">
                <dt className="font-semibold">Total tax for the year</dt>
                <dd className="text-lg font-bold tabular-nums">{inr(d.total_tax)}</dd>
              </div>
            </dl>
          </div>

          {/* Right: how it's being collected month by month. */}
          <div className="flex flex-col">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Collection schedule</p>
            <dl className="space-y-1.5 text-sm">
              <Row label="Total tax for the year" value={inr(d.total_tax)} />
              {priorTdsCounted ? <Row label="Deducted at a previous employer" value={`− ${inr(priorTdsCounted)}`} muted /> : null}
              <Row label={`Deducted so far at ${org.name}`} value={`− ${inr(d.deducted_so_far)}`} muted />
              <Row label="Still to collect" value={inr(Math.max(0, d.total_tax - collected))} strong />
              <div className="my-2 border-t" />
              <Row label={`Months left in the financial year`} value={String(d.remaining_months)} />
              <div className="mt-1 flex items-center justify-between border-t pt-2">
                <dt className="font-semibold">Per month</dt>
                <dd className="text-lg font-bold tabular-nums text-primary">{inr(d.monthly_tds)}</dd>
              </div>
            </dl>
            {/* Mid-year joiners: prior-employer declarations change both the projection and the spread, but only
                once HR/payroll VERIFY them - a declared-but-unverified figure doesn't affect withholding. */}
            <div className="mt-4 space-y-2 rounded-md border bg-muted/30 px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">Joined mid-year?</span> Declare income &amp; TDS from a previous employer so the projection stays accurate. HR/payroll verify them before they affect withholding.
                </div>
                {canEdit && (
                  <Button size="sm" variant="outline" className="shrink-0" onClick={openEdit}>
                    <Pencil className="h-3.5 w-3.5" /> {d.on_file ? "Edit" : "Declare"}
                  </Button>
                )}
              </div>
              {d.on_file && (
                <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-xs">
                  <div className="flex items-center gap-2">
                    <StatusBadge status={status} />
                    <span className="text-muted-foreground">
                      Declared {inr(d.prior_employer_income)} income · {inr(d.prior_employer_tds)} TDS
                      {verified && (d.verified_income !== d.prior_employer_income || d.verified_tds !== d.prior_employer_tds)
                        ? ` · accepted ${inr(d.verified_income)} / ${inr(d.verified_tds)}`
                        : ""}
                    </span>
                  </div>
                  {canVerify && (
                    <div className="flex items-center gap-1.5">
                      {status !== "VERIFIED" && (
                        <Button size="sm" variant="outline" className="h-7" loading={deciding} onClick={() => decide("verify")}>
                          <ShieldCheck className="h-3.5 w-3.5" /> Verify
                        </Button>
                      )}
                      {status !== "REJECTED" && (
                        <Button size="sm" variant="ghost" className="h-7 text-destructive" disabled={deciding} onClick={() => decide("reject")}>
                          {status === "VERIFIED" ? "Revoke" : "Reject"}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onEnterSubmit={() => { if (!saving) save(); }}>
          <DialogHeader>
            <DialogTitle>Income from a previous employer (this financial year)</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">If you joined mid-year, declare the income earned and TDS already deducted at a previous employer so the projection and monthly TDS are accurate.</p>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Gross income (₹)">
              <Input type="number" min={0} value={form.prior_employer_income} onChange={(e) => setForm({ ...form, prior_employer_income: e.target.value })} />
            </Field>
            <Field label="TDS deducted (₹)">
              <Input type="number" min={0} value={form.prior_employer_tds} onChange={(e) => setForm({ ...form, prior_employer_tds: e.target.value })} />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={save} loading={saving}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// Verification state of the prior-employer declaration. Only VERIFIED figures affect withholding.
function StatusBadge({ status }: { status: "DECLARED" | "VERIFIED" | "REJECTED" | null }) {
  if (status === "VERIFIED") return <Badge className="bg-emerald-600 hover:bg-emerald-600">Verified</Badge>;
  if (status === "REJECTED") return <Badge variant="destructive">Rejected</Badge>;
  return <Badge variant="secondary">Awaiting verification</Badge>;
}

function Row({ label, value, strong, muted }: { label: string; value: string; strong?: boolean; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className={muted ? "text-muted-foreground" : ""}>{label}</dt>
      <dd className={cn("tabular-nums", strong ? "font-semibold" : muted ? "text-muted-foreground" : "font-medium")}>{value}</dd>
    </div>
  );
}
