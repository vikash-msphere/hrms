import { useMemo } from "react";
import { ArrowLeft, Mail, Phone, Download, UserCheck, CalendarClock, FileSignature, Briefcase, UserSearch } from "lucide-react";
import { download } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { formatDate, idOf } from "@/lib/utils";
import { useMoney } from "@/lib/org";
import { navigate } from "@/router";
import type { Application, Candidate, Employee, Interview, JobRequisition, Me, Offer, Referral } from "@/types";
import { useAtsConfig, sourceLabel } from "./Candidates";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { ActivitySection } from "@/components/common/ActivitySection";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

type BadgeVariant = "default" | "secondary" | "success" | "destructive" | "muted" | "outline" | "warning";
const APP_STATUS: Record<string, { label: string; variant: BadgeVariant }> = {
  active: { label: "In pipeline", variant: "secondary" },
  hired: { label: "Hired", variant: "success" },
  rejected: { label: "Rejected", variant: "destructive" },
  withdrawn: { label: "Withdrawn", variant: "muted" },
};
const INTERVIEW_STATUS: Record<string, { label: string; variant: BadgeVariant }> = {
  scheduled: { label: "Scheduled", variant: "secondary" },
  done: { label: "Done", variant: "success" },
  cancelled: { label: "Cancelled", variant: "muted" },
};
const OFFER_STATUS: Record<string, { label: string; variant: BadgeVariant }> = {
  draft: { label: "Draft", variant: "muted" },
  approved: { label: "Approved", variant: "secondary" },
  extended: { label: "Extended", variant: "secondary" },
  accepted: { label: "Accepted", variant: "success" },
  declined: { label: "Declined", variant: "destructive" },
  rescinded: { label: "Rescinded", variant: "muted" },
};
const meta = (m: Record<string, { label: string; variant: BadgeVariant }>, s: string) => m[s] ?? { label: s, variant: "outline" as BadgeVariant };
const fmtWhen = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");

