import { useMemo, useState } from "react";
import { Banknote, CalendarDays, Download, Eye, Sigma } from "lucide-react";
import { RupeeCircle } from "@/components/icons/RupeeCircle";
import { download } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { cn, formatDate, formatMoney, idOf, personName } from "@/lib/utils";
import { orgDayOf, thisYearStr } from "@/lib/orgDay";
import { useOrg, currencyDecimals } from "@/lib/org";
import { usePermission } from "@/lib/perm";
import type { Department, Employee, Me, PayPeriod, Payslip, PayrollRun } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { PageSettings } from "@/components/common/SettingsButton";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { TruncationNotice } from "@/components/common/TruncationNotice";
import { Chart, ChartCard } from "@/components/common/Chart";
import { DataTable, type Column } from "@/components/common/DataTable";
import type { TableInsight } from "@/components/common/TableInsights";
import { FilterChip } from "@/components/common/FilterChips";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { PdfPreviewDialog, type PdfSource } from "@/components/common/PdfPreviewDialog";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { useToast } from "@/components/ui/use-toast";

// How far a person's net pay has to move, month on month, before it is worth a second look. Not a policy
// number: a promotion, a bonus and a full month after a part one all clear it legitimately. It is the
// threshold at which somebody should be able to say WHY, which is the whole job of the chip it feeds.
const NET_SWING_PCT = 20;
// A take-home this low means more than half of gross came off. Legitimate with a loan recovery or an arrears
// recovery running; a deduction attached to the wrong person otherwise, and that is the one worth catching
// before the money leaves.
const LOW_TAKE_HOME_PCT = 50;

