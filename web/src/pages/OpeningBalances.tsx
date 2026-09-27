import { useMemo, useState } from "react";
import { ArrowRight, CalendarCheck2, CheckCircle2, ClipboardList } from "lucide-react";
import { invoke } from "@/api";
import { navigate } from "@/router";
import { pageVisible } from "@/nav";
import { hasCapability, usePermission } from "@/lib/perm";
import { LeaveOpenings } from "@/components/opening/LeaveOpenings";
import { PayOpenings } from "@/components/opening/PayOpenings";
import { LeaveHistoryImport } from "@/components/opening/LeaveHistoryImport";
import { orgDayOf, todayStr } from "@/lib/orgDay";
import { formatDate } from "@/lib/utils";
import { confirmDecision } from "@/lib/confirmDecision";
import { useCollection } from "@/hooks/useCollection";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";
import { AccessAction } from "@/components/access/AccessAction";
import { PageHeader } from "@/components/common/PageHeader";
import { Field } from "@/components/common/Field";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Employee, Me } from "@/types";

// Bringing in what happened before the org started using HRMS.
//
// Everybody who joined before go-live has history that happened somewhere else, and every part of the app that
// works things out from "history since the start date" reads that history as empty: attendance calls the weeks
// before go-live absences, payroll docks them, leave accrues from the start date with nothing taken off. The
// first step here says WHEN the app's records start for each of those people (`employees.tracked_from`); the
// app then stops inferring anything from the empty days before it. Each step writes nothing until its preview
// has been looked at.

type Outcome = "set" | "already_set" | "joined_after";
type PlanRow = {
  employee: string;
  name: string;
  employee_number?: string;
  start_date?: string;
  created_day: string;
  tracked_from?: string;
  outcome: Outcome;
};
type Plan = { date: string; dry_run: boolean; counts: Record<Outcome, number>; results: PlanRow[] };

const OUTCOME: Record<Outcome, { label: string; variant: "success" | "muted" | "secondary" }> = {
  set: { label: "Gets this date", variant: "success" },
  already_set: { label: "Already has a date", variant: "secondary" },
  joined_after: { label: "Joined on or after it", variant: "muted" },
};

export default function OpeningBalances({ me }: { me: Me }) {
  // Each step is its own grant, so each section shows only to someone who may run it (hide, never disable).
  const canDate = usePermission("employees.setTrackedFrom");
  const canLeave = usePermission("leave-adjustments.importOpenings");
  const canPay = usePermission("payroll-openings.importOpenings");
  const canHistory = usePermission("leave-requests.importHistory");
  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Admin"
        title="Opening balances"
        description="Bring in what happened before your org started using HRMS, so nobody's attendance, pay or leave is worked out from history the app never saw."
      />
      {canDate && <RecordsStart />}
      {canLeave && <LeaveOpenings />}
      {canHistory && <LeaveHistoryImport />}
      {canPay && <PayOpenings />}
      <AlsoBringOver me={me} />
    </div>
  );
}

// ---- When HRMS records start ------------------------------------------------------------------------------

