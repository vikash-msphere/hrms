import { useMemo, useRef, useState } from "react";
import { Download, FileUp, Wallet } from "lucide-react";
import { invoke, remove } from "@/api";
import { cn, formatMonthYear } from "@/lib/utils";
import { exportTable } from "@/lib/exportTable";
import { confirmDecision } from "@/lib/confirmDecision";
import { currentFy, fyOptions, fySpan } from "@/lib/fy";
import { useMoney } from "@/lib/org";
import { parsePayOpenings, payOpeningItems, payOpeningTemplate } from "@/lib/openingImport";
import { useCollection } from "@/hooks/useCollection";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";
import { AccessAction } from "@/components/access/AccessAction";
import { Field } from "@/components/common/Field";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Employee, PayrollOpening } from "@/types";

// Pay and tax already paid this financial year before HRMS ran payroll (services/payrollOpenings.ts
// `importOpenings`), from the old system's sheet. Same three steps as the leave balances beside it: read the
// sheet here, let the server check every row (it alone knows which months HRMS has already paid), then apply
// what the preview showed.

/** Items per call, matching PAYROLL_OPENING_BATCH_MAX on the server. */
const PER_CALL = 100;

type Figures = { paid_through: string; gross: number; taxable_gross: number; tds: number; pt: number; esi_contributing: boolean };
type Result = Partial<Figures> & {
  employee: string;
  financial_year: string;
  previous?: Figures;
  outcome: "created" | "updated" | "unchanged" | "error";
  error?: string;
};
type Answer = { dry_run: boolean; counts: Record<Result["outcome"], number>; results: Result[] };
const OUTCOMES = ["created", "updated", "unchanged", "error"] as const;

const monthOf = (ym?: string) => (ym ? formatMonthYear(`${ym}-01`) : "-");