export default function Payslips({ me }: { me: Me }) {
  const { rows: raw, state, error, reload } = useCollection<Payslip>("payslips");
  const { toast } = useToast();
  const { org } = useOrg();
  const money = (n: number) => formatMoney(n, org.default_currency, currencyDecimals(undefined, org));
  const [busy, setBusy] = useState<string | null>(null);

  // Newest first - the payslip you came for is almost always the latest one.
  const rows = useMemo(
    () => [...raw].sort((a, b) => (b.create_time ?? "").localeCompare(a.create_time ?? "")),
    [raw],
  );
  // WHOSE SLIPS ARE THESE. The same page serves two callers: an employee, whose every row is their own, and
  // payroll, whose grant is org-wide and whose list is therefore everybody. Everything on the page that is
  // phrased in the first person - the latest-payslip buttons, the pay chart, the year-to-date totals - is
  // computed from `mine` rather than from the whole list, because summing the company's net pay under a tile
  // labelled "Net paid in 2026" is not a smaller version of the right answer, it is a different number.
  const mine = useMemo(
    () => (me.employee_id ? rows.filter((s) => s.employee && idOf(s.employee) === me.employee_id) : []),
    [rows, me.employee_id],
  );
  // True once the list reaches past the viewer: the page is then a payroll view of other people, which is what
  // turns the employee column on and what pays for the directory read below.
  const spansOthers = rows.length > mine.length;
  // Names for that column. Read only when there is somebody else to name - an employee looking at their own
  // dozen slips should not pull the whole directory for a column that would say their own name.
  const { rows: employees } = useCollection<Employee>("employees", { all: true, enabled: spansOthers });
  // Named through the shared `personName`, not a fallback written here: it is what makes an unresolvable ref
  // read as a word instead of the raw uuid. The index is the whole employee row rather than `personIndex`'s
  // PersonRef because the cell shows a face too, and it is built once - a column accessor runs per row per
  // compare during a sort (lib/utils.ts).
  const empIdx = useMemo(() => new Map(employees.map((e) => [idOf(e.path), e])), [employees]);
  const empName = (ref?: string) => personName(empIdx, ref, "Employee");
  const emp = (ref?: string) => (ref ? empIdx.get(idOf(ref)) : undefined);
  // Department names, on the same terms as the employee names above: read only when the list is somebody
  // else's, because the column they feed says nothing on a person's own dozen slips.
  const { rows: departments } = useCollection<Department>("departments", { all: true, enabled: spansOthers });
  const deptIdx = useMemo(() => new Map(departments.map((d) => [idOf(d.path), d.display_name])), [departments]);
  const deptName = (ref?: string) => (ref ? deptIdx.get(idOf(ref)) ?? "" : "");
  // WHICH RUN PAID A SLIP, in the words a run is known by rather than its id. Only for a caller who can read
  // payroll runs - an employee cannot, and a uuid in a column headed "Pay run" answered nothing for them
  // anyway, so the column is not offered at all there. Both reads are ordinary collection pages (a run and a
  // period per month) and are shared with the Payroll page through the resource store.
  const canRuns = usePermission("payroll-runs.read");
  const { rows: runs } = useCollection<PayrollRun>("payroll-runs", { enabled: canRuns });
  const { rows: periods } = useCollection<PayPeriod>("pay-periods", { enabled: canRuns });
  const runLabel = useMemo(() => {
    const periodName = new Map(periods.map((p) => [idOf(p.path), p.display_name || p.period_start || ""]));
    const m = new Map(runs.map((r) => [idOf(r.path), (r.pay_period && periodName.get(idOf(r.pay_period))) || ""]));
    // The id is the honest fallback: a run whose period was purged, or one past the page these reads loaded.
    return (ref?: string) => (ref ? m.get(idOf(ref)) || idOf(ref) : "-");
  }, [runs, periods]);
  const latest = mine[0];
  // WHICH YEAR A PAYSLIP BELONGS TO, on the org's clock. One definition, used by the YTD figures, the year
  // chips, the table filter and the chart labels, so the four cannot disagree about the same slip.
  //
  // `create_time` is a UTC instant, so its first four characters are the UTC year - comparing that against the
  // org's year (thisYearStr) mixed the two clocks this page was already trying not to mix. In an IST org a
  // payslip published at 02:00 on 1 January carries `2025-12-31T20:30:00Z`: it was excluded from the year it
  // was issued in, there was no "2026" chip to find it under, and "Net paid in 2026" read zero next to a
  // clickable tile that filtered the table to nothing. West of UTC it runs the other way and lasts all evening.
  // `orgDayOf` (lib/orgDay) is the instant-to-org-day conversion that already existed for exactly this.
  const yearOf = (s: Payslip) => (s.create_time ? orgDayOf(s.create_time).slice(0, 4) : "");
  // Net paid so far this calendar year - the VIEWER's own, never the org's (see `mine` above).
  const ytd = useMemo(() => {
    const year = thisYearStr();
    const slips = mine.filter((s) => yearOf(s) === year);
    const net = slips.reduce((sum, s) => sum + (s.net ?? 0), 0);
    return {
      net,
      count: slips.length,
      // Tax withheld so far and the typical month: the two numbers people open a payslip page to work out.
      tax: slips.reduce((sum, s) => sum + (s.tax ?? 0), 0),
      avgNet: slips.length ? Math.round(net / slips.length) : 0,
    };
  }, [mine]);
  const thisYear = thisYearStr();
  // Year filter chips - only shown once the history spans more than one calendar year.
  const years = useMemo(
    () => [...new Set(rows.map(yearOf).filter(Boolean))].sort().reverse(),
    [rows],
  );
  // The last two years at most: a pay history chart is read for the trend, and thirty labels on a phone is
  // no trend at all. Oldest first, because time runs that way even though the table below does not.
  const payChart = useMemo(() => {
    const recent = [...mine].reverse().slice(-24);
    return {
      // Each point IS a payslip, so pressing one opens that slip rather than filtering a list down to it.
      slips: recent,
      // Labelled on the ORG's calendar too, via the same day conversion the buckets use - drawn through the
      // viewer's local clock, the slip the YTD filter files under one year could be plotted as the next.
      labels: recent.map((s) => (s.create_time ? new Date(`${orgDayOf(s.create_time)}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" }) : "")),
      gross: recent.map((s) => Math.round(s.gross ?? 0)),
      net: recent.map((s) => Math.round(s.net ?? 0)),
    };
  }, [mine]);

  // WHAT CHANGED SINCE LAST MONTH, per person. Payroll's own check on a run is not "is this number large",
  // it is "did anybody's pay move when nothing about them moved" - a component left on, a deduction dropped, a
  // pro-rata applied twice. The comparison is against the same employee's PREVIOUS slip by issue date, over
  // every loaded row rather than the filtered set, so narrowing to one month does not take the thing being
  // compared against off the page.
  const prevNet = useMemo(() => {
    const byEmployee = new Map<string, Payslip[]>();
    for (const s of rows) {
      const key = s.employee ? idOf(s.employee) : "";
      const bucket = byEmployee.get(key);
      if (bucket) bucket.push(s);
      else byEmployee.set(key, [s]);
    }
    const out = new Map<string, number>();
    for (const slips of byEmployee.values()) {
      const chronological = [...slips].sort((a, b) => (a.create_time ?? "").localeCompare(b.create_time ?? ""));
      for (let i = 1; i < chronological.length; i++) {
        out.set(chronological[i]!.path, chronological[i - 1]!.net ?? 0);
      }
    }
    return out;
  }, [rows]);
  /** How far this slip's net moved from the one before it, as a percentage. `null` for a first slip. */
  const netSwing = (s: Payslip): number | null => {
    const before = prevNet.get(s.path);
    if (before == null || before === 0) return null;
    return ((s.net ?? 0) - before) / before * 100;
  };
  /** What came off, as a share of gross. The shape of a payslip in one number. */
  const takeHome = (s: Payslip): number | null => (s.gross ? ((s.net ?? 0) / s.gross) * 100 : null);

  // What payroll would say out loud on opening a published run. Both chips are checks on the RUN rather than
  // facts about pay, and both are only worth offering to somebody who sees other people's slips: on your own
  // history "your pay changed in April" is not news, it is your April.
  const payslipInsights = (slips: Payslip[]): TableInsight[] => {
    if (!spansOthers) return [];
    const out: TableInsight[] = [];
    const swung = slips.filter((s) => { const v = netSwing(s); return v != null && Math.abs(v) >= NET_SWING_PCT; });
    if (swung.length > 0) {
      out.push({
        id: "net-swing",
        label: `${swung.length} whose net moved over ${NET_SWING_PCT}%`,
        tone: "warning",
        hint: "Against the same person's previous payslip. A raise or a part month explains it; nothing else should.",
        filters: { net_swing: `>=${NET_SWING_PCT}` },
        sort: "net_swing.desc",
      });
    }
    const low = slips.filter((s) => { const v = takeHome(s); return v != null && v < LOW_TAKE_HOME_PCT; });
    if (low.length > 0) {
      out.push({
        id: "low-take-home",
        label: `${low.length} taking home under ${LOW_TAKE_HOME_PCT}%`,
        tone: "warning",
        hint: "More than half of gross came off. Usually a recovery running, sometimes a deduction on the wrong person.",
        filters: { take_home: `<${LOW_TAKE_HOME_PCT}` },
        sort: "take_home.asc",
      });
    }
    return out;
  };

  const [year, setYear] = useState<string>("all");
  // Whose rows the table shows. Only ever moves off "all" for a caller whose list reaches past themselves -
  // it is what the year-to-date tiles drill into, since those are summed from the viewer's OWN slips and a
  // drill-through that landed on everybody's would not be the set the figure came from.
  const [who, setWho] = useState<"all" | "mine">("all");
  const mineIds = useMemo(() => new Set(mine.map((s) => s.path)), [mine]);
  const visible = useMemo(
    () => rows.filter((s) => (year === "all" || yearOf(s) === year) && (who === "all" || mineIds.has(s.path))),
    [rows, year, who, mineIds],
  );
  /** What a year-to-date tile drills into: this year, and only the slips the tile was summed from. */
  const focusYtd = () => { setYear(thisYear); setWho("mine"); };
  const ytdActive = year === thisYear && (!spansOthers || who === "mine");

  // Read it in the app instead of saving a copy. `preview` is its own custom method with its own scope, so a
  // caller may hold one, both, or neither - the row's access.can hint says which.
  const [preview, setPreview] = useState<PdfSource | null>(null);
  function onPreview(s: Payslip) {
    const day = (s.create_time ?? "").slice(0, 10);
    setPreview({
      path: `payslips/${idOf(s.path)}`,
      verb: "preview",
      title: "Payslip",
      description: `Issued ${formatDate(s.create_time)} · net ${money(s.net)}`,
      fileName: `payslip-${day || idOf(s.path)}.pdf`,
      allowSave: !!s.access?.can?.includes("download"),
    });
  }

  async function onDownload(s: Payslip) {
    const id = idOf(s.path);
    setBusy(id);
    try {
      // Name the file by issue date so a Downloads folder full of payslips stays legible.
      const day = (s.create_time ?? "").slice(0, 10);
      await download(`payslips/${id}`, `payslip-${day || id}.pdf`);
    } catch (e) {
      toast({ title: "Download failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  const columns: Column<Payslip>[] = [
    { id: "date", header: "Issued", filter: "date", dateHint: "past", accessor: (s) => s.create_time, cell: (s) => formatDate(s.create_time) },
    // Shown by default exactly when it says something: on a payroll caller's list, whose rows are other
    // people. On an employee's own list every row would read their own name, so it stays in the column picker.
    {
      id: "employee",
      header: "Employee",
      defaultHidden: !spansOthers,
      filter: "select",
      groupBy: true,
      accessor: (s) => empName(s.employee),
      // Face and name, the way every other per-person table in the app names somebody (Overtime, Remote work).
      cell: (s) => (
        <span className="inline-flex items-center gap-2">
          <PhotoAvatar employeeId={s.employee ? idOf(s.employee) : ""} name={empName(s.employee)} photo={emp(s.employee)?.photo} className="h-6 w-6" />
          {empName(s.employee)}
        </span>
      ),
    },
    // Summed under the columns, so a year of payslips answers "what did I earn, and what came off it"
    // without anyone exporting to a spreadsheet to add it up. Grouping by pay run does the same per run.
    { id: "gross", header: "Gross", align: "right", filter: "number", aggregate: "sum", formatTotal: (n) => money(n), accessor: (s) => s.gross, cell: (s) => money(s.gross) },
    { id: "deductions", header: "Deductions", align: "right", filter: "number", aggregate: "sum", formatTotal: (n) => money(n), accessor: (s) => s.total_deductions, cell: (s) => `− ${money(s.total_deductions)}` },
    { id: "tax", header: "TDS", align: "right", defaultHidden: true, filter: "number", aggregate: "sum", formatTotal: (n) => money(n), accessor: (s) => s.tax ?? 0, cell: (s) => money(s.tax ?? 0) },
    { id: "net", header: "Net pay", align: "right", filter: "number", aggregate: "sum", formatTotal: (n) => money(n), accessor: (s) => s.net, cell: (s) => <span className="font-semibold">{money(s.net)}</span> },
    ...(canRuns ? [{ id: "payroll_run", header: "Pay run", defaultHidden: true, filter: "select" as const, groupBy: true, accessor: (s: Payslip) => runLabel(s.payroll_run), cell: (s: Payslip) => runLabel(s.payroll_run) }] : []),
    // Which department the money went to. Only where the list reaches past the viewer, and only worth its
    // width folded: grouping a month of payslips by department is how payroll cost is actually discussed, and
    // each fold now carries its own total and its share of the run.
    ...(spansOthers
      ? [{
          id: "department",
          header: "Department",
          defaultHidden: true,
          filter: "select" as const,
          groupBy: true,
          accessor: (s: Payslip) => deptName(emp(s.employee)?.department),
        }]
      : []),
    // The size of the move, not its direction, because a chip has to narrow to exactly the rows it counted
    // and ">20" cannot mean "up or down by more than 20". The direction is in the cell, where it is read.
    {
      id: "net_swing",
      header: "Net change",
      align: "right",
      defaultHidden: true,
      filter: "number",
      formatTotal: (n) => `${Math.round(n)}%`,
      accessor: (s) => { const v = netSwing(s); return v == null ? null : Math.abs(Math.round(v * 10) / 10); },
      cell: (s) => {
        const v = netSwing(s);
        if (v == null) return <span className="text-muted-foreground">-</span>;
        const big = Math.abs(v) >= NET_SWING_PCT;
        return (
          <span className={cn("tabular-nums", big && "font-medium text-warning")}>
            {v > 0 ? "+" : ""}{Math.round(v * 10) / 10}%
          </span>
        );
      },
    },
    {
      id: "take_home",
      header: "Take-home",
      align: "right",
      defaultHidden: true,
      filter: "number",
      aggregate: "avg",
      formatTotal: (n) => `${Math.round(n)}%`,
      accessor: (s) => { const v = takeHome(s); return v == null ? null : Math.round(v); },
      cell: (s) => { const v = takeHome(s); return v == null ? "-" : <span className="tabular-nums">{Math.round(v)}%</span>; },
    },
    {
      id: "actions",
      header: "",
      sortable: false,
      filter: "none",
      align: "right",
      cell: (s) => (
        <div className="flex items-center justify-end gap-1">
          <AccessAction collection="payslips" objectPath={s.path} verb="preview" can={s.access?.can} label="Preview">
            <Button variant="ghost" size="sm" title="View in the app" onClick={() => onPreview(s)}>
              <Eye className="h-4 w-4" />
            </Button>
          </AccessAction>
          <AccessAction collection="payslips" objectPath={s.path} verb="download" can={s.access?.can} label="Download">
            <Button variant="outline" size="sm" loading={busy === idOf(s.path)} onClick={() => onDownload(s)}>
              {busy !== idOf(s.path) && <Download className="h-4 w-4" />} PDF
            </Button>
          </AccessAction>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Payslips"
        /* The list is whatever the caller's grant reaches, so the sentence under the title has to be too -
           "Your published payslips" over a table of the whole company's is a claim about whose money this is. */
        description={spansOthers ? "Published payslips, ready to read or download." : "Your published payslips, ready to download."}
        actions={
          <>
            {latest && (
              <AccessAction collection="payslips" objectPath={latest.path} verb="preview" can={latest.access?.can} label="View latest">
                <Button variant="outline" onClick={() => onPreview(latest)}>
                  <Eye className="h-4 w-4" /> View latest
                </Button>
              </AccessAction>
            )}
            {latest && (
              <AccessAction collection="payslips" objectPath={latest.path} verb="download" can={latest.access?.can} label="Download latest">
                <Button loading={busy === idOf(latest.path)} onClick={() => onDownload(latest)}>
                  {busy !== idOf(latest.path) && <Download className="h-4 w-4" />} Download latest payslip
                </Button>
              </AccessAction>
            )}
            <PageSettings me={me} host="payslips" />
          </>
        }
      />
      {/* The year's net/tax totals and the pay chart are both built from the loaded rows, which are one page of
          the collection - a long enough history runs past it. */}
      <TruncationNotice collection="payslips" what="payslips" className="mb-3" />
      <DataState state={state} error={error} onRetry={reload} rows={3}>
        {rows.length === 0 ? (
          <EmptyState icon={RupeeCircle} title="No payslips yet" description="Payslips appear here once a payroll run is published. New joiners usually see their first one after the first full pay cycle." />
        ) : (
          <>
          {/* Pay over time, which a list of downloadable PDFs cannot show at all. Gross against net says
              where a raise actually landed, and where a month of extra deductions quietly ate one. */}
          {payChart.labels.length > 2 && (
            <ChartCard className="mb-4" title="Your pay over time" description="Gross and take-home on each of your own payslips, oldest first.">
              <Chart
                type="axis-mixed"
                height={200}
                labels={payChart.labels}
                datasets={[
                  { name: "Gross", values: payChart.gross, chartType: "bar" },
                  { name: "Take-home", values: payChart.net, chartType: "line" },
                ]}
                format={(v) => money(v)}
                ariaLabel="Gross pay and take-home pay on each payslip"
                onSelect={(i) => { const s = payChart.slips[i]; if (s) onPreview(s); }}
              />
            </ChartCard>
          )}
          {latest && (
            <SummaryStrip
              items={[
                // The latest-payslip figures open that payslip; the year-to-date figures narrow the table to
                // this year's slips, which is the same set they were summed from - so the strip rides on the
                // table, under the chart.
                { label: "Latest net pay", value: money(latest.net), icon: Banknote, tone: "primary", hint: `Issued ${formatDate(latest.create_time)}`, onClick: () => onPreview(latest) },
                { label: "Latest gross", value: money(latest.gross), icon: Sigma, hint: `${money(latest.total_deductions)} deducted`, onClick: () => onPreview(latest) },
                { label: `Net paid in ${thisYear}`, value: money(ytd.net), icon: CalendarDays, hint: `${ytd.count} payslip${ytd.count === 1 ? "" : "s"}`, onClick: focusYtd, active: ytdActive },
                ...(ytd.count > 1 ? [{ label: "Average month", value: money(ytd.avgNet), icon: Sigma, hint: `net, over ${ytd.count} slips`, onClick: focusYtd, active: ytdActive }] : []),
                ...(ytd.tax > 0 ? [{ label: `TDS in ${thisYear}`, value: money(ytd.tax), icon: CalendarDays, tone: "muted" as const, hint: "tax withheld so far", onClick: focusYtd, active: ytdActive }] : []),
              ]}
            />
          )}
          {(years.length > 1 || spansOthers) && (
            <div className="mb-4 flex flex-wrap items-center gap-1.5">
              {/* Whose slips, for the caller who can see other people's - and the visible home of the state a
                  year-to-date tile puts the table into, so it can be read and cleared rather than just felt. */}
              {/* The shared chip. These two rows were the app's outlier: an unselected chip here carried
                  `bg-background` and lit up `hover:bg-muted hover:text-foreground`, where the same control on
                  every other page is transparent and lights up `hover:bg-accent`. Nobody chose that - it is
                  what nine hand-written copies of one control drift into. */}
              {spansOthers && (["all", "mine"] as const).map((w) => (
                <FilterChip key={w} active={who === w} onClick={() => setWho(w)}>{w === "all" ? "Everyone" : "Mine"}</FilterChip>
              ))}
              {spansOthers && years.length > 1 && <span aria-hidden className="mx-1 h-4 w-px bg-border" />}
              {years.length > 1 && ["all", ...years].map((y) => (
                <FilterChip key={y} active={year === y} onClick={() => setYear(y)}>{y === "all" ? "All years" : y}</FilterChip>
              ))}
            </div>
          )}
          <DataTable
            tableId="payslips"
            columns={columns}
            rows={visible}
            insights={payslipInsights}
            getRowId={(s) => s.path}
            emptyTitle="No payslips match"
            accessCollection="payslips"
            accessTargetOf={(s) => ({ objectPath: s.path, label: "Payslip", can: s.access?.can })}
          />
          </>
        )}
      </DataState>
      <PdfPreviewDialog source={preview} onClose={() => setPreview(null)} />
    </div>
  );
}