function RecordsStart() {
  const { toast } = useToast();
  const confirm = useConfirm();
  const { rows: employees, reload } = useCollection<Employee>("employees", { all: true });
  const live = useMemo(() => employees.filter((e) => !e.delete_time), [employees]);
  const dated = useMemo(() => live.filter((e) => e.tracked_from), [live]);
  // The first record anybody created is the best guess at go-live: that is the day the org started entering
  // people. Never later than today, which is the most the server accepts.
  const suggested = useMemo(() => {
    const days = live.map((e) => (e.create_time ? orgDayOf(e.create_time) : "")).filter(Boolean).sort();
    const today = todayStr();
    return days[0] && days[0] < today ? days[0] : today;
  }, [live]);
  const [date, setDate] = useState("");
  const chosen = date || suggested;
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);
  const [showAll, setShowAll] = useState(false);

  async function preview() {
    setBusy("preview");
    try {
      setPlan(await invoke<Plan>("employees", "setTrackedFrom", undefined, { date: chosen, dry_run: true }));
      setShowAll(false);
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't preview", description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    if (!plan) return;
    const who = `${plan.counts.set} ${plan.counts.set === 1 ? "person gets" : "people get"} ${formatDate(plan.date)} (or the day their record was created, if later)`;
    if (!(await confirmDecision(confirm, "setTrackedFrom", who))) return;
    setBusy("apply");
    try {
      const done = await invoke<Plan>("employees", "setTrackedFrom", undefined, { date: plan.date, dry_run: false });
      setPlan(done);
      reload();
      toast({ variant: "success", title: `HRMS records start set for ${done.counts.set} ${done.counts.set === 1 ? "person" : "people"}` });
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't set the date", description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  // The rows worth reading first are the ones that change; the rest are listed on request.
  const shown = plan ? (showAll ? plan.results : plan.results.filter((r) => r.outcome === "set")) : [];
  const applied = plan && !plan.dry_run;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarCheck2 className="h-4 w-4 text-muted-foreground" /> When HRMS records start
        </CardTitle>
        <CardDescription>
          For everybody who joined before your org started using HRMS. A working day before their date with no punches, mark or leave is
          never counted as an absence or docked as loss of pay. People who joined later need nothing: their records start on their start date.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {dated.length > 0 && (
          <p className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
            <span>
              {dated.length} {dated.length === 1 ? "person has" : "people have"} a date already
              {(() => {
                const days = [...new Set(dated.map((e) => e.tracked_from!))].sort();
                return days.length === 1 ? ` (${formatDate(days[0]!)})` : `, from ${formatDate(days[0]!)} to ${formatDate(days[days.length - 1]!)}`;
              })()}
              . Setting it again only reaches people who have none.
            </span>
          </p>
        )}
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Go-live date" hint="Suggested: the day the first employee record was created." className="w-56">
            <Input type="date" value={chosen} max={todayStr()} onChange={(e) => { setDate(e.target.value); setPlan(null); }} />
          </Field>
          <AccessAction collection="employees" verb="setTrackedFrom" label="Set when HRMS records start">
            <Button variant="outline" loading={busy === "preview"} disabled={!chosen} onClick={() => void preview()}>Preview</Button>
          </AccessAction>
        </div>

        {plan && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="success">{plan.counts.set} {applied ? "dated" : "to date"}</Badge>
              <Badge variant="secondary">{plan.counts.already_set} already dated</Badge>
              <Badge variant="muted">{plan.counts.joined_after} joined on or after {formatDate(plan.date)}</Badge>
              <Button variant="ghost" size="sm" className="ml-auto h-7 text-xs" onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Show only the changes" : "Show everybody"}
              </Button>
            </div>
            {shown.length > 0 ? (
              <div className="max-h-96 overflow-auto rounded-md border px-3 sm:px-0">
                {/* Labelled blocks below `sm`, a table from there up (`.table-stack`). */}
                <table className="table-stack w-full text-sm">
                  <thead className="sticky top-0 bg-muted/80 text-left text-xs text-muted-foreground backdrop-blur">
                    <tr>
                      <th className="px-3 py-2 font-medium">Name</th>
                      <th className="px-3 py-2 font-medium">Started</th>
                      <th className="px-3 py-2 font-medium">Record created</th>
                      <th className="px-3 py-2 font-medium">Records start</th>
                      <th className="px-3 py-2 font-medium">Result</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {shown.map((r) => (
                      <tr key={r.employee}>
                        <td className="px-3 py-2">
                          {r.name}
                          {r.employee_number && <span className="sentry-mask block font-mono text-[11px] text-muted-foreground">{r.employee_number}</span>}
                        </td>
                        <td data-label="Started" className="px-3 py-2 tabular-nums">{r.start_date ? formatDate(r.start_date) : "-"}</td>
                        <td data-label="Record created" className="px-3 py-2 tabular-nums">{formatDate(r.created_day)}</td>
                        <td data-label="Records start" className="sentry-mask px-3 py-2 tabular-nums">{r.tracked_from ? formatDate(r.tracked_from) : "-"}</td>
                        <td data-label="Result" className="px-3 py-2"><Badge variant={OUTCOME[r.outcome].variant}>{OUTCOME[r.outcome].label}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Nobody gets a new date: everyone who joined before {formatDate(plan.date)} already has one.</p>
            )}
            {!applied && plan.counts.set > 0 && (
              <div className="flex justify-end">
                <AccessAction collection="employees" verb="setTrackedFrom" label="Set when HRMS records start">
                  <Button loading={busy === "apply"} onClick={() => void apply()}>
                    Set the date for {plan.counts.set} {plan.counts.set === 1 ? "person" : "people"}
                  </Button>
                </AccessAction>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---- The rest of the history ---------------------------------------------------------------------------------

// What the app already has a home for. Nothing to import: each is entered on its own page, the way it would be
// for somebody who joined today. Listed so a go-live checklist has one place to be read from.
function AlsoBringOver({ me }: { me: Me }) {
  const has = (p: string) => hasCapability(me.capabilities, p);
  const reachesOthers = (c: string) => !!me.scopes.read[c];
  const items = [
    {
      page: "loans",
      title: "Loans and salary advances still being repaid",
      body: "Record each one, approve and disburse it, then record what was repaid before HRMS. Payroll recovers one installment a month from there.",
    },
    {
      page: "employees",
      title: "Salary",
      body: "Each person's compensation should be effective from before the first payroll month HRMS runs, so that month and every month after it is priced.",
    },
    {
      page: "tax-declarations",
      title: "Tax declarations and a previous employer's income",
      body: "Declarations for this financial year, and for anyone who joined this year from another employer, the income and TDS from that job (declared on their Tax page, then verified).",
    },
    { page: "documents", title: "Documents", body: "Offer letters, ID proofs and policy acknowledgements that live in the old system." },
    { page: "assets", title: "Assets in people's hands", body: "Add the kit, then hand each item over so custody starts from a scan." },
  ].filter((i) => pageVisible(i.page, has, reachesOthers));
  if (!items.length) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ClipboardList className="h-4 w-4 text-muted-foreground" /> Also bring over
        </CardTitle>
        <CardDescription>These already have a place in HRMS, so they are entered there rather than imported here.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {items.map((i) => (
            <li key={i.page} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{i.title}</p>
                <p className="text-xs text-muted-foreground">{i.body}</p>
              </div>
              <Button variant="ghost" size="sm" className="h-7 shrink-0 gap-1 text-xs" onClick={() => navigate(i.page)}>
                Open <ArrowRight className="h-3 w-3" />
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
