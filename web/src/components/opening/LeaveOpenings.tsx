import { useMemo, useRef, useState } from "react";
import { CalendarRange, Download, FileUp } from "lucide-react";
import { invoke } from "@/api";
import { cn, formatDate, round2 } from "@/lib/utils";
import { todayStr } from "@/lib/orgDay";
import { exportTable } from "@/lib/exportTable";
import { confirmDecision } from "@/lib/confirmDecision";
import { openingItems, openingTemplate, parseOpenings } from "@/lib/openingImport";
import { useCollection } from "@/hooks/useCollection";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";
import { AccessAction } from "@/components/access/AccessAction";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/common/Field";
import type { Employee, LeaveType } from "@/types";

// Opening leave balances (services/leaveAdjustments.ts `importOpenings`), from the old system's sheet.
//
// Three steps, and only the last one writes: read the sheet here (lib/openingImport.ts says per line what it
// could not read) along with the day the sheet was made, let the SERVER preview every balance - it alone knows
// what HRMS credited and what leave it holds - and apply what the preview showed. The preview reads as a sum:
// the sheet's figure, plus HRMS accrual since its date, less the leave HRMS holds, plus anything else, is what
// the person has left.

/** Items per call, matching OPENING_BATCH_MAX on the server. */
const PER_CALL = 100;

type Result = {
  employee: string;
  leave_type: string;
  as_of?: string;
  current?: number;
  previous_opening?: number;
  opening?: number;
  earned?: number;
  leave_pending?: number;
  leave_approved?: number;
  leave_history?: number;
  other?: number;
  change?: number;
  result?: number;
  outcome: "applied" | "unchanged" | "error";
  error?: string;
};
type Answer = { dry_run: boolean; counts: Record<Result["outcome"], number>; results: Result[] };

const fmt = (n: number | undefined) => (n == null ? "-" : String(round2(n)));
const signed = (n: number | undefined) => (n == null ? "-" : n > 0 ? `+${round2(n)}` : String(round2(n)));
const leaveHeld = (r: Result) => round2((r.leave_pending ?? 0) + (r.leave_approved ?? 0) + (r.leave_history ?? 0));

