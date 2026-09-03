import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, BarChart3, ChevronRight, Info, TriangleAlert, Users } from "lucide-react";
import { get } from "@/api";
import { navigate } from "@/router";
import { useRoute, setQueryParams } from "@/router";
import { idOf, cn } from "@/lib/utils";
import { usePermission } from "@/lib/perm";
import { useCollection } from "@/hooks/useCollection";
import type { Department, Me } from "@/types";
import {
  HIGHLIGHT_METRICS,
  RANGE_LABELS,
  TONE_CLASS,
  formatMetric,
  rangeFor,
  toneFor,
  type AnalyticsResponse,
  type MetricDef,
  type PersonRow,
  type RangeKey,
} from "@/lib/analytics";
import { exportTable } from "@/lib/exportTable";
import { Chart } from "@/components/common/Chart";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { ExportButton } from "@/components/common/ExportButton";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { PersonAvatar } from "@/components/common/PersonAvatar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

// One page for "how is my team actually doing" - a row per person, a column per measure, over one window.
//
// Everything on it comes from a single server request (`GET /v1/people-analytics`), which aggregates each
// measure inside the collection that owns it and under the caller's own access to that collection. So the
// page holds no rules: it cannot compute a number the server did not send, and a column the viewer may not
// see never arrives. An employee opening this sees one row - their own report.

const DAY_MS = 86_400_000;

