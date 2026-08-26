import { useMemo, useState } from "react";
import { Banknote, CalendarDays, Download, Eye, Sigma } from "lucide-react";
import { RupeeCircle } from "@/components/icons/RupeeCircle";
import { download } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { cn, formatDate, formatMoney, idOf } from "@/lib/utils";
import { useOrg, currencyDecimals } from "@/lib/org";
import type { Me, Payslip } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { PageSettings } from "@/components/common/SettingsButton";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { Chart, ChartCard } from "@/components/common/Chart";
import { DataTable, type Column } from "@/components/common/DataTable";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { PdfPreviewDialog, type PdfSource } from "@/components/common/PdfPreviewDialog";
import { useToast } from "@/components/ui/use-toast";

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
  const latest = rows[0];
  // Net paid so far this calendar year (across however many slips the caller can see of their own).
  const ytd = useMemo(() => {
    const year = new Date().getFullYear().toString();
    const slips = rows.filter((s) => (s.create_time ?? "").startsWith(year));
    const net = slips.reduce((sum, s) => sum + (s.net ?? 0), 0);
    return {
      net,
      count: slips.length,
      // Tax withheld so far and the typical month: the two numbers people open a payslip page to work out.
      tax: slips.reduce((sum, s) => sum + (s.tax ?? 0), 0),
      avgNet: slips.length ? Math.round(net / slips.length) : 0,
    };
  }, [rows]);
  const thisYear = new Date().getFullYear().toString();
  // Year filter chips - only shown once the history spans more than one calendar year.
  const years = useMemo(
    () => [...new Set(rows.map((s) => (s.create_time ?? "").slice(0, 4)).filter(Boolean))].sort().reverse(),
    [rows],
  );
  // The last two years at most: a pay history chart is read for the trend, and thirty labels on a phone is
  // no trend at all. Oldest first, because time runs that way even though the table below does not.
  const payChart = useMemo(() => {
    const recent = [...rows].reverse().slice(-24);
    return {
      labels: recent.map((s) => (s.create_time ? new Date(s.create_time).toLocaleDateString(undefined, { month: "short", year: "2-digit" }) : "")),
      gross: recent.map((s) => Math.round(s.gross ?? 0)),
      net: recent.map((s) => Math.round(s.net ?? 0)),
    };
  }, [rows]);

  const [year, setYear] = useState<string>("all");
  const visible = useMemo(
    () => (year === "all" ? rows : rows.filter((s) => (s.create_time ?? "").startsWith(year))),
    [rows, year],
  );

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
    { id: "date", header: "Issued", accessor: (s) => s.create_time, cell: (s) => formatDate(s.create_time) },
    { id: "gross", header: "Gross", align: "right", accessor: (s) => s.gross, cell: (s) => money(s.gross) },
    { id: "deductions", header: "Deductions", align: "right", accessor: (s) => s.total_deductions, cell: (s) => `− ${money(s.total_deductions)}` },
    { id: "tax", header: "TDS", align: "right", defaultHidden: true, accessor: (s) => s.tax ?? 0, cell: (s) => money(s.tax ?? 0) },
    { id: "net", header: "Net pay", align: "right", accessor: (s) => s.net, cell: (s) => <span className="font-semibold">{money(s.net)}</span> },
    { id: "payroll_run", header: "Pay run", defaultHidden: true, accessor: (s) => (s.payroll_run ? idOf(s.payroll_run) : ""), cell: (s) => (s.payroll_run ? idOf(s.payroll_run) : "-") },
    { id: "employee", header: "Employee", defaultHidden: true, accessor: (s) => (s.employee ? idOf(s.employee) : ""), cell: (s) => (s.employee ? idOf(s.employee) : "-") },
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
        description="Your published payslips, ready to download."
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
      <DataState state={state} error={error} onRetry={reload} rows={3}>
        {rows.length === 0 ? (
          <EmptyState icon={RupeeCircle} title="No payslips yet" description="Payslips appear here once a payroll run is published. New joiners usually see their first one after the first full pay cycle." />
        ) : (
          <>
          {/* Pay over time, which a list of downloadable PDFs cannot show at all. Gross against net says
              where a raise actually landed, and where a month of extra deductions quietly ate one. */}
          {payChart.labels.length > 2 && (
            <ChartCard className="mb-4" title="Your pay over time" description="Gross and take-home on each payslip you can see, oldest first.">
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
                { label: `Net paid in ${thisYear}`, value: money(ytd.net), icon: CalendarDays, hint: `${ytd.count} payslip${ytd.count === 1 ? "" : "s"}`, onClick: () => setYear(thisYear), active: year === thisYear },
                ...(ytd.count > 1 ? [{ label: "Average month", value: money(ytd.avgNet), icon: Sigma, hint: `net, over ${ytd.count} slips`, onClick: () => setYear(thisYear), active: year === thisYear }] : []),
                ...(ytd.tax > 0 ? [{ label: `TDS in ${thisYear}`, value: money(ytd.tax), icon: CalendarDays, tone: "muted" as const, hint: "tax withheld so far", onClick: () => setYear(thisYear), active: year === thisYear }] : []),
              ]}
            />
          )}
          {years.length > 1 && (
            <div className="mb-4 flex flex-wrap items-center gap-1.5">
              {["all", ...years].map((y) => (
                <button
                  key={y}
                  type="button"
                  onClick={() => setYear(y)}
                  aria-pressed={year === y}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                    year === y ? "border-primary bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {y === "all" ? "All years" : y}
                </button>
              ))}
            </div>
          )}
          <DataTable
            tableId="payslips"
            columns={columns}
            rows={visible}
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