export function LeaveOpenings() {
  const { toast } = useToast();
  const confirm = useConfirm();
  const { rows: employeeRows } = useCollection<Employee>("employees", { all: true });
  const { rows: typeRows } = useCollection<LeaveType>("leave-types");
  const employees = useMemo(() => employeeRows.filter((e) => !e.delete_time), [employeeRows]);
  const types = useMemo(() => typeRows.filter((t) => !t.delete_time && !t.disabled), [typeRows]);
  const nameOf = useMemo(() => new Map(employees.map((e) => [e.path, `${e.first_name} ${e.last_name}`])), [employees]);
  const typeOf = useMemo(() => new Map(types.map((t) => [t.path, t.display_name ?? ""])), [types]);

  const [text, setText] = useState("");
  // The day the old system's figures are as of. Asked for, never assumed: a sheet exported weeks before (or
  // after) the records start reads very differently, and today is rarely the right guess.
  const [sheetDate, setSheetDate] = useState("");
  const today = todayStr();
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const fileRef = useRef<HTMLInputElement | null>(null);
  const parsed = useMemo(() => (text.trim() ? parseOpenings(text, employees, types) : null), [text, employees, types]);
  const items = useMemo(() => (parsed ? openingItems(parsed) : []), [parsed]);
  const problems = parsed ? parsed.lines.filter((l) => l.errors.length) : [];

  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  // One call per slice of a hundred; the answers are merged into one table in the order sent.
  async function run(dryRun: boolean): Promise<Answer> {
    const merged: Answer = { dry_run: dryRun, counts: { applied: 0, unchanged: 0, error: 0 }, results: [] };
    for (let i = 0; i < items.length; i += PER_CALL) {
      setProgress(`${Math.min(i + PER_CALL, items.length)} of ${items.length}`);
      const slice = items.slice(i, i + PER_CALL).map((it) => ({ ...it, as_of: sheetDate }));
      const part = await invoke<Answer>("leave-adjustments", "importOpenings", undefined, { items: slice, dry_run: dryRun });
      merged.results.push(...part.results);
      for (const k of ["applied", "unchanged", "error"] as const) merged.counts[k] += part.counts[k];
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

  async function apply() {
    if (!answer) return;
    const n = answer.counts.applied;
    if (!(await confirmDecision(confirm, "applyOpenings", `${n} balance${n === 1 ? "" : "s"} for ${new Set(answer.results.filter((r) => r.outcome === "applied").map((r) => r.employee)).size} people`))) return;
    setBusy("apply");
    try {
      const done = await run(false);
      setAnswer(done);
      toast({
        variant: done.counts.error ? "destructive" : "success",
        title: `${done.counts.applied} opening balance${done.counts.applied === 1 ? "" : "s"} applied`,
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
    const { headers, rows } = openingTemplate(employees, types);
    return exportTable("opening-leave-balances", headers, rows, "csv", "leave-adjustments");
  }

  const applied = answer && !answer.dry_run;
  // "Other" earns a column only when some balance has movements besides accrual and leave.
  const showOther = !!answer?.results.some((r) => r.other);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarRange className="h-4 w-4 text-muted-foreground" /> Leave balances
        </CardTitle>
        <CardDescription>
          The balance each person had on the day the old system's sheet was made: everything earned up to then under your leave policy,
          less everything taken. HRMS adds its own accrual from that day on and takes off the leave it holds (pending and approved
          requests, and leave brought in below that started after the sheet), so each person ends with what they have left. If the sheet
          already took off leave booked for later dates, add those days back here and bring the leave in below as booked leave, so it
          comes off once. Re-importing a sheet changes only what differs.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Field label="Sheet date" hint="The day the old system's balances are as of, not the day you import them." className="w-56">
          <Input
            type="date"
            value={sheetDate}
            min={yearStart}
            max={today}
            onChange={(e) => { setSheetDate(e.target.value); setAnswer(null); }}
          />
        </Field>
        <div className="flex flex-wrap gap-2">
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
          placeholder={"Paste from the spreadsheet, header row first:\nEmployee ID\tName\tEarned Leave\tSick Leave\nEMP-0001\tAsha Rao\t12.5\t4"}
          aria-label="Opening balances sheet"
        />
        {parsed?.error && <p className="text-sm text-destructive">{parsed.error}</p>}
        {parsed && !parsed.error && (
          <div className="space-y-1 text-xs text-muted-foreground">
            <p>{items.length} balance{items.length === 1 ? "" : "s"} read from {parsed.lines.length - problems.length} of {parsed.lines.length} line{parsed.lines.length === 1 ? "" : "s"}. Blank cells leave a balance as HRMS has it.</p>
            {parsed.unknownColumns.length > 0 && <p className="text-warning">Ignored columns that name no leave type: {parsed.unknownColumns.join(", ")}.</p>}
            {problems.length > 0 && (
              <ul className="space-y-0.5 text-destructive">
                {problems.slice(0, 20).map((l) => <li key={l.line}>Line {l.line}{l.name ? ` (${l.name})` : ` (${l.key || "blank"})`}: {l.errors.join(" ")}</li>)}
                {problems.length > 20 && <li>…and {problems.length - 20} more.</li>}
              </ul>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <AccessAction collection="leave-adjustments" verb="importOpenings" label="Bring in opening leave balances">
            <Button variant="outline" loading={busy === "preview"} disabled={!items.length || !sheetDate || !!busy} onClick={() => preview()}>Preview</Button>
          </AccessAction>
          {items.length > 0 && !sheetDate && <span className="text-xs text-muted-foreground">Enter the sheet date to preview.</span>}
          {progress && <span className="text-xs text-muted-foreground tabular-nums">{progress}…</span>}
        </div>

        {answer && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="success">{answer.counts.applied} {applied ? "applied" : "to apply"}</Badge>
              <Badge variant="secondary">{answer.counts.unchanged} unchanged</Badge>
              {answer.counts.error > 0 && <Badge variant="destructive">{answer.counts.error} can't be applied</Badge>}
            </div>
            <div className="max-h-[28rem] overflow-auto rounded-md border px-3 sm:px-0">
              {/* Labelled blocks below `sm`, a table from there up (`.table-stack`). */}
              <table className="table-stack w-full text-sm">
                <thead className="sticky top-0 bg-muted/80 text-left text-xs text-muted-foreground backdrop-blur">
                  <tr>
                    <th className="px-3 py-2 font-medium">Person</th>
                    <th className="px-3 py-2 font-medium">Leave type</th>
                    <th className="px-3 py-2 text-right font-medium">Now</th>
                    <th className="px-3 py-2 text-right font-medium">Sheet</th>
                    <th className="px-3 py-2 text-right font-medium">Earned since</th>
                    <th className="px-3 py-2 text-right font-medium">Leave in HRMS</th>
                    {showOther && <th className="px-3 py-2 text-right font-medium">Other</th>}
                    <th className="px-3 py-2 text-right font-medium">Left</th>
                    <th className="px-3 py-2 font-medium">Result</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {answer.results.map((r, i) => (
                    <tr key={`${r.employee}|${r.leave_type}|${i}`} className={cn(r.outcome === "error" && "bg-destructive/5")}>
                      <td className="px-3 py-2">
                        {nameOf.get(r.employee) ?? r.employee}
                        {r.as_of && <span className="block text-[11px] text-muted-foreground">sheet of {formatDate(r.as_of)}</span>}
                      </td>
                      <td data-label="Leave type" className="px-3 py-2">{typeOf.get(r.leave_type) ?? r.leave_type}</td>
                      <td data-label="Now" className="px-3 py-2 text-right tabular-nums">{fmt(r.current)}</td>
                      <td data-label="Sheet" className="px-3 py-2 text-right tabular-nums">
                        {fmt(r.opening)}
                        {r.previous_opening != null && r.previous_opening !== r.opening && (
                          <span className="block text-[11px] text-muted-foreground">was {fmt(r.previous_opening)}</span>
                        )}
                      </td>
                      <td data-label="Earned since" className="px-3 py-2 text-right tabular-nums">{r.earned == null ? "-" : signed(r.earned)}</td>
                      <td data-label="Leave in HRMS" className="px-3 py-2 text-right tabular-nums">
                        {r.outcome === "error" && r.leave_pending == null ? "-" : signed(-leaveHeld(r))}
                        {leaveHeld(r) > 0 && (
                          <span className="block text-[11px] text-muted-foreground">
                            {[
                              r.leave_pending ? `${fmt(r.leave_pending)} pending` : "",
                              r.leave_approved ? `${fmt(r.leave_approved)} approved` : "",
                              r.leave_history ? `${fmt(r.leave_history)} brought in` : "",
                            ].filter(Boolean).join(" · ")}
                          </span>
                        )}
                      </td>
                      {showOther && (
                        <td data-label="Other" className="px-3 py-2 text-right tabular-nums" title="Corrections, encashments and the year-end carry-forward since the sheet">
                          {r.other ? signed(r.other) : "-"}
                        </td>
                      )}
                      <td data-label="Left" className="px-3 py-2 text-right font-medium tabular-nums">{fmt(r.result)}</td>
                      <td data-label="Result" className="px-3 py-2">
                        {r.outcome === "error" ? (
                          <span className="text-xs text-destructive">{r.error}</span>
                        ) : (
                          <Badge variant={r.outcome === "applied" ? "success" : "secondary"}>
                            {r.outcome === "unchanged" ? "Unchanged" : applied ? "Applied" : r.change === 0 ? "No change" : `${(r.change ?? 0) > 0 ? "+" : ""}${fmt(r.change)} days`}
                          </Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!applied && answer.counts.applied > 0 && (
              <div className="flex justify-end">
                <AccessAction collection="leave-adjustments" verb="importOpenings" label="Bring in opening leave balances">
                  <Button loading={busy === "apply"} disabled={!!busy} onClick={() => apply()}>
                    Apply {answer.counts.applied} balance{answer.counts.applied === 1 ? "" : "s"}
                  </Button>
                </AccessAction>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
