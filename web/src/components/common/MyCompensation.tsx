import { useEffect, useMemo, useState } from "react";
import { TrendingUp, Building2, ArrowUpRight, ArrowDownRight, ReceiptText } from "lucide-react";
import { getAllPages } from "@/api";
import { navigate } from "@/router";
import { formatMoney, cn } from "@/lib/utils";
import { useOrg, currencyDecimals } from "@/lib/org";
import type { Compensation } from "@/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AccessAction } from "@/components/access/AccessAction";
import { useToast } from "@/components/ui/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { DetailSkeleton } from "@/components/common/Skeletons";

// My own pay, read-only: what I was promised (annual CTC), how it is built up, and how it got here.
//
// Deliberately NOT the HR card (EmployeeCompensation): no revise action, no grade/band/compa-ratio - the
// server withholds those from a self-service read - and no client-side split math, because an employee reads
// neither the salary-structure catalog nor the pay grades. The build-up arrives priced on the resource
// (`breakdown` / `ctc_monthly`, from the same domain function the CTC letter and the payroll run use).
//
// Take-home is deliberately absent: what actually reaches the bank is the payslip's job (LOP, TDS, one-offs
// and mid-month joins all move it), so this card points at Payslips rather than estimating a second answer.
export function MyCompensation({ employeeId }: { employeeId: string }) {
  const { toast } = useToast();
  const { org } = useOrg();
  const [rows, setRows] = useState<Compensation[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Monthly/annual display toggle; CTC is stored annual, the build-up lines carry both.
  const [unit, setUnit] = useState<"monthly" | "annual">("monthly");

  // WALKED TO THE END, not a raw `get()`. A bare list read carries no `max_page_size`, so the server applies
  // its own default of 50 (http/pagination.ts) and the cursor in the response is dropped on the floor. The
  // collection is newest-first, so what a window loses is the OLDEST revisions - the joining salary, which is
  // most of the reason anyone opens a salary history.
  const [cropped, setCropped] = useState(false);
  useEffect(() => {
    let live = true;
    getAllPages<Compensation>(`compensation?employee=${encodeURIComponent("employees/" + employeeId)}`, 200)
      .then((r) => { if (live) { setRows(r.results); setCropped(r.truncated); } })
      .catch((e) => toast({ variant: "destructive", title: "Couldn't load your compensation", description: (e as Error).message }))
      .finally(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, [employeeId, toast]); // `toast` is a module-level function, so naming it changes nothing but the honesty of the array

  const current = rows.find((r) => r.current);
  const cc = current?.currency_code;
  const money = (n: number) => formatMoney(n, cc || org.default_currency, currencyDecimals(cc, org));
  const amountOf = (l: { monthly: number; annual: number }) => (unit === "annual" ? l.annual : l.monthly);
  const inCtc = (current?.breakdown ?? []).filter((l) => !l.above_ctc);
  const aboveCtc = (current?.breakdown ?? []).filter((l) => l.above_ctc);
  const ctcTotal = current ? (unit === "annual" ? current.annual_ctc : current.ctc_monthly ?? current.annual_ctc / 12) : 0;

  // Revision-over-revision change in annual CTC, for the ↑/↓ chips in the history table. The oldest row has
  // no predecessor, so it shows none.
  const deltaByPath = useMemo(() => {
    const sorted = [...rows].sort((a, b) => a.effective_from.localeCompare(b.effective_from));
    const out = new Map<string, number>();
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!.annual_ctc;
      if (prev > 0) out.set(sorted[i]!.path, ((sorted[i]!.annual_ctc - prev) / prev) * 100);
    }
    return out;
  }, [rows]);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">
          <AccessAction collection="compensation" label="Compensation">
            <span className="flex items-center gap-2"><TrendingUp className="h-4 w-4 text-primary" /> My compensation</span>
          </AccessAction>
        </CardTitle>
        <div className="flex gap-0.5 rounded-md border p-0.5">
          <Button size="sm" variant={unit === "monthly" ? "default" : "ghost"} className="h-7" onClick={() => setUnit("monthly")}>Monthly</Button>
          <Button size="sm" variant={unit === "annual" ? "default" : "ghost"} className="h-7" onClick={() => setUnit("annual")}>Annual</Button>
        </div>
      </CardHeader>
      <CardContent>
        {!loaded ? (
          // Shaped like what arrives: the CTC headline block, then the component breakdown under it.
          <>
            <Skeleton className="mb-5 h-24 w-full rounded-lg" />
            <DetailSkeleton rows={5} />
          </>
        ) : !current ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No salary on record yet. Once HR sets it, your CTC and its breakdown appear here.</p>
        ) : (
          <>
            <div className="mb-5 rounded-lg border bg-muted/30 p-4">
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Building2 className="h-3.5 w-3.5" /> Cost to company</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">{money(ctcTotal)}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {unit === "annual" ? "a year" : "a month"} · effective {current.effective_from}
                {current.arrears_amount ? <> · <span className={current.arrears_paid ? "" : "text-warning"}>{current.arrears_paid ? "arrears paid" : `arrears ${money(current.arrears_amount)} pending`}</span></> : null}
              </p>
            </div>

            {/* The build-up: basic + allowances = what payroll pays you, then the employer's contributions
                (PF, ESI, gratuity - whatever your org runs) that make up the rest of the CTC figure above.
                Priced server-side, so this is the same split the payroll run and your CTC letter use. */}
            {inCtc.length > 0 && (
              <div className="mb-5">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">What makes it up ({unit})</p>
                <div className="text-sm">
                  {inCtc.map((l) => (
                    <div key={l.name} className="flex items-center justify-between py-1.5">
                      <span>{l.name}</span>
                      <span className="tabular-nums">{money(amountOf(l))}</span>
                    </div>
                  ))}
                  <div className="mt-1 flex items-baseline justify-between border-t pt-2">
                    <span className="font-semibold">Cost to company</span>
                    <span className="text-lg font-bold tabular-nums">{money(ctcTotal)}</span>
                  </div>
                  {/* Contributions the org keeps outside CTC (typically employer PF under a "CTC + PF" policy):
                      real money spent on you, but not part of the CTC you were promised. */}
                  {aboveCtc.map((l) => (
                    <div key={l.name} className="flex items-center justify-between py-1.5 text-muted-foreground">
                      <span>{l.name} (over &amp; above CTC)</span>
                      <span className="tabular-nums">{money(amountOf(l))}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mb-5 flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/20 px-3 py-2.5 text-sm">
              <span className="text-muted-foreground">This is your contract. What actually reaches your bank each month - after tax, deductions and any leave without pay - is on your payslip.</span>
              <Button size="sm" variant="outline" onClick={() => navigate("payslips")}><ReceiptText className="h-3.5 w-3.5" /> My payslips</Button>
            </div>

            {rows.length > 1 && (
              <>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Salary history</p>
                {cropped && <p className="mb-2 text-xs text-muted-foreground">Showing the most recent revisions - older ones are not loaded here.</p>}
                {/* Four money columns do not fit a phone, and sideways scrolling inside a card is a gesture
                    nobody finds. Below `sm` each revision becomes a short labelled list instead. */}
                <div className="scroll-shadow-x -mx-1 overflow-x-auto px-1 [--scroll-ground:hsl(var(--card))]">
                <table className="table-stack w-full text-sm sm:min-w-[22rem]">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">Effective</th>
                      <th className="py-2 pr-3 font-medium">CTC ({unit})</th>
                      <th className="py-2 pr-3 font-medium">Change</th>
                      <th className="py-2 font-medium">Until</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const delta = deltaByPath.get(r.path);
                      return (
                        <tr key={r.path} className={cn("border-b last:border-0", r.current && "bg-muted/30")}>
                          <td data-label="Effective" className="py-2 pr-3 font-medium">{r.effective_from}</td>
                          {/* The SAME number the headline above uses for the same revision. `annual_ctc` is
                              the target as typed; `ctc_monthly` is what the split could actually reach, and
                              the two are documented not to agree - `CTC_TOL` is one rupee on purpose, because
                              ESI rounds up and the CTC curve climbs in one-rupee steps, so some targets are
                              not attainable at all. Dividing the annual here printed a different salary from
                              the card six inches above it, on the page an employee opens to find out what
                              they are paid. `ctc_monthly` rides only the current row of a single-employee
                              read (src/http/serialize.ts), so the fallback still covers the history. */}
                          <td data-label={`CTC (${unit})`} className="py-2 pr-3 tabular-nums">{money(unit === "annual" ? r.annual_ctc : r.ctc_monthly ?? r.annual_ctc / 12)}</td>
                          <td data-label="Change" className="py-2 pr-3">
                            {delta == null ? <span className="text-muted-foreground">-</span> : (
                              <span className={cn("inline-flex items-center gap-0.5 tabular-nums", delta >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-destructive")}>
                                {delta >= 0 ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
                                {Math.abs(delta).toFixed(1)}%
                              </span>
                            )}
                          </td>
                          <td data-label="Until" className="py-2 text-muted-foreground">{r.current ? <Badge variant="success">current</Badge> : r.effective_to ?? "-"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                </div>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
