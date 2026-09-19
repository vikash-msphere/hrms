import { useMemo, useState } from "react";
import { Download, Eye, ReceiptText } from "lucide-react";
import { download } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { formatDate, formatMoney, idOf } from "@/lib/utils";
import { orgDayOf, thisYearStr } from "@/lib/orgDay";
import { useOrg, currencyDecimals } from "@/lib/org";
import type { Payslip } from "@/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { TableSkeleton } from "@/components/common/Skeletons";
import { AccessAction } from "@/components/access/AccessAction";
import { PdfPreviewDialog, type PdfSource } from "@/components/common/PdfPreviewDialog";
import { useToast } from "@/components/ui/use-toast";

/** How many slips the card shows before "Show all" - two years of monthly pay, which is as far back as
 *  anybody reads on a profile without going looking for a specific month. */
const FOLD = 24;

// One employee's published payslips, on their record. The self-service #/payslips page answers "what was I
// paid"; this answers the same question about somebody else, which until now had no surface at all - a
// payroll admin could see everyone's slips in one undifferentiated list and no way to ask for one person's.
//
// The rows come from the same `payslips` collection with `?employee=`, so the server's scope still decides:
// a caller who may only see their own gets an empty card here rather than somebody else's pay.
export function EmployeePayslips({ employeeId }: { employeeId: string }) {
  const { rows: raw, state, hasMore } = useCollection<Payslip>("payslips", {
    all: true,
    params: { employee: `employees/${employeeId}` },
  });
  const { toast } = useToast();
  const { org } = useOrg();
  const money = (n: number) => formatMoney(n, org.default_currency, currencyDecimals(undefined, org));
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState<PdfSource | null>(null);

  // Newest first - the slip somebody opens a record for is nearly always the latest one.
  const rows = useMemo(
    () => [...raw].sort((a, b) => (b.create_time ?? "").localeCompare(a.create_time ?? "")),
    [raw],
  );
  // Which year a slip belongs to, on the ORG's clock rather than the viewer's - the same conversion #/payslips
  // uses, so the two surfaces cannot file the same slip under different years.
  const yearOf = (s: Payslip) => (s.create_time ? orgDayOf(s.create_time).slice(0, 4) : "");
  const thisYear = thisYearStr();
  const ytd = useMemo(() => {
    const slips = rows.filter((s) => yearOf(s) === thisYear);
    return {
      count: slips.length,
      net: slips.reduce((sum, s) => sum + (s.net ?? 0), 0),
      tax: slips.reduce((sum, s) => sum + (s.tax ?? 0), 0),
    };
  }, [rows, thisYear]);
  const visible = expanded ? rows : rows.slice(0, FOLD);

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
      const day = (s.create_time ?? "").slice(0, 10);
      await download(`payslips/${id}`, `payslip-${day || id}.pdf`);
    } catch (e) {
      toast({ title: "Download failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  return (
    // `sentry-mask` on the whole card, for the reason the #/payslips ROUTE is masked whole in instrument.ts -
    // "a table of net pay, deductions and statutory contributions, values with labels around them". This is
    // that same table, rendered on /employees/<id>, which is not on that list. Same argument as
    // EmployeeDocuments next door; test/replayMaskCoverage.test.ts pins both.
    <Card id="employee-payslips" className="sentry-mask">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">
          <AccessAction collection="payslips" label="Payslips">
            <span className="flex items-center gap-2"><ReceiptText className="h-4 w-4 text-primary" /> Payslips</span>
          </AccessAction>
        </CardTitle>
        {ytd.count > 0 && (
          <p className="text-right text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{money(ytd.net)}</span> net in {thisYear}
            {ytd.tax > 0 && <> · {money(ytd.tax)} TDS</>}
          </p>
        )}
      </CardHeader>
      <CardContent>
        {state === "loading" ? (
          <TableSkeleton rows={3} cols={4} />
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No payslips published for this employee yet.</p>
        ) : (
          <div className="scroll-shadow-x -mx-1 overflow-x-auto px-1 [--scroll-ground:hsl(var(--card))]">
            {/* Stacked into labelled rows below `sm`, a table from there up - the shape the sibling panels use. */}
            <table className="table-stack w-full text-sm sm:min-w-[30rem]">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Issued</th>
                  <th className="py-2 pr-3 text-right font-medium">Gross</th>
                  <th className="py-2 pr-3 text-right font-medium">Deductions</th>
                  <th className="py-2 pr-3 text-right font-medium">Net pay</th>
                  <th className="py-2 font-medium sr-only sm:not-sr-only">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((s) => (
                  <tr key={s.path} className="border-b last:border-0">
                    <td data-label="Issued" className="whitespace-nowrap py-1.5 pr-3 font-medium">{formatDate(s.create_time)}</td>
                    <td data-label="Gross" className="whitespace-nowrap py-1.5 pr-3 text-right tabular-nums">{money(s.gross)}</td>
                    <td data-label="Deductions" className="whitespace-nowrap py-1.5 pr-3 text-right tabular-nums text-muted-foreground">− {money(s.total_deductions)}</td>
                    <td data-label="Net pay" className="whitespace-nowrap py-1.5 pr-3 text-right font-semibold tabular-nums">{money(s.net)}</td>
                    <td className="py-1.5">
                      <div className="flex items-center justify-end gap-1">
                        {/* Two verbs, granted apart: reading a slip in the app and keeping a copy of it are
                            separate grants server-side, so each button follows the row's own access hint. */}
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
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > FOLD && (
              <Button variant="ghost" size="sm" className="mt-2" onClick={() => setExpanded((v) => !v)}>
                {expanded ? "Show recent only" : `Show all ${rows.length} payslips`}
              </Button>
            )}
            {hasMore && <p className="mt-2 text-xs text-muted-foreground">Showing the most recent payslips - older ones are not loaded here.</p>}
          </div>
        )}
      </CardContent>
      <PdfPreviewDialog source={preview} onClose={() => setPreview(null)} />
    </Card>
  );
}
