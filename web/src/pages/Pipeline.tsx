import { useMemo, useState } from "react";
import { KanbanSquare, Plus, ChevronRight, X, Users, UserCheck, Archive } from "lucide-react";
import { create, invoke } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { idOf } from "@/lib/utils";
import { navigate } from "@/router";
import type { Me, Application, Candidate, JobRequisition } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { PageSettings } from "@/components/common/SettingsButton";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { Field } from "@/components/common/Field";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Combobox } from "@/components/ui/combobox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AccessAction } from "@/components/access/AccessAction";
import { useToast } from "@/components/ui/use-toast";
import { useAtsConfig, sourceLabel } from "./Candidates";

const CLOSED = "__closed"; // synthetic column: rejected / withdrawn applications

export default function Pipeline({ me }: { me: Me }) {
  const { rows: apps, state, error, reload } = useCollection<Application>("applications");
  const { rows: candidates } = useCollection<Candidate>("candidates");
  const { rows: reqs } = useCollection<JobRequisition>("job-requisitions");
  const cfg = useAtsConfig();
  const { toast } = useToast();
  const [reqFilter, setReqFilter] = useState("all");
  const [dialog, setDialog] = useState(false);
  const [rejecting, setRejecting] = useState<Application | null>(null);
  const [advancing, setAdvancing] = useState<string | null>(null);

  const candName = useMemo(() => {
    const m = new Map(candidates.map((c) => [idOf(c.path), c.name]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Candidate" : "");
  }, [candidates]);
  const reqTitle = useMemo(() => {
    const m = new Map(reqs.map((r) => [idOf(r.path), r.title]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "" : "");
  }, [reqs]);

  const visible = useMemo(
    () => apps.filter((a) => reqFilter === "all" || (a.requisition && idOf(a.requisition) === reqFilter)),
    [apps, reqFilter],
  );

  // Columns: the configured active stages, the hired stage, then a synthetic Closed column.
  const columns = useMemo(() => {
    const cols = cfg.stages.map((s) => ({ key: s.key, label: s.label, kind: s.kind }));
    return [...cols, { key: CLOSED, label: "Closed", kind: "rejected" as const }];
  }, [cfg]);

  const byColumn = useMemo(() => {
    const m = new Map<string, Application[]>();
    for (const col of columns) m.set(col.key, []);
    for (const a of visible) {
      const key = a.status === "rejected" || a.status === "withdrawn" ? CLOSED : a.stage;
      (m.get(key) ?? m.get(CLOSED)!).push(a);
    }
    return m;
  }, [visible, columns]);

  // Label of the stage `advance` moves this application into, so the button says where it's going.
  const nextStageLabel = useMemo(() => {
    return (stage: string) => {
      const i = cfg.stages.findIndex((s) => s.key === stage);
      return i >= 0 ? cfg.stages[i + 1]?.label : undefined;
    };
  }, [cfg]);

  async function advance(a: Application) {
    setAdvancing(a.path);
    try { await invoke(`applications/${idOf(a.path)}`, "advance"); reload(); }
    catch (e) { toast({ title: "Couldn't advance", description: (e as Error).message, variant: "destructive" }); }
    finally { setAdvancing(null); }
  }

  const newBtn = (
    <AccessAction collection="applications" create label="Add an application">
      <Button onClick={() => setDialog(true)}><Plus className="h-4 w-4" /> New application</Button>
    </AccessAction>
  );

  const openReqs = reqs.filter((r) => r.status === "open" || r.status === "draft" || r.status === "on_hold");

  return (
    <div>
      <PageHeader
        title="Pipeline"
        description="Applications by stage. Advance or reject candidates as they move through hiring."
        actions={<>{newBtn}<PageSettings me={me} host="pipeline" /></>}
      />

      {visible.length > 0 && (
        <SummaryStrip
          items={[
            { label: "In pipeline", value: visible.filter((a) => a.status === "active").length, icon: Users, tone: "primary" },
            { label: "Hired", value: visible.filter((a) => a.status === "hired").length, icon: UserCheck, tone: "success" },
            { label: "Closed", value: visible.filter((a) => a.status === "rejected" || a.status === "withdrawn").length, icon: Archive, tone: "muted" },
          ]}
        />
      )}

      <div className="mb-4 flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Job</span>
        <Select value={reqFilter} onValueChange={setReqFilter}>
          <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All jobs</SelectItem>
            {reqs.map((r) => <SelectItem key={r.path} value={idOf(r.path)}>{r.title}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <DataState state={state} error={error} onRetry={reload}>
        {visible.length === 0 ? (
          apps.length > 0 ? (
            <EmptyState icon={KanbanSquare} title="No applications on this job" description="Pick another job above, or add an application to this one." action={newBtn} />
          ) : (
            <EmptyState icon={KanbanSquare} title="No applications yet" description="Apply a candidate to an open job to start moving them through the pipeline." action={newBtn} />
          )
        ) : (
          <div className="flex gap-3 overflow-x-auto pb-4">
            {columns.map((col) => {
              const items = byColumn.get(col.key) ?? [];
              return (
                <div key={col.key} className="flex w-72 shrink-0 flex-col rounded-lg border bg-muted/20">
                  <div className="flex items-center justify-between border-b px-3 py-2">
                    <span className="text-sm font-medium">{col.label}</span>
                    <Badge variant="secondary">{items.length}</Badge>
                  </div>
                  <div className="flex flex-col gap-2 p-2">
                    {items.map((a) => {
                      const can = a.access?.can ?? [];
                      const closed = a.status === "rejected" || a.status === "withdrawn";
                      const hired = col.kind === "hired";
                      // Time-in-stage is the "is this candidate going stale" signal recruiters scan for.
                      const since = a.stage_changed_time ?? a.applied_time;
                      const days = !closed && !hired && since ? Math.floor((Date.now() - new Date(since).getTime()) / 86400000) : null;
                      return (
                        <div key={a.path} className="rounded-md border bg-background p-2.5 shadow-sm">
                          <div className="flex items-baseline justify-between gap-2">
                            {a.candidate
                              ? <button type="button" className="font-medium text-sm hover:underline" onClick={() => navigate(`candidates/${idOf(a.candidate!)}`)}>{candName(a.candidate)}</button>
                              : <div className="font-medium text-sm">{candName(a.candidate)}</div>}
                            {days != null && days >= 1 && (
                              <span className={`shrink-0 text-[11px] tabular-nums ${days > 14 ? "font-medium text-warning dark:text-warning" : "text-muted-foreground"}`} title={`In this stage since ${new Date(since!).toLocaleDateString()}`}>{days}d</span>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">{reqTitle(a.requisition)}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-1">
                            {a.source && <Badge variant="outline" className="text-[10px]">{sourceLabel(a.source)}</Badge>}
                            {a.status === "withdrawn" && <Badge variant="secondary" className="text-[10px]">Withdrawn</Badge>}
                            {closed && a.rejection_reason && <span className="text-[11px] text-destructive">{a.rejection_reason}</span>}
                          </div>
                          {!closed && (
                            <div className="mt-2 flex items-center gap-1">
                              {!hired && can.includes("advance") && (
                                <Button size="sm" variant="outline" className="h-7" loading={advancing === a.path} onClick={() => advance(a)}>
                                  {nextStageLabel(a.stage) ? `Advance to ${nextStageLabel(a.stage)}` : "Advance"} <ChevronRight className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              {can.includes("reject") && <Button size="sm" variant="ghost" className="h-7 text-destructive" onClick={() => setRejecting(a)}><X className="h-3.5 w-3.5" /> Reject</Button>}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {items.length === 0 && <p className="px-1 py-6 text-center text-xs text-muted-foreground">Empty</p>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </DataState>

      {dialog && (
        <ApplicationDialog
          candidates={candidates}
          apps={apps}
          reqs={openReqs}
          stages={cfg.stages}
          onClose={() => setDialog(false)}
          onSaved={() => { setDialog(false); reload(); }}
        />
      )}
      {rejecting && (
        <RejectDialog
          app={rejecting}
          reasons={cfg.rejection_reasons}
          candName={candName(rejecting.candidate)}
          onClose={() => setRejecting(null)}
          onDone={() => { setRejecting(null); reload(); }}
        />
      )}
    </div>
  );
}

function ApplicationDialog({ candidates, apps, reqs, stages, onClose, onSaved }: {
  candidates: Candidate[];
  apps: Application[];
  reqs: JobRequisition[];
  stages: { key: string; label: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [candidate, setCandidate] = useState("");
  const [req, setReq] = useState("");
  const [stage, setStage] = useState(stages[0]?.key ?? "applied");
  const [busy, setBusy] = useState(false);
  // A candidate with a live application on the chosen job would be a duplicate - hide them once a job is picked.
  const options = useMemo(() => {
    const taken = new Set(
      apps.filter((a) => a.status === "active" && a.requisition && (!req || idOf(a.requisition) === req)).map((a) => (a.candidate ? idOf(a.candidate) : "")),
    );
    return candidates.filter((c) => !req || !taken.has(idOf(c.path))).map((c) => ({ value: idOf(c.path), label: c.name }));
  }, [candidates, apps, req]);
  const valid = !!candidate && !!req;

  async function save() {
    setBusy(true);
    try {
      await create<Application>("applications", { candidate: `candidates/${candidate}`, requisition: `job-requisitions/${req}`, stage });
      toast({ title: "Application added", variant: "success" });
      onSaved();
    } catch (e) {
      toast({ title: "Couldn't add", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent onEnterSubmit={() => { if (!busy && valid) save(); }}>
        <DialogHeader><DialogTitle>New application</DialogTitle></DialogHeader>
        <Field label="Candidate">
          <Combobox
            value={candidate}
            onValueChange={setCandidate}
            options={options}
            placeholder="Pick a candidate"
            emptyText={req ? "No candidates left for this job - everyone else already has a live application on it." : "No candidates. Add them on the Candidates page first."}
          />
        </Field>
        <Field label="Job">
          <Select value={req} onValueChange={setReq}>
            <SelectTrigger><SelectValue placeholder="Pick a job" /></SelectTrigger>
            <SelectContent>{reqs.map((r) => <SelectItem key={r.path} value={idOf(r.path)}>{r.title}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Starting stage">
          <Select value={stage} onValueChange={setStage}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{stages.map((s) => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} loading={busy} disabled={!valid}>Add application</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RejectDialog({ app, reasons, candName, onClose, onDone }: {
  app: Application;
  reasons: string[];
  candName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [reason, setReason] = useState(reasons[0] ?? "");
  const [busy, setBusy] = useState(false);

  async function reject() {
    setBusy(true);
    try {
      await invoke(`applications/${idOf(app.path)}`, "reject", undefined, { reason: reason || undefined });
      toast({ title: "Application rejected" });
      onDone();
    } catch (e) {
      toast({ title: "Couldn't reject", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Reject {candName}</DialogTitle></DialogHeader>
        <Field label="Reason">
          <Select value={reason} onValueChange={setReason}>
            <SelectTrigger><SelectValue placeholder="Select a reason" /></SelectTrigger>
            <SelectContent>{reasons.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" onClick={reject} loading={busy}>Reject</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
