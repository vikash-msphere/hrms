import { useMemo, useRef, useState } from "react";
import { Download, FileUp, History } from "lucide-react";
import { invoke } from "@/api";
import { cn, formatDate } from "@/lib/utils";
import { exportTable } from "@/lib/exportTable";
import { confirmDecision } from "@/lib/confirmDecision";
import { historyItems, historyTemplate, parseLeaveHistory } from "@/lib/openingImport";
import { useCollection } from "@/hooks/useCollection";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";
import { AccessAction } from "@/components/access/AccessAction";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Employee, LeaveType } from "@/types";

// Leave taken before HRMS (services/leaveHistoryImport.ts `importHistory`), from the old system's sheet. Same
// three steps as the sections beside it: read the sheet here, let the server check every leave (it alone knows
// each person's records-start date and what is already in HRMS), then apply what the preview showed.

/** Items per call, matching HISTORY_BATCH_MAX on the server. */
const PER_CALL = 100;

type Result = {
  employee: string;
  leave_type: string;
  start_date?: string;
  end_date?: string;
  days?: number;
  days_from?: "file" | "counted";
  kind?: "history" | "booked";
  outcome: "created" | "unchanged" | "error";
  error?: string;
};
type Answer = { dry_run: boolean; counts: Record<Result["outcome"], number>; results: Result[] };
const OUTCOMES = ["created", "unchanged", "error"] as const;

