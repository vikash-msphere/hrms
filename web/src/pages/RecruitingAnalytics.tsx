import { useMemo } from "react";
import { BarChart3, Briefcase, Users, UserCheck, FileSignature, Timer, KanbanSquare } from "lucide-react";
import { useCollection } from "@/hooks/useCollection";
import { idOf } from "@/lib/utils";
import type { Me, Application, JobRequisition, Offer, Candidate } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { Badge } from "@/components/ui/badge";
import { useAtsConfig, sourceLabel } from "./Candidates";

const DAY = 86_400_000;
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);

export default function RecruitingAnalytics({ me: _me }: { me: Me }) {
  const { rows: apps, state, error, reload } = useCollection<Application>("applications");
  const { rows: reqs } = useCollection<JobRequisition>("job-requisitions");
  const { rows: offers } = useCollection<Offer>("offers");
  const { rows: candidates } = useCollection<Candidate>("candidates");
  const cfg = useAtsConfig();

  const m = useMemo(() => {
    const active = apps.filter((a) => a.status === "active");
    const hired = apps.filter((a) => a.status === "hired");
    const rejected = apps.filter((a) => a.status === "rejected" || a.status === "withdrawn");
    const openReqs = reqs.filter((r) => r.status === "open");

    // Funnel: active applications by stage (in the configured order).
    const funnel = cfg.stages.map((s) => ({ label: s.label, count: apps.filter((a) => a.stage === s.key && a.status === "active").length }));

    // Source effectiveness: applications + hires grouped by source.
    const bySource = new Map<string, { total: number; hired: number }>();
    for (const a of apps) {
      const key = a.source || "unknown";
      const e = bySource.get(key) ?? { total: 0, hired: 0 };
      e.total++; if (a.status === "hired") e.hired++;
      bySource.set(key, e);
    }
    const sources = [...bySource.entries()].map(([k, v]) => ({ source: k, ...v })).sort((a, b) => b.total - a.total);

    // Offer acceptance rate.
    const accepted = offers.filter((o) => o.status === "accepted").length;
    const declined = offers.filter((o) => o.status === "declined").length;
    const extended = offers.filter((o) => o.status === "extended").length;
    const acceptRate = pct(accepted, accepted + declined);

    // Time-to-hire: mean days from applied to hired (stage_changed_time), over hired applications with both stamps.
    const spans = hired
      .map((a) => (a.applied_time && a.stage_changed_time ? (+new Date(a.stage_changed_time) - +new Date(a.applied_time)) / DAY : null))
      .filter((x): x is number => x != null && x >= 0);
    const timeToHire = spans.length ? Math.round(spans.reduce((s, x) => s + x, 0) / spans.length) : null;

    const maxFunnel = Math.max(1, ...funnel.map((f) => f.count));
    return { active, hired, rejected, openReqs, funnel, sources, accepted, declined, extended, acceptRate, timeToHire, maxFunnel };
  }, [apps, reqs, offers, cfg]);

  const candSource = (key: string) => (key === "unknown" ? "Unknown" : sourceLabel(key));

  return (
    <div>
      {/* Read-only rollup of applications; the header icon manages read access to the underlying collection. */}
      <PageHeader accessCollection="applications" title="Recruiting analytics" description="Pipeline funnel, source effectiveness, and offer outcomes across your open jobs." />

      <DataState state={state} error={error} onRetry={reload}>
        {apps.length === 0 && reqs.length === 0 && candidates.length === 0 ? (
          <EmptyState icon={BarChart3} title="No recruiting activity yet" description="Open a job and add candidates; the funnel, source, and offer numbers build themselves from there." />
        ) : (
        <div className="space-y-6">
          <SummaryStrip
            items={[
              { label: "Open jobs", value: m.openReqs.length, icon: Briefcase },
              { label: "Candidates", value: candidates.length, icon: Users },
              { label: "Active applications", value: m.active.length, icon: KanbanSquare, tone: "primary" },
              { label: "Hired", value: m.hired.length, icon: UserCheck, tone: m.hired.length ? "success" : "muted" },
              { label: "Offer acceptance", value: `${m.acceptRate}%`, icon: FileSignature, hint: `${m.accepted} accepted · ${m.declined} declined${m.extended ? ` · ${m.extended} awaiting reply` : ""}` },
              { label: "Avg time to hire", value: m.timeToHire != null ? `${m.timeToHire}d` : "-", icon: Timer, hint: m.timeToHire == null ? "no hires yet" : undefined },
            ]}
          />

          <div className="rounded-lg border p-4">
            <p className="mb-3 text-sm font-medium">Pipeline funnel (active)</p>
            {m.active.length === 0 ? (
              <p className="text-sm text-muted-foreground">No active applications right now. New applications land here as they enter the pipeline.</p>
            ) : (
              <div className="space-y-2">
                {m.funnel.map((f) => (
                  <div key={f.label} className="flex items-center gap-3">
                    <div className="w-28 shrink-0 text-sm text-muted-foreground">{f.label}</div>
                    <div className="h-6 flex-1 rounded bg-muted/40">
                      <div className="h-6 rounded bg-primary/70" style={{ width: `${pct(f.count, m.maxFunnel)}%`, minWidth: f.count ? "0.375rem" : 0 }} />
                    </div>
                    <div className="w-8 shrink-0 text-right text-sm tabular-nums text-muted-foreground">{f.count}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-lg border p-4">
            <p className="mb-3 text-sm font-medium">Source effectiveness</p>
            {m.sources.length === 0 ? (
              <p className="text-sm text-muted-foreground">No applications yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead><tr className="border-b text-left text-muted-foreground">
                  <th className="py-1 font-medium">Source</th>
                  <th className="py-1 font-medium text-right">Applications</th>
                  <th className="py-1 font-medium text-right">Hired</th>
                  <th className="py-1 font-medium text-right">Conversion</th>
                </tr></thead>
                <tbody>
                  {m.sources.map((s) => (
                    <tr key={s.source} className="border-b last:border-0">
                      <td className="py-1.5">{candSource(s.source)}</td>
                      <td className="py-1.5 text-right tabular-nums">{s.total}</td>
                      <td className="py-1.5 text-right tabular-nums">{s.hired}</td>
                      <td className="py-1.5 text-right tabular-nums"><Badge variant="secondary">{pct(s.hired, s.total)}%</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
        )}
      </DataState>
    </div>
  );
}