export default function TeamAnalytics({ me }: { me: Me }) {
  const route = useRoute();
  const canExport = usePermission("export.read");
  const { rows: depts } = useCollection<Department>("departments");

  // The window and the department live in the URL, so a narrowed report is a link somebody can send.
  const rangeKey = (route.query.range as RangeKey) ?? "this_month";
  const preset = useMemo(() => rangeFor(rangeKey === "custom" ? "this_month" : rangeKey), [rangeKey]);
  const from = route.query.from ?? preset.from;
  const to = route.query.to ?? preset.to;
  const dept = route.query.department ?? "";
  const [group, setGroup] = useState("overview");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(null);
  const [open, setOpen] = useState<PersonRow | null>(null);

  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let live = true;
    setState("loading");
    const params = new URLSearchParams({ from, to, max_people: "200" });
    if (dept) params.set("department", `departments/${dept}`);
    get<AnalyticsResponse>(`people-analytics?${params}`)
      .then((r) => { if (live) { setData(r); setState("ready"); setError(null); } })
      .catch((e: unknown) => { if (live) { setState("error"); setError(e instanceof Error ? e.message : String(e)); } });
    return () => { live = false; };
  }, [from, to, dept, reloadKey]);

  const metrics = data?.metrics ?? [];
  const groups = useMemo(() => {
    const present = new Set(metrics.map((m) => m.group));
    return [{ key: "overview", label: "Overview" }, ...(data?.groups ?? []).filter((g) => present.has(g.key))];
  }, [data, metrics]);
  // The overview keeps the highlight order rather than the catalogue order, so the first columns are the ones
  // the tab exists for; a dimension tab shows everything it holds.
  const columns: MetricDef[] = useMemo(() => {
    if (group !== "overview") return metrics.filter((m) => m.group === group);
    const byKey = new Map(metrics.map((m) => [m.key, m]));
    return HIGHLIGHT_METRICS.map((k) => byKey.get(k)).filter((m): m is MetricDef => !!m);
  }, [metrics, group]);

  const deptName = useMemo(() => {
    const m = new Map(depts.map((d) => [idOf(d.path), d.display_name]));
    return (p?: string | null) => (p ? m.get(idOf(p)) : undefined);
  }, [depts]);

  const people = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = (data?.people ?? []).filter(
      (p) => !q || p.name.toLowerCase().includes(q) || (p.employee_number ?? "").toLowerCase().includes(q) || (p.job_title ?? "").toLowerCase().includes(q),
    );
    if (!sort) return rows;
    // Somebody with no number for a measure sorts last either way: they are not the best performer on a
    // column they have no reading for, and not the worst either.
    return [...rows].sort((a, b) => {
      const x = a.values[sort.key];
      const y = b.values[sort.key];
      if (x == null && y == null) return a.name.localeCompare(b.name);
      if (x == null) return 1;
      if (y == null) return -1;
      return sort.dir === "asc" ? x - y : y - x;
    });
  }, [data, query, sort]);

  // The measure the comparison chart draws: whatever the table is sorted by, else the first column of the
  // tab, unless the reader has picked one explicitly. Twenty-odd bars is the most a chart this size can say,
  // so a long roster is charted head-first (by the measure itself) and the table keeps everyone.
  const [chartKey, setChartKey] = useState<string | null>(null);
  const chartMetric = useMemo(
    () => columns.find((c) => c.key === chartKey) ?? columns.find((c) => c.key === sort?.key) ?? columns[0] ?? null,
    [columns, chartKey, sort],
  );
  const chartPeople = useMemo(() => {
    if (!chartMetric) return [];
    const withValue = people.filter((p) => p.values[chartMetric.key] != null);
    // Already ordered by this measure (the table is sorted by it) - keep the reader's order.
    if (withValue.length <= 20 || sort?.key === chartMetric.key) return withValue.slice(0, 20);
    // Otherwise the twenty biggest numbers: on a "lower is better" measure those are the ones worth looking
    // at, and on any other they are the leaders. Either way it is the top of the distribution, not a slice
    // of the alphabet.
    return [...withValue].sort((a, b) => (b.values[chartMetric.key] ?? 0) - (a.values[chartMetric.key] ?? 0)).slice(0, 20);
  }, [people, chartMetric, sort]);

  const setRange = (key: RangeKey) => {
    if (key === "custom") { setQueryParams({ range: "custom", from, to }); return; }
    const r = rangeFor(key);
    setQueryParams({ range: key, from: r.from, to: r.to });
  };
  const setCustom = (patch: { from?: string; to?: string }) => setQueryParams({ range: "custom", ...patch });

  const toggleSort = (key: string) =>
    setSort((s) => (s?.key === key ? (s.dir === "desc" ? { key, dir: "asc" } : null) : { key, dir: "desc" }));

  const onExport = (format: "csv" | "xlsx") => {
    const headers = ["Name", "Employee number", "Job title", "Department", ...columns.map((c) => c.label)];
    const rows = people.map((p) => [
      p.name,
      p.employee_number ?? "",
      p.job_title ?? "",
      deptName(p.department) ?? "",
      ...columns.map((c) => p.values[c.key] ?? ""),
    ]);
    void exportTable(`team-analytics-${from}-to-${to}`, headers, rows, format, "employees");
  };

  const windowDays = Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;

  return (
    <div>
      {/* A rollup over people: the header icon manages read access to the directory the rows come from - every
          measure is separately gated by the collection it was read from. */}
      <PageHeader
        eyebrow="People"
        accessCollection="employees"
        title="Team analytics"
        description="Everyone you can see, on one page: attendance and punctuality, leave, tasks and goals, performance and effort over a window you choose."
        actions={<ExportButton canExport={canExport} label="Export this report" onExport={onExport} disabled={!people.length} />}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select value={rangeKey} onValueChange={(v) => setRange(v as RangeKey)}>
          <SelectTrigger className="h-9 w-40" aria-label="Reporting window"><SelectValue /></SelectTrigger>
          <SelectContent>
            {RANGE_LABELS.map((r) => <SelectItem key={r.key} value={r.key}>{r.label}</SelectItem>)}
          </SelectContent>
        </Select>
        {rangeKey === "custom" && (
          <div className="flex items-center gap-1.5">
            <Input type="date" value={from} max={to} onChange={(e) => setCustom({ from: e.target.value })} className="h-9 w-40" aria-label="From" />
            <span className="text-sm text-muted-foreground">to</span>
            <Input type="date" value={to} min={from} onChange={(e) => setCustom({ to: e.target.value })} className="h-9 w-40" aria-label="To" />
          </div>
        )}
        <Select value={dept || "all"} onValueChange={(v) => setQueryParams({ department: v === "all" ? null : v })}>
          <SelectTrigger className="h-9 w-48" aria-label="Department"><SelectValue placeholder="All departments" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All departments</SelectItem>
            {depts.map((d) => <SelectItem key={d.path} value={idOf(d.path)}>{d.display_name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a person"
          className="h-9 w-full sm:w-56"
          aria-label="Find a person"
        />
        {windowDays > 92 && <span className="text-sm text-destructive">Pick a window of 92 days or less.</span>}
      </div>

      <DataState state={state} error={error} onRetry={() => setReloadKey((k) => k + 1)}>
        {!data || data.people.length === 0 ? (
          <EmptyState
            icon={Users}
            title="Nobody to report on"
            description="Nobody you can see was employed during this window. Widen the dates, or clear the department filter."
          />
        ) : metrics.length === 0 ? (
          <EmptyState
            icon={BarChart3}
            title="No measures you can see"
            description="Every column here comes from a module you have read access to - attendance, leave, boards, goals, reviews, timesheets. Ask an admin for access to one of them."
          />
        ) : (
          <>
            {/* One measure across the whole team, next to the team line it is being judged against. The table
                below answers "what are this person's numbers"; a column of thirty numbers does not answer
                "who is the outlier", which is the question a report like this is usually opened with. */}
            {chartMetric && (
              <div className="mb-6 rounded-xl border bg-card p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{chartMetric.label}</p>
                    <p className="text-xs text-muted-foreground">{chartMetric.hint}</p>
                  </div>
                  <Select value={chartMetric.key} onValueChange={(v) => setChartKey(v)}>
                    <SelectTrigger className="h-8 w-52" aria-label="Measure to compare"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {columns.map((c) => <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <Chart
                  type="bar"
                  height={Math.min(360, Math.max(180, chartPeople.length * 26 + 60))}
                  labels={chartPeople.map((p) => p.name)}
                  datasets={[{ name: chartMetric.short, values: chartPeople.map((p) => p.values[chartMetric.key] ?? 0) }]}
                  markers={data.team[chartMetric.key] != null ? [{ label: "Team", value: data.team[chartMetric.key]! }] : undefined}
                  format={(v) => formatMetric(v, chartMetric.unit)}
                  ariaLabel={`${chartMetric.label} for each person, ${data.window.from} to ${data.window.to}`}
                  onSelect={(i) => { const p = chartPeople[i]; if (p) setOpen(p); }}
                  emptyText="Nobody has a number for this measure in this window."
                />
                {chartPeople.length < people.length && (
                  <p className="mt-2 text-xs text-muted-foreground">Showing the top {chartPeople.length} of {people.length} people — the table below has everyone.</p>
                )}
              </div>
            )}

            {/* A team figure here re-groups and re-sorts the table, so the strip sits with the table - below
                the chart. */}
            <SummaryStrip
              items={[
                { label: "People", value: data.people.length, icon: Users, hint: `${data.window.working_days} working days in the window` },
                ...HIGHLIGHT_METRICS.flatMap((key) => {
                  const m = metrics.find((x) => x.key === key);
                  if (!m || data.team[key] == null) return [];
                  return [{
                    label: m.agg === "avg" ? `Avg ${m.label.toLowerCase()}` : m.label,
                    value: formatMetric(data.team[key], m.unit),
                    hint: m.agg === "avg" ? "team average" : "team total",
                    onClick: () => { setGroup(m.group); toggleSort(m.key); },
                  }];
                }),
              ]}
            />

            <div className="mb-3 flex flex-wrap gap-1.5">
              {groups.map((g) => (
                <button
                  key={g.key}
                  type="button"
                  onClick={() => setGroup(g.key)}
                  className={cn(
                    "min-h-[36px] rounded-full border px-3 py-1.5 text-sm coarse:min-h-[44px]",
                    group === g.key ? "border-primary bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-accent",
                  )}
                >
                  {g.label}
                </button>
              ))}
            </div>

            <div className="scroll-shadow-x -mx-1 overflow-x-auto px-1 [--scroll-ground:hsl(var(--background))]">
              <table className="table-stack w-full text-sm sm:min-w-[40rem]">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="sticky left-0 z-10 bg-background py-2 pr-3 font-medium">Person</th>
                    {columns.map((c) => (
                      <th key={c.key} className="py-2 pl-3 text-right font-medium">
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                onClick={() => toggleSort(c.key)}
                                className="inline-flex min-h-[36px] items-center gap-1 whitespace-nowrap hover:text-foreground coarse:min-h-[44px]"
                              >
                                {c.short}
                                {sort?.key === c.key ? (
                                  sort.dir === "desc" ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />
                                ) : (
                                  <Info className="h-3 w-3 opacity-40" />
                                )}
                              </button>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs"><p className="font-medium">{c.label}</p><p className="text-xs">{c.hint}</p></TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {people.map((p) => (
                    <tr key={p.employee} className="border-b last:border-0 hover:bg-accent/40">
                      <td className="sticky left-0 z-10 bg-background py-2 pr-3">
                        <button type="button" onClick={() => setOpen(p)} className="flex min-h-[36px] items-center gap-2 text-left coarse:min-h-[44px]">
                          <PersonAvatar name={p.name} className="h-7 w-7 text-xs" />
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{p.name}</span>
                            <span className="block truncate text-xs text-muted-foreground">{p.job_title || deptName(p.department) || p.employee_number || ""}</span>
                          </span>
                        </button>
                      </td>
                      {columns.map((c) => {
                        const tone = toneFor(p.values[c.key], data.team[c.key], c.direction);
                        return (
                          <td key={c.key} data-label={c.short} className={cn("py-2 pl-3 text-right tabular-nums", tone && TONE_CLASS[tone])}>
                            {formatMetric(p.values[c.key], c.unit)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  {people.length > 1 && (
                    <tr className="border-t-2 font-medium">
                      <td className="sticky left-0 z-10 bg-background py-2 pr-3">Team</td>
                      {columns.map((c) => (
                        <td key={c.key} data-label={`Team ${c.short}`} className="py-2 pl-3 text-right tabular-nums">
                          {formatMetric(data.team[c.key], c.unit)}
                        </td>
                      ))}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {people.length === 0 && (
              <p className="mt-4 text-sm text-muted-foreground">Nobody matches "{query}".</p>
            )}
            {data.truncated && (
              <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>More people are in scope than this report covers — it stops at 200. Pick a department to see the rest.</span>
              </div>
            )}
          </>
        )}
      </DataState>

      <Sheet open={!!open} onOpenChange={(o) => { if (!o) setOpen(null); }}>
        {open && data && <PersonReport person={open} data={data} deptName={deptName} me={me} />}
      </Sheet>
    </div>
  );
}

// One person's whole report, grouped the way the catalogue groups it - the same numbers the row shows, plus
// the ones the current tab left out.
function PersonReport({ person, data, deptName, me }: {
  person: PersonRow;
  data: AnalyticsResponse;
  deptName: (p?: string | null) => string | undefined;
  me: Me;
}) {
  const id = idOf(person.employee);
  const mine = me.employee_id === id;
  const byGroup = data.groups
    .map((g) => ({ ...g, metrics: data.metrics.filter((m) => m.group === g.key) }))
    .filter((g) => g.metrics.length > 0);

  return (
    <SheetContent className="flex flex-col sm:max-w-lg">
      <SheetHeader>
        <SheetTitle className="flex items-center gap-3 pr-6">
          <PersonAvatar name={person.name} />
          <span className="min-w-0">
            <span className="block truncate">{person.name}</span>
            <span className="block truncate text-sm font-normal text-muted-foreground">
              {[person.job_title, deptName(person.department), person.employee_number].filter(Boolean).join(" · ")}
            </span>
          </span>
        </SheetTitle>
        <p className="mt-1 text-xs text-muted-foreground">
          {data.window.from} to {data.window.to} · {data.window.working_days} working days
        </p>
      </SheetHeader>
      <SheetBody className="space-y-5">
        {byGroup.map((g) => (
          <div key={g.key}>
            <p className="mb-2 text-sm font-medium">{g.label}</p>
            <dl className="space-y-1.5">
              {g.metrics.map((m) => {
                const tone = toneFor(person.values[m.key], data.team[m.key], m.direction);
                return (
                  <div key={m.key} className="flex items-baseline justify-between gap-3">
                    <dt className="min-w-0 text-sm text-muted-foreground">
                      <span className="block truncate">{m.label}</span>
                      <span className="block text-xs opacity-80">{m.hint}</span>
                    </dt>
                    <dd className="shrink-0 text-right">
                      <span className={cn("tabular-nums", tone && TONE_CLASS[tone])}>{formatMetric(person.values[m.key], m.unit)}</span>
                      <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                        team {formatMetric(data.team[m.key], m.unit)}
                      </span>
                    </dd>
                  </div>
                );
              })}
            </dl>
          </div>
        ))}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={() => navigate(`employees/${id}`)}>
            {mine ? "My profile" : "Open profile"} <ChevronRight className="ml-1 h-3.5 w-3.5" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => navigate(`employees/${id}/leave`)}>
            Leave history <ChevronRight className="ml-1 h-3.5 w-3.5" />
          </Button>
          {person.manager && <Badge variant="secondary">Reports to {idOf(person.manager) === me.employee_id ? "you" : "a manager you can see"}</Badge>}
        </div>
      </SheetBody>
    </SheetContent>
  );
}