export function LeaveHistoryImport() {
  const { toast } = useToast();
  const confirm = useConfirm();
  const { rows: employeeRows } = useCollection<Employee>("employees", { all: true });
  const { rows: typeRows } = useCollection<LeaveType>("leave-types");
  const employees = useMemo(() => employeeRows.filter((e) => !e.delete_time), [employeeRows]);
  const types = useMemo(() => typeRows.filter((t) => !t.delete_time), [typeRows]);
  const nameOf = useMemo(() => new Map(employees.map((e) => [e.path, `${e.first_name} ${e.last_name}`])), [employees]);
  const typeOf = useMemo(() => new Map(types.map((t) => [t.path, t.display_name ?? ""])), [types]);

  const [text, setText] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const parsed = useMemo(() => (text.trim() ? parseLeaveHistory(text, employees, types) : null), [text, employees, types]);
  const items = useMemo(() => (parsed ? historyItems(parsed) : []), [parsed]);
  const problems = parsed ? parsed.lines.filter((l) => l.errors.length) : [];

  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  async function run(dryRun: boolean): Promise<Answer> {
    const merged: Answer = { dry_run: dryRun, counts: { created: 0, unchanged: 0, error: 0 }, results: [] };
    for (let i = 0; i < items.length; i += PER_CALL) {
      setProgress(`${Math.min(i + PER_CALL, items.length)} of ${items.length}`);
      const part = await invoke<Answer>("leave-requests", "importHistory", undefined, { items: items.slice(i, i + PER_CALL), dry_run: dryRun });
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

  async function apply() {
    if (!answer) return;
    const n = answer.counts.created;
    const people = new Set(answer.results.filter((r) => r.outcome === "created").map((r) => r.employee)).size;
    if (!(await confirmDecision(confirm, "applyLeaveHistory", `${n} leave${n === 1 ? "" : "s"} for ${people} ${people === 1 ? "person" : "people"}`))) return;
    setBusy("apply");
    try {
      const done = await run(false);
      setAnswer(done);
      toast({
        variant: done.counts.error ? "destructive" : "success",
        title: `${done.counts.created} leave${done.counts.created === 1 ? "" : "s"} brought in`,
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
    const { headers, rows } = historyTemplate();
    void exportTable("leave-before-hrms", headers, rows, "csv", "leave-requests");
  }

  const applied = answer && !answer.dry_run;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="h-4 w-4 text-muted-foreground" /> Leave from before HRMS
        </CardTitle>
        <CardDescription>
          Leave taken before a person's HRMS records start is history: yearly quotas, lifetime limits (maternity, for example) and the
          probation cap count it, it shows marked "Before HRMS", and it changes no balance - the opening balance already has it taken off.
          Leave the old system had already approved for dates from then on is booked leave: it lands as approved leave and takes its days
          off the balance here, once. For the first month HRMS pays, bring in the old system's unpaid days before go-live as Loss of Pay
          leave so payroll docks them. Nobody is notified.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
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
          placeholder={"Paste from the spreadsheet, header row first, one leave per line:\nEmployee ID\tName\tLeave type\tFrom\tTo\tDays\nEMP-0001\tAsha Rao\tEarned Leave\t02/03/2026\t06/03/2026\t5"}
          aria-label="Leave before HRMS sheet"
        />
        {parsed?.error && <p className="text-sm text-destructive">{parsed.error}</p>}
        {parsed && !parsed.error && (
          <div className="space-y-1 text-xs text-muted-foreground">
            <p>{items.length} of {parsed.lines.length} leave{parsed.lines.length === 1 ? "" : "s"} read. Dates are read day first (02/03/2026 is 2 March). A blank "Days" is counted the way a request would be.</p>
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
          <AccessAction collection="leave-requests" verb="importHistory" label="Bring in leave from before HRMS">
            <Button variant="outline" loading={busy === "preview"} disabled={!items.length || !!busy} onClick={() => void preview()}>Preview</Button>
          </AccessAction>
          {progress && <span className="text-xs text-muted-foreground tabular-nums">{progress}…</span>}
        </div>

        {answer && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="success">{answer.counts.created} {applied ? "brought in" : "to bring in"}</Badge>
              <Badge variant="secondary">{answer.counts.unchanged} already in</Badge>
              {answer.counts.error > 0 && <Badge variant="destructive">{answer.counts.error} can't be applied</Badge>}
            </div>
            <div className="max-h-[28rem] overflow-auto rounded-md border px-3 sm:px-0">
              {/* Labelled blocks below `sm`, a table from there up (`.table-stack`). */}
              <table className="table-stack w-full text-sm">
                <thead className="sticky top-0 bg-muted/80 text-left text-xs text-muted-foreground backdrop-blur">
                  <tr>
                    <th className="px-3 py-2 font-medium">Person</th>
                    <th className="px-3 py-2 font-medium">Leave type</th>
                    <th className="px-3 py-2 font-medium">Dates</th>
                    <th className="px-3 py-2 text-right font-medium">Days</th>
                    <th className="px-3 py-2 font-medium">Result</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {answer.results.map((r, i) => (
                    <tr key={`${r.employee}|${r.start_date}|${i}`} className={cn(r.outcome === "error" && "bg-destructive/5")}>
                      <td className="px-3 py-2">{nameOf.get(r.employee) ?? r.employee}</td>
                      <td data-label="Leave type" className="px-3 py-2">{typeOf.get(r.leave_type) ?? r.leave_type}</td>
                      <td data-label="Dates" className="px-3 py-2 tabular-nums">
                        {r.start_date ? formatDate(r.start_date) : "-"}{r.end_date && r.end_date !== r.start_date ? ` – ${formatDate(r.end_date)}` : ""}
                      </td>
                      <td data-label="Days" className="px-3 py-2 text-right tabular-nums">
                        {r.days ?? "-"}
                        {r.days_from === "counted" && <span className="block text-[11px] text-muted-foreground">counted</span>}
                      </td>
                      <td data-label="Result" className="px-3 py-2">
                        {r.outcome === "error" ? (
                          <span className="text-xs text-destructive">{r.error}</span>
                        ) : (
                          <span className="inline-flex flex-wrap items-center gap-1.5">
                            <Badge variant={r.outcome === "unchanged" ? "secondary" : "success"}>
                              {r.outcome === "unchanged" ? "Already in" : applied ? "Brought in" : "New"}
                            </Badge>
                            {r.kind && (
                              <span className="text-xs text-muted-foreground">
                                {r.kind === "booked" ? "booked - takes the days off the balance" : "history - balance unchanged"}
                              </span>
                            )}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!applied && answer.counts.created > 0 && (
              <div className="flex justify-end">
                <AccessAction collection="leave-requests" verb="importHistory" label="Bring in leave from before HRMS">
                  <Button loading={busy === "apply"} disabled={!!busy} onClick={() => void apply()}>
                    Bring in {answer.counts.created} leave{answer.counts.created === 1 ? "" : "s"}
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
