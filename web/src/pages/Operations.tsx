import { useMemo, useState } from "react";
import { Activity, RefreshCw, Clock3, CalendarClock, Play } from "lucide-react";
import { api } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { humanize, idOf } from "@/lib/utils";
import type { Me, Operation, CronRun } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { useToast } from "@/components/ui/use-toast";

// The app's scheduled triggers. Kept in lockstep with wrangler.toml `crons` and src/cron.ts dispatch.
// Display metadata only - run status/history comes from /v1/cron-runs; "next run" is computed below.
const CRONS = [
  { cron: "*/5 * * * *", name: "Job drainer", cadence: "Every 5 minutes", description: "Processes queued background jobs, e.g. generating payslip PDFs after a payroll run is published." },
  { cron: "0 2 * * *", name: "Daily maintenance", cadence: "Daily at 02:00 UTC", description: "Accrues monthly leave balances and sends reminder emails (probation endings, work anniversaries, expiring documents)." },
];

// Minimal cron matcher (5 fields: min hour day-of-month month day-of-week), enough for the expressions
// above. Cloudflare crons fire in UTC, so everything is computed in UTC.
function fieldMatch(expr: string, value: number): boolean {
  return expr.split(",").some((part) => {
    if (part === "*") return true;
    if (part.startsWith("*/")) { const n = Number(part.slice(2)); return n > 0 && value % n === 0; }
    if (part.includes("-")) { const [a, b] = part.split("-").map(Number); return value >= a! && value <= b!; }
    return Number(part) === value;
  });
}
function nextRun(expr: string, from: Date): Date | null {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [mi, ho, dom, mo, dow] = f as [string, string, string, string, string];
  let t = new Date(from);
  t.setUTCSeconds(0, 0);
  t = new Date(+t + 60_000); // start from the next whole minute
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (fieldMatch(mi, t.getUTCMinutes()) && fieldMatch(ho, t.getUTCHours()) && fieldMatch(dom, t.getUTCDate()) && fieldMatch(mo, t.getUTCMonth() + 1) && fieldMatch(dow, t.getUTCDay())) return t;
    t = new Date(+t + 60_000);
  }
  return null;
}

