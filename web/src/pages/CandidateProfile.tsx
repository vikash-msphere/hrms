import { useMemo } from "react";
import { ArrowLeft, Mail, Phone, Download, UserCheck, CalendarClock, FileSignature, Briefcase, UserSearch } from "lucide-react";
import { download } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { useResource } from "@/hooks/useResource";
import { formatDate, idOf } from "@/lib/utils";
import { useMoney } from "@/lib/org";
import { navigate } from "@/router";
import type { Application, Candidate, Employee, Interview, JobRequisition, Me, Offer, Referral } from "@/types";
import { useAtsConfig, sourceLabel } from "./Candidates";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { AccessAction } from "@/components/access/AccessAction";
import { AccessItem } from "@/components/access/AccessItem";
import { ActivitySection } from "@/components/common/ActivitySection";
import { CopyEmail } from "@/components/common/CopyEmail";
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
  // ONE candidate's page, so the reads here are narrowed to that candidate rather than pulling a page of each
  // collection and filtering it in the browser. That was both expensive and quietly wrong: a candidate whose
  // application sat past the first page of `applications` rendered as having none.
  const { row: candidate, state, error, reload } = useResource<Candidate>("candidates", id);
  // The inbound edge decodes `<collection>/<token>` query values, so a filter is passed as a REF, never as a
  // bare id (a bare token would reach the service undecoded and match nothing).
  const { rows: apps } = useCollection<Application>("applications", { params: { candidate: `candidates/${id}` } });
  const cfg = useAtsConfig();
  const money = useMoney();

  const stageLabel = useMemo(() => {
    const m = new Map(cfg.stages.map((s) => [s.key, s.label]));
    return (key: string) => m.get(key) ?? key;
  }, [cfg]);

  // Everything on this page hangs off the candidate's applications, newest first. The list is already narrowed
  // to this candidate server-side, so there is nothing to filter out here.
  const myApps = useMemo(
    () => [...apps].sort((a, b) => (b.applied_time ?? b.create_time ?? "").localeCompare(a.applied_time ?? a.create_time ?? "")),
    [apps],
  );
  const appIds = useMemo(() => new Set(myApps.map((a) => idOf(a.path))), [myApps]);
  // Interviews and offers hang off an APPLICATION, and the overwhelmingly common case is a candidate with one -
  // so narrow to it server-side. With several applications there is no one-shot filter for "any of these", so
  // the page reads the collections and matches; either way it reads nothing at all for a candidate who has not
  // applied to anything.
  //
  // THE FALLBACK WALKS ITS CURSOR. One org-wide page of `interviews` / `offers`, newest-first, meant a
  // re-applicant's earlier rounds appeared only if they happened to be among the org's newest hundred - which
  // an earlier application's rounds never are - so the profile of somebody who applied last year and again
  // this month rendered as a candidate with no interview and no offer history at all. The walk runs only for
  // the uncommon multi-application case and is bounded by ALL_CAP.
  const soleApp = myApps.length === 1 ? myApps[0]!.path : undefined; // already a `applications/<token>` ref
  const { rows: interviews, hasMore: interviewsCropped } = useCollection<Interview>("interviews", {
    enabled: myApps.length > 0,
    ...(soleApp ? { params: { application: soleApp } } : { all: true }),
  });
  const { rows: offers, hasMore: offersCropped } = useCollection<Offer>("offers", {
    enabled: myApps.length > 0,
    ...(soleApp ? { params: { application: soleApp } } : { all: true }),
  });
  // Role titles for the applications on screen, and names for the interviewers / referrer on them. Read only
  // when there is something to label.
  const { rows: reqs } = useCollection<JobRequisition>("job-requisitions", { enabled: myApps.some((a) => a.requisition) });
  // By id, not by scanning the collection: referrals list a page at a time, and the one that sent THIS
  // candidate in is as likely as not past the cursor - which read as "nobody referred them".
  const { row: referral } = useResource<Referral>("referrals", candidate?.referral ? idOf(candidate.referral) : null);
  const needNames = !!candidate?.referral || interviews.some((i) => (i.interviewers ?? []).length > 0);
  const { rows: employees } = useCollection<Employee>("employees", { all: true, enabled: needNames });
  const reqTitle = useMemo(() => {
    const m = new Map(reqs.map((r) => [idOf(r.path), r.title]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Unknown role" : "Unknown role");
  }, [reqs]);
  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Someone" : "");
  }, [employees]);

  const myInterviews = useMemo(
    () => interviews.filter((i) => i.application && appIds.has(idOf(i.application))).sort((a, b) => (b.scheduled_start_time ?? "").localeCompare(a.scheduled_start_time ?? "")),
    [interviews, appIds],
  );
  const myOffers = useMemo(() => offers.filter((o) => o.application && appIds.has(idOf(o.application))), [offers, appIds]);
  const referredBy = useMemo(
    () => (referral ? { name: empName(referral.referrer), when: referral.create_time } : null),
    [referral, empName],
  );

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
                  {candidate.email && (
                    <CopyEmail email={candidate.email}>
                      <a className="flex items-center gap-1 hover:text-foreground hover:underline" href={`mailto:${candidate.email}`}><Mail className="h-3.5 w-3.5" /> {candidate.email}</a>
                    </CopyEmail>
                  )}
                  {candidate.phone && <span className="flex items-center gap-1"><Phone className="h-3.5 w-3.5" /> {candidate.phone}</span>}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {candidate.source && <Badge variant="outline">{sourceLabel(candidate.source)}{candidate.source_detail ? ` · ${candidate.source_detail}` : ""}</Badge>}
                  {/* No literal space after the icon - the badge already sets `gap-1`, and the stray one only
                      ends up at the front of the badge's own text. */}
                  {referredBy && <Badge variant="secondary" className="gap-1"><UserCheck className="h-3 w-3" />Referred by {referredBy.name}</Badge>}
                  {(candidate.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean).map((t) => <Badge key={t} variant="muted">{t}</Badge>)}
                </div>
              </div>
              {candidate.has_resume && (
                <AccessAction verb="download" collection="candidates" objectPath={`candidates/${id}`} can={candidate.access?.can} label="Download resume">
                  <Button variant="outline" size="sm" onClick={() => download(`candidates/${id}`, `resume-${candidate.name}`)}>
                    <Download className="h-3.5 w-3.5" /> Resume
                  </Button>
                </AccessAction>
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
                      <AccessItem key={a.path} collection="applications" objectPath={a.path} can={a.access?.can} label={reqTitle(a.requisition)}>
                      <Card className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
                        <span className="font-medium">{reqTitle(a.requisition)}</span>
                        <Badge variant={sm.variant}>{sm.label}</Badge>
                        {a.status === "active" && <Badge variant="outline">{stageLabel(a.stage)}</Badge>}
                        {a.status === "rejected" && a.rejection_reason && <span className="text-xs text-destructive">{a.rejection_reason}</span>}
                        <span className="ml-auto text-xs text-muted-foreground">
                          {a.applied_time ? `Applied ${formatDate(a.applied_time)}` : ""}
                          {days != null && days >= 1 ? ` · ${days}d in stage` : ""}
                        </span>
                      </Card>
                      </AccessItem>
                    );
                  })}
                </div>
              )}
            </section>

            {/* Interviews across all their applications. Rendered whenever they have applied at all, with an
                empty state rather than an absence: a hidden section says the same thing for "no interviews"
                and for "not loaded", and the reader cannot tell which they are looking at. */}
            {myApps.length > 0 && (
              <section>
                <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold"><CalendarClock className="h-4 w-4 text-muted-foreground" /> Interviews</h2>
                {myInterviews.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    {interviewsCropped ? "Some interviews could not be loaded here." : "No interviews scheduled."}
                  </p>
                )}
                <div className="grid gap-2">
                  {myInterviews.map((i) => {
                    const sm = meta(INTERVIEW_STATUS, i.status);
                    return (
                      <AccessItem key={i.path} collection="interviews" objectPath={i.path} can={i.access?.can} label={i.title}>
                      <Card className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
                        <span className="font-medium">{i.title}</span>
                        <Badge variant={sm.variant}>{sm.label}</Badge>
                        {i.scheduled_start_time && <span className="text-xs text-muted-foreground">{fmtWhen(i.scheduled_start_time)}</span>}
                        {(i.interviewers ?? []).length > 0 && (
                          <span className="ml-auto text-xs text-muted-foreground">{(i.interviewers ?? []).map((r) => empName(r)).join(", ")}</span>
                        )}
                      </Card>
                      </AccessItem>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Offers - same treatment, same reason. */}
            {myApps.length > 0 && (
              <section>
                <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold"><FileSignature className="h-4 w-4 text-muted-foreground" /> Offers</h2>
                {myOffers.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    {offersCropped ? "Some offers could not be loaded here." : "Nothing offered yet."}
                  </p>
                )}
                <div className="grid gap-2">
                  {myOffers.map((o) => {
                    const sm = meta(OFFER_STATUS, o.status);
                    return (
                      <AccessItem key={o.path} collection="offers" objectPath={o.path} can={o.access?.can} label="Offer">
                      <Card className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
                        {/* The offered figure, beside the candidate's name: masked in session replay for the
                            same reason the offers route is (instrument.ts). `candidates` is names and stages
                            rather than values, so the tag goes on the value rather than the whole route. */}
                        {o.base_comp != null && <span data-sentry-mask className="font-medium tabular-nums">{money(o.base_comp, o.currency_code || undefined)}</span>}
                        <Badge variant={sm.variant}>{sm.label}</Badge>
                        <span className="ml-auto text-xs text-muted-foreground">
                          {[
                            o.offer_time ? `Offered ${formatDate(o.offer_time)}` : "",
                            o.join_time ? `Joining ${formatDate(o.join_time)}` : "",
                            o.expiry_time && o.status === "extended" ? `${+new Date(o.expiry_time) < Date.now() ? "Expired" : "Expires"} ${formatDate(o.expiry_time)}` : "",
                          ].filter(Boolean).join(" · ")}
                        </span>
                      </Card>
                      </AccessItem>
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

            {/* Two trails, and the second is the one a recruiter means. `resource` is edits to the CANDIDATE
                record; the case walks the whole hire - the requisition, the application, every interview and
                its feedback, the offer, and the employee it produced - which no single record's trail sees. */}
            {candidate && <ActivitySection caseRoot={candidate.path} label="Hiring story" className="border-t pt-4" />}
            {candidate && <ActivitySection resource={candidate.path} label="Changes to this candidate" />}
          </div>
        )}
      </DataState>
    </div>
  );
}
