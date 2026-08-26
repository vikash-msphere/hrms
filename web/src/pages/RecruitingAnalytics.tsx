import { useMemo } from "react";
import { BarChart3, Briefcase, Users, UserCheck, FileSignature, Timer, KanbanSquare } from "lucide-react";
import { useCollection } from "@/hooks/useCollection";
import { idOf } from "@/lib/utils";
import { navigate } from "@/router";
import type { Me, Application, JobRequisition, Offer, Candidate } from "@/types";
import { Chart } from "@/components/common/Chart";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { Badge } from "@/components/ui/badge";
import { useAtsConfig, sourceLabel } from "./Candidates";

const DAY = 86_400_000;
// The offer donut's slices mean a STATE, so they take the state's own colour (the app's success / destructive
// / warning hues) rather than the next three in the categorical order - a green "declined" would be a lie.
const OFFER_COLORS = { accepted: "#1baf7a", declined: "#e34948", pending: "#eda100" };
// Matches the Pipeline board's own stall threshold, so the metric and the board agree on what "stalled" means.
const STALL_DAYS = 14;
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

    // Active applications nobody has moved in a fortnight: the number that explains a slipping time-to-hire.
    const stalled = active.filter((a) => (Date.now() - Date.parse(a.update_time ?? a.create_time ?? "")) / DAY > STALL_DAYS).length;

    return { active, hired, rejected, openReqs, funnel, sources, accepted, declined, extended, acceptRate, timeToHire, stalled };
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
              // Nothing on an analytics page is a list you can narrow, so each metric opens the page that owns
              // those rows, already focused on the same slice the number counted.
              { label: "Open jobs", value: m.openReqs.length, icon: Briefcase, hint: "open the jobs list", onClick: () => navigate("job-requisitions?focus=open") },
              { label: "Candidates", value: candidates.length, icon: Users, hint: "the talent pool", onClick: () => navigate("candidates") },
              { label: "Active applications", value: m.active.length, icon: KanbanSquare, tone: "primary", hint: "open the board", onClick: () => navigate("pipeline?focus=active") },
              ...(m.stalled
                ? [{ label: `Stalled over ${STALL_DAYS}d`, value: m.stalled, icon: Timer, tone: "warning" as const, hint: "no movement", onClick: () => navigate("pipeline?focus=stalled") }]
                : []),
              { label: "Hired", value: m.hired.length, icon: UserCheck, tone: m.hired.length ? "success" : "muted", hint: "in this window", onClick: () => navigate("pipeline?focus=hired") },
              { label: "Offer acceptance", value: `${m.acceptRate}%`, icon: FileSignature, hint: `${m.accepted} of ${m.accepted + m.declined} accepted`, onClick: () => navigate("offers?focus=accepted") },
              ...(m.extended
                ? [{ label: "Awaiting a reply", value: m.extended, icon: FileSignature, tone: "warning" as const, hint: "extended, no answer", onClick: () => navigate("offers?focus=extended") }]
                : []),
              // The average is computed over hired applications, so it opens exactly those.
              { label: "Avg time to hire", value: m.timeToHire != null ? `${m.timeToHire}d` : "-", icon: Timer, hint: m.timeToHire == null ? "no hires yet" : `over ${m.hired.length} hire${m.hired.length === 1 ? "" : "s"}`, ...(m.hired.length ? { onClick: () => navigate("pipeline?focus=hired") } : {}) },
            ]}
          />

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-lg border p-4">
              <p className="mb-1 text-sm font-medium">Pipeline funnel (active)</p>
              <p className="mb-3 text-xs text-muted-foreground">Where the live applications are sitting, in stage order.</p>
              {/* A percentage bar rather than a column chart: a funnel is a division of ONE quantity - the
                  people in play - and the question it answers is what share is stuck where. */}
              <Chart
                type="percentage"
                height={140}
                labels={m.funnel.map((f) => f.label)}
                datasets={[{ name: "Applications", values: m.funnel.map((f) => f.count) }]}
                ariaLabel="Active applications by pipeline stage"
                emptyText="No active applications right now. New applications land here as they enter the pipeline."
              />
            </div>

            <div className="rounded-lg border p-4">
              <p className="mb-1 text-sm font-medium">Offer outcomes</p>
              <p className="mb-3 text-xs text-muted-foreground">Every offer extended, by how it ended.</p>
              <Chart
                type="donut"
                height={200}
                labels={["Accepted", "Declined", "Awaiting a reply"]}
                datasets={[{ name: "Offers", values: [m.accepted, m.declined, m.extended] }]}
                colors={[OFFER_COLORS.accepted, OFFER_COLORS.declined, OFFER_COLORS.pending]}
                ariaLabel="Offers by outcome"
                emptyText="No offers yet."
              />
            </div>
          </div>

          <div className="rounded-lg border p-4">
            <p className="mb-3 text-sm font-medium">Source effectiveness</p>
            {m.sources.length > 0 && (
              // Applications beside hires, per source: the pair is the point (a channel that sends hundreds
              // and hires nobody looks identical to a good one on a chart of applications alone).
              <Chart
                className="mb-4"
                type="bar"
                height={Math.min(320, Math.max(160, m.sources.length * 34 + 60))}
                labels={m.sources.map((s) => candSource(s.source))}
                datasets={[
                  { name: "Applications", values: m.sources.map((s) => s.total) },
                  { name: "Hired", values: m.sources.map((s) => s.hired) },
                ]}
                ariaLabel="Applications and hires by source"
              />
            )}
            {m.sources.length === 0 ? (
              <p className="text-sm text-muted-foreground">No applications yet.</p>
            ) : (
              // Four columns, three of them numbers: one labelled block per source on a phone.
              <div className="scroll-shadow-x -mx-1 overflow-x-auto px-1 [--scroll-ground:hsl(var(--card))]">
              <table className="table-stack w-full text-sm sm:min-w-[22rem]">
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
                      <td data-label="Applications" className="py-1.5 text-right tabular-nums">{s.total}</td>
                      <td data-label="Hired" className="py-1.5 text-right tabular-nums">{s.hired}</td>
                      <td data-label="Conversion" className="py-1.5 text-right tabular-nums"><Badge variant="secondary">{pct(s.hired, s.total)}%</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </div>
        </div>
        )}
      </DataState>
    </div>
  );
}