export function PayOpenings() {
  const { toast } = useToast();
  const confirm = useConfirm();
  const money = useMoney();
  const { rows: employeeRows } = useCollection<Employee>("employees", { all: true });
  const employees = useMemo(() => employeeRows.filter((e) => !e.delete_time), [employeeRows]);
  const nameOf = useMemo(() => new Map(employees.map((e) => [e.path, `${e.first_name} ${e.last_name}`])), [employees]);

  const [fy, setFy] = useState(currentFy());
  const [text, setText] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const parsed = useMemo(() => (text.trim() ? parsePayOpenings(text, employees, fy) : null), [text, employees, fy]);
  const items = useMemo(() => (parsed ? payOpeningItems(parsed) : []), [parsed]);
  const problems = parsed ? parsed.lines.filter((l) => l.errors.length) : [];

  // What is already entered for the year, so it can be read back and a wrong entry taken out without an import.
  const { rows: savedRows, reload: reloadSaved } = useCollection<PayrollOpening>("payroll-openings", { params: { financial_year: fy }, all: true });
  const saved = useMemo(() => savedRows.filter((r) => !r.delete_time), [savedRows]);
  async function removeEntry(r: PayrollOpening) {
    const who = (r.employee && nameOf.get(r.employee)) || "this person";
    const ok = await confirm({
      title: "Remove this pay before HRMS?",
      description: `${who}'s figures for FY ${fy} stop counting toward the year's income tax, professional tax and ESI. A draft run built before now will ask to be rebuilt.`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    try {
      await remove(r.path, r.etag);
      toast({ variant: "success", title: "Removed" });
      reloadSaved();
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't remove it", description: (e as Error).message });
    }
  }

  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  async function run(dryRun: boolean): Promise<Answer> {
    const merged: Answer = { dry_run: dryRun, counts: { created: 0, updated: 0, unchanged: 0, error: 0 }, results: [] };
    for (let i = 0; i < items.length; i += PER_CALL) {
      setProgress(`${Math.min(i + PER_CALL, items.length)} of ${items.length}`);
      const part = await invoke<Answer>("payroll-openings", "importOpenings", undefined, { items: items.slice(i, i + PER_CALL), dry_run: dryRun });
      merged.results.push(...part.results);
      for (const k of OUTCOMES) merged.counts[k] += part.counts[k];
    }
    setProgress(null);
    return merged;
  }

  async function preview() {
    setBusy("preview");
    try {
      setAnswer(await run(true));
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't preview", description: (e as Error).message });
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  const toApply = answer ? answer.counts.created + answer.counts.updated : 0;
  async function apply() {
    if (!answer) return;
    if (!(await confirmDecision(confirm, "applyPayOpenings", `Pay and tax for ${toApply} ${toApply === 1 ? "person" : "people"} in FY ${fy}`))) return;
    setBusy("apply");
    try {
      const done = await run(false);
      setAnswer(done);
      reloadSaved();
      const n = done.counts.created + done.counts.updated;
      toast({
        variant: done.counts.error ? "destructive" : "success",
        title: `Pay and tax brought in for ${n} ${n === 1 ? "person" : "people"}`,
        description: done.counts.error ? `${done.counts.error} could not be applied - see the table.` : undefined,
      });
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't apply", description: (e as Error).message });
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  function downloadTemplate() {
    const { headers, rows } = payOpeningTemplate(employees);
    return exportTable(`pay-before-hrms-${fy}`, headers, rows, "csv", "payroll-openings");
  }

  const applied = answer && !answer.dry_run;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Wallet className="h-4 w-4 text-muted-foreground" /> Pay and tax so far this year
        </CardTitle>
        <CardDescription>
          What each person was paid and had deducted from the start of the financial year up to the last month the system before HRMS
          paid. HRMS works out the year's income tax on the whole year, so without these figures the first HRMS payroll deducts the
          wrong TDS. The months they cover are never paid or taxed again. Re-importing replaces a person's figures.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Financial year" hint={fySpan(fy)} className="w-44">
            <Select value={fy} onValueChange={(v) => { setFy(v); setAnswer(null); }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{fyOptions(1).map((y) => <SelectItem key={y} value={y}>FY {y}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Button variant="outline" size="sm" onClick={downloadTemplate}><Download className="h-4 w-4" /> Download the sheet to fill in</Button>
          <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}><FileUp className="h-4 w-4" /> Upload a CSV</Button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv,text/plain"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) { setText(await f.text()); setAnswer(null); }
            }}
          />
        </div>
        <Textarea
          rows={6}
          className="font-mono text-xs"
          value={text}
          onChange={(e) => { setText(e.target.value); setAnswer(null); }}
          placeholder={"Paste from the spreadsheet, header row first:\nEmployee ID\tName\tPaid through\tGross\tTaxable gross\tTDS\tPT\tESI contributing\nEMP-0001\tAsha Rao\tAug 2026\t250000\t250000\t12000\t1000\tno"}
          aria-label="Pay and tax so far sheet"
        />
        {parsed?.error && <p className="text-sm text-destructive">{parsed.error}</p>}
        {parsed && !parsed.error && (
          <div className="space-y-1 text-xs text-muted-foreground">
            <p>{items.length} of {parsed.lines.length} line{parsed.lines.length === 1 ? "" : "s"} read. A blank amount is zero; a blank taxable gross is the gross.</p>
            {parsed.unknownColumns.length > 0 && <p className="text-warning">Ignored columns: {parsed.unknownColumns.join(", ")}.</p>}
            {problems.length > 0 && (
              <ul className="space-y-0.5 text-destructive">
                {problems.slice(0, 20).map((l) => <li key={l.line}>Line {l.line}{l.name ? ` (${l.name})` : ` (${l.key || "blank"})`}: {l.errors.join(" ")}</li>)}
                {problems.length > 20 && <li>…and {problems.length - 20} more.</li>}
              </ul>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <AccessAction collection="payroll-openings" verb="importOpenings" label="Bring in pay and tax so far">
            <Button variant="outline" loading={busy === "preview"} disabled={!items.length || !!busy} onClick={() => preview()}>Preview</Button>
          </AccessAction>
          {progress && <span className="text-xs text-muted-foreground tabular-nums">{progress}…</span>}
        </div>

        {answer && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="success">{toApply} {applied ? "applied" : "to apply"}</Badge>
              <Badge variant="secondary">{answer.counts.unchanged} unchanged</Badge>
              {answer.counts.error > 0 && <Badge variant="destructive">{answer.counts.error} can't be applied</Badge>}
            </div>
            <div className="max-h-[28rem] overflow-auto rounded-md border px-3 sm:px-0">
              {/* Labelled blocks below `sm`, a table from there up (`.table-stack`). */}
              <table className="table-stack w-full text-sm">
                <thead className="sticky top-0 bg-muted/80 text-left text-xs text-muted-foreground backdrop-blur">
                  <tr>
                    <th className="px-3 py-2 font-medium">Person</th>
                    <th className="px-3 py-2 font-medium">Paid through</th>
                    <th className="px-3 py-2 text-right font-medium">Gross</th>
                    <th className="px-3 py-2 text-right font-medium">Taxable</th>
                    <th className="px-3 py-2 text-right font-medium">TDS</th>
                    <th className="px-3 py-2 text-right font-medium">PT</th>
                    <th className="px-3 py-2 font-medium">ESI</th>
                    <th className="px-3 py-2 font-medium">Result</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {answer.results.map((r, i) => (
                    <tr key={`${r.employee}|${i}`} className={cn(r.outcome === "error" && "bg-destructive/5")}>
                      <td className="px-3 py-2">
                        {nameOf.get(r.employee) ?? r.employee}
                        {r.previous && (
                          <span className="block text-[11px] text-muted-foreground">
                            was {money(r.previous.taxable_gross)} taxable, {money(r.previous.tds)} TDS through {monthOf(r.previous.paid_through)}
                          </span>
                        )}
                      </td>
                      <td data-label="Paid through" className="px-3 py-2 tabular-nums">{monthOf(r.paid_through)}</td>
                      <td data-label="Gross" className="px-3 py-2 text-right tabular-nums">{r.gross == null ? "-" : money(r.gross)}</td>
                      <td data-label="Taxable" className="px-3 py-2 text-right tabular-nums">{r.taxable_gross == null ? "-" : money(r.taxable_gross)}</td>
                      <td data-label="TDS" className="px-3 py-2 text-right tabular-nums">{r.tds == null ? "-" : money(r.tds)}</td>
                      <td data-label="PT" className="px-3 py-2 text-right tabular-nums">{r.pt == null ? "-" : money(r.pt)}</td>
                      <td data-label="ESI" className="px-3 py-2">{r.esi_contributing == null ? "-" : r.esi_contributing ? "Yes" : "No"}</td>
                      <td data-label="Result" className="px-3 py-2">
                        {r.outcome === "error" ? (
                          <span className="text-xs text-destructive">{r.error}</span>
                        ) : (
                          <Badge variant={r.outcome === "unchanged" ? "secondary" : "success"}>
                            {r.outcome === "unchanged" ? "Unchanged" : applied ? "Applied" : r.outcome === "updated" ? "Replaces the entry" : "New"}
                          </Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!applied && toApply > 0 && (
              <div className="flex justify-end">
                <AccessAction collection="payroll-openings" verb="importOpenings" label="Bring in pay and tax so far">
                  <Button loading={busy === "apply"} disabled={!!busy} onClick={() => apply()}>
                    Apply for {toApply} {toApply === 1 ? "person" : "people"}
                  </Button>
                </AccessAction>
              </div>
            )}
          </div>
        )}

        {saved.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">Entered for FY {fy} ({saved.length})</p>
            <div className="max-h-[20rem] overflow-auto rounded-md border px-3 sm:px-0">
              <table className="table-stack w-full text-sm">
                <thead className="sticky top-0 bg-muted/80 text-left text-xs text-muted-foreground backdrop-blur">
                  <tr>
                    <th className="px-3 py-2 font-medium">Person</th>
                    <th className="px-3 py-2 font-medium">Paid through</th>
                    <th className="px-3 py-2 text-right font-medium">Taxable</th>
                    <th className="px-3 py-2 text-right font-medium">TDS</th>
                    <th className="px-3 py-2 text-right font-medium">PT</th>
                    <th className="px-3 py-2 font-medium">ESI</th>
                    <th className="px-3 py-2"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {saved.map((r) => (
                    <tr key={r.path}>
                      <td className="px-3 py-2">{(r.employee && nameOf.get(r.employee)) ?? r.employee}</td>
                      <td data-label="Paid through" className="px-3 py-2 tabular-nums">{monthOf(r.paid_through)}</td>
                      <td data-label="Taxable" className="px-3 py-2 text-right tabular-nums">{money(r.taxable_gross ?? 0)}</td>
                      <td data-label="TDS" className="px-3 py-2 text-right tabular-nums">{money(r.tds ?? 0)}</td>
                      <td data-label="PT" className="px-3 py-2 text-right tabular-nums">{money(r.pt ?? 0)}</td>
                      <td data-label="ESI" className="px-3 py-2">{r.esi_contributing ? "Yes" : "No"}</td>
                      <td data-label="" className="px-3 py-2 text-right">
                        <AccessAction collection="payroll-openings" objectPath={r.path} verb="delete" can={r.access?.can} label="Remove pay before HRMS">
                          <Button size="sm" variant="ghost" onClick={() => removeEntry(r)}>Remove</Button>
                        </AccessAction>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