// "in 3 min" / "5 min ago" - compact relative time.
function rel(value?: string | Date | null): string {
  if (!value) return "-";
  const ms = +new Date(value) - Date.now();
  const past = ms < 0;
  const s = Math.round(Math.abs(ms) / 1000);
  const units: [number, string][] = [[86400, "day"], [3600, "hr"], [60, "min"], [1, "sec"]];
  for (const [secs, label] of units) {
    if (s >= secs) { const n = Math.floor(s / secs); return past ? `${n} ${label}${n !== 1 ? "s" : ""} ago` : `in ${n} ${label}${n !== 1 ? "s" : ""}`; }
  }
  return past ? "just now" : "in a moment";
}
const absUtc = (value?: string | Date | null) => (value ? new Date(value).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "-");
const fmtDuration = (ms?: number) => (ms == null ? "" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const fmtSummary = (s?: Record<string, number>) => (s && Object.keys(s).length ? Object.entries(s).map(([k, v]) => `${humanize(k)}: ${v}`).join(" · ") : "");

export default function Operations({ embedded }: { me?: Me; embedded?: boolean }) {
  const { toast } = useToast();
  const crons = useCollection<CronRun>("cron-runs", { max: 200 });
  const jobs = useCollection<Operation>("operations", { max: 200 });
  // A deliberate TRIGGER, not a reference: the factory reads neither list, it just needs a fresh clock each
  // time the data reloads so "next run" is computed against now rather than against page-open. The linter
  // cannot tell that apart from a stale dependency, so it is silenced here with the reason rather than
  // "fixed" by dropping the deps - which would freeze the clock at mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are the reload trigger; see above
  const now = useMemo(() => new Date(), [crons.rows, jobs.rows]);
  const [running, setRunning] = useState<string | null>(null);
  const [runningJob, setRunningJob] = useState<string | null>(null);

  // Fire a scheduled task on demand (e.g. the job drainer) instead of waiting for the next tick.
  async function runNow(cron: string) {
    setRunning(cron);
    try {
      const r = await api<CronRun>("/cron-runs:run", { method: "POST", body: JSON.stringify({ cron }) });
      toast({ title: "Task ran", description: fmtSummary(r.summary) || "Completed.", variant: "success" });
      crons.reload();
      jobs.reload();
    } catch (e) {
      toast({ title: "Couldn't run task", description: (e as Error).message, variant: "destructive" });
    } finally {
      setRunning(null);
    }
  }

  // Run a single job on demand (queued / errored / orphaned). Mirrors what the drainer would do for it.
  async function runJob(j: Operation) {
    const id = idOf(j.path);
    setRunningJob(id);
    try {
      const r = await api<Operation>(`/operations/${id}:run`, { method: "POST" });
      toast({ title: r.error ? "Job failed" : "Job ran", description: r.error?.detail || (r.done ? "Completed." : "Re-queued."), variant: r.error ? "destructive" : "success" });
      jobs.reload();
    } catch (e) {
      toast({ title: "Couldn't run job", description: (e as Error).message, variant: "destructive" });
    } finally {
      setRunningJob(null);
    }
  }

  // Latest recorded tick per cron expression (cron-runs arrives newest-first).
  const latestByCron = useMemo(() => {
    const m = new Map<string, CronRun>();
    for (const r of crons.rows) if (!m.has(r.cron)) m.set(r.cron, r);
    return m;
  }, [crons.rows]);

  function reloadAll() { crons.reload(); jobs.reload(); }

  const refreshBtn = <Button variant="outline" size="sm" onClick={reloadAll}><RefreshCw className="h-4 w-4" /> Refresh</Button>;

  return (
    <div>
      {embedded ? (
        <div className="mb-4 flex justify-end">{refreshBtn}</div>
      ) : (
        <PageHeader
          accessCollection="operations"
          title="Operations"
          description="Scheduled tasks and background jobs across the system."
          actions={refreshBtn}
        />
      )}

      {/* Scheduled tasks (crons) */}
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-muted-foreground"><CalendarClock className="h-4 w-4" /> Scheduled tasks</h2>
      <DataState state={crons.state} error={crons.error} onRetry={crons.reload} rows={2}>
        {/* A third column from `xl`: these are short status cards, not forms - two of them across a 1440px
            screen leaves half the width empty and pushes the job table below the fold for no reason. */}
        <div className="mb-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {CRONS.map((c) => {
            const last = latestByCron.get(c.cron);
            const next = nextRun(c.cron, now);
            return (
              <Card key={c.cron}>
                <CardHeader className="space-y-1 pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">{c.name}</CardTitle>
                    <code className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{c.cron}</code>
                  </div>
                  <p className="text-xs text-muted-foreground">{c.cadence}</p>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <p className="text-muted-foreground">{c.description}</p>
                  <div className="flex items-center justify-between border-t pt-3">
                    <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Last run</span>
                    {last ? (
                      <span className="flex items-center gap-2">
                        <StatusBadge state={last.status} />
                        <span title={absUtc(last.start_time)}>{rel(last.start_time)}</span>
                        {last.duration_ms != null && <span className="text-xs text-muted-foreground">({fmtDuration(last.duration_ms)})</span>}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Never run</span>
                    )}
                  </div>
                  {last && (fmtSummary(last.summary) || last.error) && (
                    <p className={`text-xs ${last.error ? "text-destructive" : "text-muted-foreground"}`}>{last.error || fmtSummary(last.summary)}</p>
                  )}
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Next run</span>
                    <span className="flex items-center gap-1.5"><Clock3 className="h-3.5 w-3.5 text-muted-foreground" /><span title={absUtc(next)}>{next ? rel(next) : "-"}</span></span>
                  </div>
                  <div className="flex justify-end border-t pt-3">
                    <AccessAction collection="cron-runs" verb="run" label="Run now">
                      <Button variant="outline" size="sm" loading={running === c.cron} disabled={running !== null} onClick={() => runNow(c.cron)}>
                        {running !== c.cron && <Play className="h-4 w-4" />} Run now
                      </Button>
                    </AccessAction>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </DataState>

      {/* Background jobs */}
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-muted-foreground"><Activity className="h-4 w-4" /> Background jobs</h2>
      <DataState state={jobs.state} error={jobs.error} onRetry={jobs.reload} rows={3}>
        {jobs.rows.length === 0 ? (
          <EmptyState icon={Activity} title="No jobs yet" description="Background jobs (such as payslip generation) appear here once started." />
        ) : (
          <Card>
            <CardContent className="p-0 sm:p-0">
              {/* Six columns including free-text results - three times what a phone holds, so below `sm` each
                  job becomes a labelled block and the table proper starts at 640px. */}
              <div className="scroll-shadow-x overflow-x-auto [--scroll-ground:hsl(var(--card))]">
              <table className="table-stack w-full text-sm sm:min-w-[40rem]">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">Job</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5 font-medium">Started</th>
                    <th className="px-4 py-2.5 text-right font-medium">Attempts</th>
                    <th className="px-4 py-2.5 font-medium">Result</th>
                    <th className="px-4 py-2.5 text-right font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.rows.map((j) => {
                    const md = j.metadata ?? {};
                    const result = j.error?.detail || (j.response ? fmtSummary(j.response as Record<string, number>) : "");
                    const id = idOf(j.path);
                    const runnable = md.status === "queued" || md.status === "running" || md.status === "error";
                    return (
                      <tr key={j.path} id={`op-job-${id}`} className="border-b last:border-0">
                        <td className="px-4 py-2.5 font-medium">{md.kind ? humanize(md.kind.replace(/\./g, " ")) : "-"}</td>
                        <td data-label="Status" className="px-4 py-2.5">{md.status ? <StatusBadge state={md.status} /> : "-"}</td>
                        <td data-label="Started" className="px-4 py-2.5 text-muted-foreground" title={absUtc(md.create_time)}>{rel(md.create_time)}</td>
                        <td data-label="Attempts" className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{md.attempts ?? 0}</td>
                        <td data-label="Result" className={`px-4 py-2.5 text-xs ${j.error ? "text-destructive" : "text-muted-foreground"}`}>{result || "-"}</td>
                        <td className="px-4 py-2.5 text-right">
                          {runnable && (
                            <AccessAction collection="operations" objectPath={`operations/${id}`} verb="run" label="Run job">
                              <Button variant="outline" size="sm" loading={runningJob === id} disabled={runningJob !== null} onClick={() => runJob(j)}>
                                {runningJob !== id && <Play className="h-4 w-4" />} {md.status === "error" ? "Retry" : "Run"}
                              </Button>
                            </AccessAction>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            </CardContent>
          </Card>
        )}
      </DataState>
    </div>
  );
}