export default function CandidateProfile({ id }: { id: string; me: Me }) {
  const { rows: candidates, state, error, reload } = useCollection<Candidate>("candidates");
  const { rows: apps } = useCollection<Application>("applications");
  const { rows: reqs } = useCollection<JobRequisition>("job-requisitions");
  const { rows: interviews } = useCollection<Interview>("interviews");
  const { rows: offers } = useCollection<Offer>("offers");
  const { rows: employees } = useCollection<Employee>("employees");
  const { rows: referrals } = useCollection<Referral>("referrals");
  const cfg = useAtsConfig();
  const money = useMoney();

  const candidate = candidates.find((c) => idOf(c.path) === id) ?? null;

  const stageLabel = useMemo(() => {
    const m = new Map(cfg.stages.map((s) => [s.key, s.label]));
    return (key: string) => m.get(key) ?? key;
  }, [cfg]);
  const reqTitle = useMemo(() => {
    const m = new Map(reqs.map((r) => [idOf(r.path), r.title]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Unknown role" : "Unknown role");
  }, [reqs]);
  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Someone" : "");
  }, [employees]);

  // Everything on this page hangs off the candidate's applications, newest first.
  const myApps = useMemo(
    () => apps.filter((a) => a.candidate && idOf(a.candidate) === id).sort((a, b) => (b.applied_time ?? b.create_time ?? "").localeCompare(a.applied_time ?? a.create_time ?? "")),
    [apps, id],
  );
  const appIds = useMemo(() => new Set(myApps.map((a) => idOf(a.path))), [myApps]);
  const myInterviews = useMemo(
    () => interviews.filter((i) => i.application && appIds.has(idOf(i.application))).sort((a, b) => (b.scheduled_start_time ?? "").localeCompare(a.scheduled_start_time ?? "")),
    [interviews, appIds],
  );
  const myOffers = useMemo(() => offers.filter((o) => o.application && appIds.has(idOf(o.application))), [offers, appIds]);
  const referredBy = useMemo(() => {
    if (!candidate?.referral) return null;
    const r = referrals.find((x) => idOf(x.path) === idOf(candidate.referral!));
    return r ? { name: empName(r.referrer), when: r.create_time } : null;
  }, [candidate, referrals, empName]);

  return (
    <div className="mx-auto max-w-4xl">
      <Button variant="ghost" size="sm" className="mb-3 -ml-2 text-muted-foreground" onClick={() => navigate("candidates")}>
        <ArrowLeft className="h-4 w-4" /> All candidates
      </Button>

      <DataState state={state} error={error} onRetry={reload}>
        {!candidate ? (
          state === "ready" ? <EmptyState icon={UserSearch} title="Candidate not found" description="It may have been removed, or you may not have access to it." /> : null
        ) : (
          <div className="space-y-6">
            {/* Header: who they are + how to reach them + where they came from. */}
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h1 className="text-2xl font-semibold">{candidate.name}</h1>
                <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                  {candidate.email && <a className="flex items-center gap-1 hover:text-foreground hover:underline" href={`mailto:${candidate.email}`}><Mail className="h-3.5 w-3.5" /> {candidate.email}</a>}
                  {candidate.phone && <span className="flex items-center gap-1"><Phone className="h-3.5 w-3.5" /> {candidate.phone}</span>}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {candidate.source && <Badge variant="outline">{sourceLabel(candidate.source)}{candidate.source_detail ? ` · ${candidate.source_detail}` : ""}</Badge>}
                  {referredBy && <Badge variant="secondary" className="gap-1"><UserCheck className="h-3 w-3" /> Referred by {referredBy.name}</Badge>}
                  {(candidate.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean).map((t) => <Badge key={t} variant="muted">{t}</Badge>)}
                </div>
              </div>
              {candidate.has_resume && (
                <Button variant="outline" size="sm" onClick={() => download(`candidates/${id}`, `resume-${candidate.name}`)}>
                  <Download className="h-3.5 w-3.5" /> Resume
                </Button>
              )}
            </div>

            {candidate.notes && <p className="whitespace-pre-wrap text-sm text-foreground/80">{candidate.notes}</p>}

            {/* Applications - the spine of the hiring story. */}
            <section>
              <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold"><Briefcase className="h-4 w-4 text-muted-foreground" /> Applications</h2>
              {myApps.length === 0 ? (
                <p className="text-sm text-muted-foreground">Not applied to any role yet - add them to a job from the Pipeline page.</p>
              ) : (
                <div className="grid gap-2">
                  {myApps.map((a) => {
                    const sm = meta(APP_STATUS, a.status);
                    const since = a.stage_changed_time ?? a.applied_time;
                    const days = a.status === "active" && since ? Math.floor((Date.now() - new Date(since).getTime()) / 86400000) : null;
                    return (
                      <Card key={a.path} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
                        <span className="font-medium">{reqTitle(a.requisition)}</span>
                        <Badge variant={sm.variant}>{sm.label}</Badge>
                        {a.status === "active" && <Badge variant="outline">{stageLabel(a.stage)}</Badge>}
                        {a.status === "rejected" && a.rejection_reason && <span className="text-xs text-destructive">{a.rejection_reason}</span>}
                        <span className="ml-auto text-xs text-muted-foreground">
                          {a.applied_time ? `Applied ${formatDate(a.applied_time)}` : ""}
                          {days != null && days >= 1 ? ` · ${days}d in stage` : ""}
                        </span>
                      </Card>
                    );
                  })}
                </div>
              )}
            </section>

            {/* Interviews across all their applications. */}
            {myInterviews.length > 0 && (
              <section>
                <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold"><CalendarClock className="h-4 w-4 text-muted-foreground" /> Interviews</h2>
                <div className="grid gap-2">
                  {myInterviews.map((i) => {
                    const sm = meta(INTERVIEW_STATUS, i.status);
                    return (
                      <Card key={i.path} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
                        <span className="font-medium">{i.title}</span>
                        <Badge variant={sm.variant}>{sm.label}</Badge>
                        {i.scheduled_start_time && <span className="text-xs text-muted-foreground">{fmtWhen(i.scheduled_start_time)}</span>}
                        {(i.interviewers ?? []).length > 0 && (
                          <span className="ml-auto text-xs text-muted-foreground">{(i.interviewers ?? []).map((r) => empName(r)).join(", ")}</span>
                        )}
                      </Card>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Offers. */}
            {myOffers.length > 0 && (
              <section>
                <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold"><FileSignature className="h-4 w-4 text-muted-foreground" /> Offers</h2>
                <div className="grid gap-2">
                  {myOffers.map((o) => {
                    const sm = meta(OFFER_STATUS, o.status);
                    return (
                      <Card key={o.path} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
                        {o.base_comp != null && <span className="font-medium tabular-nums">{money(o.base_comp, o.currency_code || undefined)}</span>}
                        <Badge variant={sm.variant}>{sm.label}</Badge>
                        <span className="ml-auto text-xs text-muted-foreground">
                          {[
                            o.offer_time ? `Offered ${formatDate(o.offer_time)}` : "",
                            o.join_time ? `Joining ${formatDate(o.join_time)}` : "",
                            o.expiry_time && o.status === "extended" ? `${+new Date(o.expiry_time) < Date.now() ? "Expired" : "Expires"} ${formatDate(o.expiry_time)}` : "",
                          ].filter(Boolean).join(" · ")}
                        </span>
                      </Card>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Hired? Jump to the employee record. */}
            {myOffers.some((o) => o.created_employee) && (
              <Button variant="outline" size="sm" onClick={() => navigate(`employees/${idOf(myOffers.find((o) => o.created_employee)!.created_employee!)}`)}>
                <UserCheck className="h-3.5 w-3.5" /> View employee record
              </Button>
            )}

            {candidate && <ActivitySection resource={candidate.path} className="border-t pt-4" />}
          </div>
        )}
      </DataState>
    </div>
  );
}
