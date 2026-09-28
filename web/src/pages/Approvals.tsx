import * as React from "react";
import { useMemo, useState } from "react";
import { CalendarCheck, ReceiptText, Hourglass, House, Check, X, CheckCheck, ExternalLink, Clock, Coins, Banknote, Timer, Inbox, Users, History, Landmark, Wallet, Laptop, AlarmClock, type LucideIcon } from "lucide-react";
import { useCollection } from "@/hooks/useCollection";
import { navigate } from "@/router";
import { useApprovals, APPROVAL_COLLECTIONS } from "@/lib/approvals";
import { invoke, patch } from "@/api";
import { describeError, isConflict } from "@/lib/formError";
import { idOf, formatDate, formatMoney, cn } from "@/lib/utils";
import { useOrg, currencyDecimals } from "@/lib/org";
import { PageHeader } from "@/components/common/PageHeader";
import { RowActivityButton } from "@/components/common/RowActivityButton";
import { resourceRoute } from "@/lib/resourceRoute";
import { EmptyState } from "@/components/common/EmptyState";
import { CardsSkeleton } from "@/components/common/Skeletons";
import { DataState } from "@/components/common/DataState";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { useKpiFocus } from "@/lib/kpiFocus";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { AccessAction } from "@/components/access/AccessAction";
import { usePermission, useCanWriteOthers } from "@/lib/perm";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirm } from "@/components/common/confirm";
import { confirmDecision } from "@/lib/confirmDecision";
import { bulkInvoke, mergeBulkResults, bulkSummary } from "@/lib/bulk";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import type { Employee, LeaveRequest, LeaveType, LeaveBalance, ReimbursementCategory, Project, Me, Reimbursement, OvertimeRequest, RemoteWorkRequest, LateEarlyRequest, AttendanceRegularization, LeaveEncashment, Loan, TimeEntry, Expense, AssetCategory, AssetRequest } from "@/types";
import { KIND_LABEL, fmtMinutes, type LateEarlyKind } from "@/lib/lateEarly";
import type { ApprovalsBuckets, TaxVerification } from "@/lib/approvals";
import { TruncationNotice } from "@/components/common/TruncationNotice";
import { leaveDecisionContext, leaveSummary } from "@/lib/leaveApproval";
import { ApprovalRow, DecidedBadge, RejectDialog, waitingDays, waitingLabel, type Approvable, type RejectTarget } from "@/components/common/ApprovalRow";

// A single inbox tab. `summary`/`context` erase to accept the heterogeneous union; the group() factory below
// preserves each tab's concrete row type at the call site so a renamed/removed field fails the typecheck.
// A request waiting this long is the one to decide first - the strip calls it out and can filter to it.
const AGING_DAYS = 7;

type GroupDef = { key: string; label: string; icon: LucideIcon; collection: string; items: Approvable[]; summary: (r: Approvable) => React.ReactNode; context?: (r: Approvable) => React.ReactNode };
function group<T extends Approvable>(g: { key: string; label: string; icon: LucideIcon; collection: string; items: T[]; summary: (r: T) => React.ReactNode; context?: (r: T) => React.ReactNode }): GroupDef {
  return g as unknown as GroupDef;
}

// Prior-employer tax declarations awaiting verification. A bespoke queue (not a collection), so it renders as
// its own inbox section with a Verify/Reject that PATCHes employees/<id>/tax - the server still enforces the
// maker-checker (you can't verify your own). Hidden for callers without the tax-verifications capability (the
// endpoint 403s -> empty rows).
function TaxVerificationsCard({ rows, money, canDecide, onDone }: { rows: TaxVerification[]; money: (n: number) => string; canDecide: boolean; onDone: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const confirm = useConfirm();
  async function decide(v: TaxVerification, action: "verify" | "reject") {
    // A rejection un-applies the declared prior-employer income and TDS from this person's tax projection -
    // it changes their withholding on the next run and notifies them - so it gets the same beat of friction
    // as every other reject in the app. It is a `patch` rather than an `invoke`, which is the only reason it
    // did not look like a decision to anything scanning for one (lib/confirmDecision.ts).
    if (action === "reject" && !(await confirmDecision(confirm, "reject", `${v.employee_name}'s prior-employer tax declaration`))) return;
    setBusy(v.employee + action);
    try {
      // The version the card was drawn from, and the figures that were on it. Either alone closes the gap the
      // server's guard describes; both together mean a decision can only ever land on what the reviewer saw -
      // a re-declaration in between is a 409 they can re-read, not a silent verify of a number nobody read.
      await patch(
        `employees/${idOf(v.employee)}/tax`,
        action === "verify"
          ? { values: { action, verified_income: v.prior_employer_income, verified_tds: v.prior_employer_tds } }
          : { values: { action } },
        v.etag,
      );
      toast({ title: action === "verify" ? "Previous employer details verified" : "Declaration rejected", variant: "success" });
      onDone();
    } catch (e) {
      // A conflict here is the guard doing its job: the declaration moved after this card was drawn, so the
      // queue is reloaded and the reviewer decides on the figures that are actually on file now.
      if (isConflict(e)) {
        toast({ title: "This declaration changed", description: "It was re-declared while this queue was open. The figures have been reloaded - check them and decide again.", variant: "destructive" });
        onDone();
      } else {
        toast({ title: "Couldn't update", description: describeError(e), variant: "destructive" });
      }
    } finally {
      setBusy(null);
    }
  }
  return (
    <Card className="mb-4">
      <CardContent className="pt-4 sm:pt-6">
        <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
          <Landmark className="h-4 w-4 text-primary" /> Tax verifications
          <Badge variant="secondary">{rows.length}</Badge>
        </div>
        <p className="mb-2 text-xs text-muted-foreground">Income and TDS from a previous employer, declared by employees. Verifying applies it to their tax projection.</p>
        <div className="divide-y">
          {rows.map((v) => (
            <div key={v.employee} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="font-medium">{v.employee_name}</p>
                {/* MASKED from session replay: another person's prior-employer income and TDS, by name.
                    `tax-verifications` is in MEMORY_ONLY, and the same two figures on the Tax declarations
                    page are already masked by the `tax-declarations` route - this queue is the other place
                    they render. */}
                <p className="text-xs text-muted-foreground" data-sentry-mask>Income {money(v.prior_employer_income)} · TDS {money(v.prior_employer_tds)}</p>
              </div>
              {canDecide && (
                <div className="flex items-center gap-1.5">
                  <AccessAction collection="employees" objectPath={v.employee} field="tax" label="Verify prior-employer tax">
                    <Button size="sm" variant="outline" loading={busy === v.employee + "verify"} disabled={!!busy} onClick={() => decide(v, "verify")}><Check className="h-4 w-4" /> Verify</Button>
                  </AccessAction>
                  {/* Same AccessAction as its neighbour: both are behind one gate, so showing the manage-access
                      key on only half the pair reads as an authorization difference that isn't there. */}
                  <AccessAction collection="employees" objectPath={v.employee} field="tax" label="Reject prior-employer tax">
                    <Button size="sm" variant="ghost" className="text-destructive" loading={busy === v.employee + "reject"} disabled={!!busy} onClick={() => decide(v, "reject")}><X className="h-4 w-4" /> Reject</Button>
                  </AccessAction>
                </div>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// A single place for everything awaiting the caller's decision, drawn from every request type they can act
// on. Each source is filtered to PENDING items the caller may approve (per-object), so an employee with no
// approval rights simply sees an empty inbox (and the nav item is hidden for them).
export default function Approvals({ me }: { me: Me }) {
  void me;
  // Deciding a prior-employer tax declaration is a PATCH of `employees/<id>/tax` about somebody else - the
  // server's maker-checker refuses the subject's own - so the gate is the caller's write breadth past their
  // own rows, never the stripped `employees.tax.write` that every employee holds for their own declaration.
  const canDecideTax = useCanWriteOthers("employees.tax");
  const { org } = useOrg();
  const money = (n: number) => formatMoney(n, org.default_currency, currencyDecimals(undefined, org));

  // Pending items + a shared reload come from the session-wide provider, so approving here also updates the
  // sidebar count badge.
  const { leaves, reimbs, overtimes, remotes, lateEarlies, regularizations, encashments, loans, timeEntries, expenses, assetRequests, taxVerifications, total, history, reload, loading, error } = useApprovals();

  // Reference lists exist to LABEL rows, so each one waits for a row of its own kind to be in the inbox (or in
  // the decided history, which the same buckets carry). An inbox holding two leave requests reads leave types -
  // not reimbursement categories, projects and asset categories as well. An empty inbox reads nothing at all.
  const anyOf = (kind: keyof typeof history) => (history[kind]?.length ?? 0) > 0;
  const hasLeave = leaves.length > 0 || anyOf("leaves");
  const { rows: employees } = useCollection<Employee>("employees", { all: true, enabled: total > 0 || Object.values(history).some((b) => b.length > 0) });
  const { rows: leaveTypes } = useCollection<LeaveType>("leave-types", { enabled: hasLeave || encashments.length > 0 || anyOf("encashments") });
  const { rows: categories } = useCollection<ReimbursementCategory>("reimbursement-categories", { enabled: reimbs.length > 0 || anyOf("reimbs") });
  const { rows: projects } = useCollection<Project>("projects", { enabled: timeEntries.length > 0 || anyOf("timeEntries"), all: true });
  const { rows: assetCategories } = useCollection<AssetCategory>("asset-categories", { enabled: assetRequests.length > 0 || anyOf("assetRequests"), all: true });
  // Decision context for leave: the requester's remaining balance and who else is already off in that window.
  // Both are served scoped to what the caller may read, so these quietly stay blank for approvers without
  // access - and are read only when there is a leave decision to make.
  const { rows: balances } = useCollection<LeaveBalance>("leave-balances", { enabled: hasLeave });
  const { rows: allLeave } = useCollection<LeaveRequest>("leave-requests", { enabled: hasLeave });

  // Pending inbox vs the decided-history audit trail. Toggled at the top; the "All" merged stream + per-type
  // tabs render for whichever set is active.
  const [mode, setMode] = useState<"pending" | "history">("pending");

  // Rows decided in this session: hidden immediately (optimistic) while the provider re-fetches in the
  // background, so the inbox never shows an already-decided row with live buttons.
  const [decided, setDecided] = useState<Set<string>>(new Set());
  const settle = (path: string) => {
    setDecided((prev) => new Set(prev).add(path));
    reload();
  };
  const [rejecting, setRejecting] = useState<RejectTarget | null>(null);

  const emp = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), e] as const));
    return (p?: string) => (p ? m.get(idOf(p)) : undefined);
  }, [employees]);
  const typeName = useMemo(() => {
    const m = new Map(leaveTypes.map((t) => [idOf(t.path), t.display_name]));
    return (p?: string) => (p ? m.get(idOf(p)) ?? "Leave" : "Leave");
  }, [leaveTypes]);
  const catName = useMemo(() => {
    const m = new Map(categories.map((c) => [idOf(c.path), c.display_name]));
    return (p?: string) => (p ? m.get(idOf(p)) ?? p : undefined);
  }, [categories]);
  const projName = useMemo(() => {
    const m = new Map(projects.map((p) => [idOf(p.path), p.name]));
    return (p?: string) => (p ? m.get(idOf(p)) ?? p : undefined);
  }, [projects]);
  const assetCatName = useMemo(() => {
    const m = new Map(assetCategories.map((c) => [idOf(c.path), c.display_name]));
    return (p?: string) => (p ? m.get(idOf(p)) ?? "Asset" : "Asset");
  }, [assetCategories]);

  const personOf = (p?: string) => {
    const e = emp(p);
    return { employeeId: p ? idOf(p) : undefined, name: e ? `${e.first_name} ${e.last_name}` : "Someone", photo: e?.photo };
  };

  // Balance / overlap / reason - the decision aid, shared with the Leaves page's own pending band.
  const leaveContext = (r: LeaveRequest): React.ReactNode => leaveDecisionContext(r, balances, allLeave);

  // Pending items, oldest submission first, minus anything decided in this session.
  const bySubmitTime = <T extends Approvable>(rows: T[]) =>
    rows.filter((r) => !decided.has(r.path)).sort((a, b) => (a.create_time ?? "").localeCompare(b.create_time ?? ""));

  const sumReg = (r: AttendanceRegularization) => {
    const t = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const times = r.sessions.length === 0 ? "remove punches" : r.sessions.map((s) => `${t(s.clock_in)}–${t(s.clock_out)}`).join(", ");
    return `${formatDate(r.date)} · ${times}${r.reason ? ` · ${r.reason}` : ""}`;
  };
  // Decision context for an attendance correction: the log it is about to rewrite. The times on the row are
  // only half the question - whether they fit the days around them is the other half, and that is a click away
  // rather than a memory test. Pending only; a decided one needs no aid.
  const regContext = (r: AttendanceRegularization): React.ReactNode => {
    const empId = r.employee ? idOf(r.employee) : undefined;
    if (!empId) return null;
    return (
      <button
        type="button"
        className="font-medium text-primary underline-offset-2 hover:underline"
        onClick={() => navigate(`employees/${empId}/attendance`)}
      >
        See their attendance around {formatDate(r.date)}
      </button>
    );
  };
  const sumLeave = (r: LeaveRequest) => leaveSummary(r, (ref) => typeName(ref) ?? "Leave");
  const sumReimb = (r: Reimbursement) => `${money(r.amount)}${r.category ? ` · ${catName(r.category)}` : ""}${r.description ? ` · ${r.description}` : ""}`;
  const sumOt = (r: OvertimeRequest) => `${formatDate(r.date)} · ${Math.round(r.minutes / 6) / 10}h${r.reason ? ` · ${r.reason}` : ""}`;
  const sumRemote = (r: RemoteWorkRequest) => `${formatDate(r.start_date)} – ${formatDate(r.end_date)} · ${r.days} day${r.days === 1 ? "" : "s"}${r.reason ? ` · ${r.reason}` : ""}`;
  // What is being asked, in the words the person used, and the one fact the decider weighs it against: whether it
  // was filed past the monthly allowance the org set.
  const sumLateEarly = (r: LateEarlyRequest) =>
    `${formatDate(r.date)} · ${KIND_LABEL[r.kind as LateEarlyKind] ?? r.kind} · ${r.kind === "early_departure" ? "leave at" : "in by"} ${r.at} (${fmtMinutes(r.minutes ?? 0)})${r.over_limit ? " · past the monthly allowance" : ""}${r.reason ? ` · ${r.reason}` : ""}`;
  // The same aid a correction gets: the person's own attendance around the day, one click away.
  const lateEarlyContext = (r: LateEarlyRequest): React.ReactNode => {
    const empId = r.employee ? idOf(r.employee) : undefined;
    if (!empId) return null;
    return (
      <button type="button" className="font-medium text-primary underline-offset-2 hover:underline" onClick={() => navigate(`employees/${empId}/attendance`)}>
        See their attendance around {formatDate(r.date)}
      </button>
    );
  };
  const sumEncash = (r: LeaveEncashment) => `${typeName(r.leave_type)} · ${r.days} day${r.days === 1 ? "" : "s"}${r.amount != null ? ` · ${money(r.amount)}` : ""}`;
  const sumLoan = (r: Loan) => `${r.kind === "advance" ? "Advance" : "Loan"} · ${money(r.principal)} · ${r.installments} installment${r.installments === 1 ? "" : "s"}${r.reason ? ` · ${r.reason}` : ""}`;
  const sumTime = (r: TimeEntry) => `${projName(r.project) ?? "Project"}${r.date ? ` · ${formatDate(r.date)}` : ""} · ${r.hours}h${r.description ? ` · ${r.description}` : ""}`;
  // An asset request is decided on what kind of thing is wanted, by when, and why - the specific machine is
  // picked later, at hand-over.
  const sumAssetReq = (r: AssetRequest) =>
    `${assetCatName(r.category)}${r.needed_by ? ` · needed by ${formatDate(r.needed_by)}` : ""}${r.justification ? ` · ${r.justification}` : ""}`;
  // Company expenses read off the row alone - resolving vendor/category names would cost two more collection
  // reads on a page that already fetches seven, and the amount + note is what the decision turns on.
  const sumExpense = (r: Expense) =>
    `${money(r.amount)}${r.reimbursable ? " · employee-fronted" : ""}${r.description ? ` · ${r.description}` : ""}${r.invoice_number ? ` · invoice ${r.invoice_number}` : ""}${r.has_invoice ? "" : " · no invoice attached"}`;

  // One tab per request type, in priority order. Pending items are oldest-first (clear the longest waits
  // first); the history buckets arrive newest-decided first. Only non-empty tabs render. `leaveContext` (the
  // balance/overlap decision aid) is pending-only - history needs no decision aid.
  const buildGroups = (b: ApprovalsBuckets, forHistory: boolean): GroupDef[] => {
    const items = <T extends Approvable>(rows: T[]) => (forHistory ? rows : bySubmitTime(rows));
    return [
      group({ key: "leave", label: "Leave", icon: CalendarCheck, collection: "leave-requests", items: items(b.leaves), summary: sumLeave, context: forHistory ? undefined : leaveContext }),
      group({ key: "reimb", label: "Reimbursements", icon: ReceiptText, collection: "reimbursements", items: items(b.reimbs), summary: sumReimb }),
      group({ key: "overtime", label: "Overtime", icon: Hourglass, collection: "overtime-requests", items: items(b.overtimes), summary: sumOt }),
      group({ key: "remote", label: "Remote work", icon: House, collection: "remote-work-requests", items: items(b.remotes), summary: sumRemote }),
      group({ key: "late-early", label: "Late & early", icon: AlarmClock, collection: "late-early-requests", items: items(b.lateEarlies), summary: sumLateEarly, context: forHistory ? undefined : lateEarlyContext }),
      group({ key: "regularization", label: "Attendance", icon: Clock, collection: "attendance-regularizations", items: items(b.regularizations), summary: sumReg, context: forHistory ? undefined : regContext }),
      group({ key: "encashment", label: "Leave encashment", icon: Coins, collection: "leave-encashments", items: items(b.encashments), summary: sumEncash }),
      group({ key: "loan", label: "Loans & advances", icon: Banknote, collection: "loans", items: items(b.loans), summary: sumLoan }),
      group({ key: "timesheet", label: "Timesheets", icon: Timer, collection: "time-entries", items: items(b.timeEntries), summary: sumTime }),
      group({ key: "expense", label: "Company expenses", icon: Wallet, collection: "expenses", items: items(b.expenses), summary: sumExpense }),
      group({ key: "asset-request", label: "Asset requests", icon: Laptop, collection: "asset-requests", items: items(b.assetRequests), summary: sumAssetReq }),
    ];
  };
  const isHistory = mode === "history";
  const allGroups = isHistory
    ? buildGroups(history, true)
    : buildGroups({ leaves, reimbs, overtimes, remotes, lateEarlies, regularizations, encashments, loans, timeEntries, expenses, assetRequests }, false);
  // Metrics count the whole queue; the tabs below show whichever slice a metric has been clicked into, so the
  // numbers never move under the reader as they narrow.
  const queue = allGroups.flatMap((g) => g.items);
  const kf = useKpiFocus<Approvable, "aging" | "mine" | "today">({
    aging: { label: `requests waiting over ${AGING_DAYS} days`, match: (r) => waitingDays(r.create_time) >= AGING_DAYS },
    mine: { label: "requests you can decide", match: (r) => (r.access?.can ?? []).some((v) => v === "approve" || v === "reject") },
    today: { label: "requests submitted today", match: (r) => waitingDays(r.create_time) === 0 },
  });
  const groups = kf.focus && !isHistory ? allGroups.map((g) => ({ ...g, items: kf.apply(g.items) })) : allGroups;
  const activeGroups = groups.filter((g) => g.items.length > 0);
  const visibleTotal = activeGroups.reduce((n, g) => n + g.items.length, 0);
  const queueTotal = queue.length;
  const historyTotal = Object.values(history).reduce((n, arr) => n + arr.length, 0);

  // The merged queue behind the "All" stream: every visible item across types, tagged with its group. Pending
  // = oldest first (work the queue down); history = newest-decided first.
  const merged = activeGroups
    .flatMap((g) => g.items.map((r) => ({ g, r })))
    .sort((a, b) => isHistory
      ? (b.r.update_time ?? "").localeCompare(a.r.update_time ?? "")
      : (a.r.create_time ?? "").localeCompare(b.r.create_time ?? ""));
  // --- bulk selection over the pending queue --------------------------------------------------------------
  // Rows the caller may decide (per-object can hints) are checkbox-selectable; Approve/Reject selected then
  // fan out per collection and only the rows that succeeded disappear (failures stay selected for a retry).
  const { toast } = useToast();
  const confirmDialog = useConfirm();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState<null | "approve" | "reject">(null);
  const canDecideRow = (r: Approvable) => (r.access?.can ?? []).includes("approve") || (r.access?.can ?? []).includes("reject");
  const selectablePaths = isHistory ? [] : merged.filter(({ r }) => canDecideRow(r)).map(({ r }) => r.path);
  // Rows that got decided (elsewhere or here) fall out of the selection automatically.
  React.useEffect(() => {
    setSel((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(selectablePaths);
      const next = new Set([...prev].filter((p) => live.has(p)));
      return next.size === prev.size ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHistory, selectablePaths.join("|")]);
  const toggleSel = (path: string) =>
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  async function runBulkDecision(verb: "approve" | "reject") {
    const items = merged.filter(({ r }) => sel.has(r.path) && (r.access?.can ?? []).includes(verb));
    if (items.length === 0) return;
    const n = items.length;
    const ok = await confirmDialog({
      title: verb === "approve" ? `Approve ${n} request${n === 1 ? "" : "s"}?` : `Reject ${n} request${n === 1 ? "" : "s"}?`,
      description:
        verb === "reject"
          ? "Requesters are notified. A bulk reject carries no note - reject individually to explain why."
          : "Each requester is notified of the decision.",
      destructive: verb === "reject",
      confirmLabel: verb === "approve" ? "Approve all" : "Reject all",
    });
    if (!ok) return;
    setBulkBusy(verb);
    try {
      const byColl = new Map<string, Approvable[]>();
      for (const { g, r } of items) byColl.set(g.collection, [...(byColl.get(g.collection) ?? []), r]);
      const parts = await Promise.all([...byColl].map(([coll, rows]) => bulkInvoke(coll, verb, rows)));
      const res = mergeBulkResults(parts);
      toast(bulkSummary(verb === "approve" ? "Approved" : "Rejected", res));
      // Hide the decided rows immediately (same optimistic path as a single decision), keep failures selected.
      setDecided((prev) => {
        const next = new Set(prev);
        for (const r of res.okRows) next.add(r.path);
        return next;
      });
      setSel((prev) => {
        const next = new Set(prev);
        for (const r of res.okRows) next.delete(r.path);
        return next;
      });
      reload();
    } finally {
      setBulkBusy(null);
    }
  }

  // Queue-wide (never focus-narrowed) figures behind the metric strip.
  const oldestWait = queue.reduce((n, r) => Math.max(n, waitingDays(r.create_time)), 0);
  const agingCount = queue.filter((r) => waitingDays(r.create_time) >= AGING_DAYS).length;
  const todayCount = queue.filter((r) => waitingDays(r.create_time) === 0).length;
  const decidableCount = queue.filter(canDecideRow).length;
  const requesterCount = (() => {
    const s = new Set<string>();
    for (const r of queue) {
      const e = (r as { employee?: string }).employee;
      if (e) s.add(idOf(e));
    }
    return s.size;
  })();

  // Controlled tab: deciding the LAST item of a tab removes that tab, so fall back to the merged stream (or
  // the only remaining tab) instead of stranding the page on a tab that no longer renders. The "All" stream
  // is the default - approvers clear the whole queue top to bottom without hopping tabs.
  const showAll = activeGroups.length > 1;
  const [tab, setTab] = useState<string | undefined>(undefined);
  const activeTab = tab === "all" && showAll ? "all" : tab && activeGroups.some((g) => g.key === tab) ? tab : showAll ? "all" : activeGroups[0]?.key;

  const rowFor = (g: (typeof groups)[number], r: Approvable, withKind: boolean) => {
    const who = personOf((r as { employee?: string }).employee);
    const summary = g.summary(r);
    const decidedState = isHistory ? ((r as { state?: string; status?: string }).state ?? (r as { status?: string }).status) : undefined;
    return (
      <ApprovalRow
        key={r.path}
        collection={g.collection}
        row={r}
        {...who}
        selfEmployeeId={me.employee_id}
        summary={summary}
        context={g.context?.(r)}
        kind={withKind ? { label: g.label, icon: g.icon } : undefined}
        decidedState={decidedState}
        onApproved={settle}
        onRejectClick={() => setRejecting({ collection: g.collection, row: r, name: who.name, summary })}
        checked={sel.has(r.path)}
        onCheckedChange={!isHistory && canDecideRow(r) ? () => toggleSel(r.path) : undefined}
      />
    );
  };

  // The tabs block (All + per-type), shared by both modes; only its data (activeGroups/merged) differs.
  const tabsBlock = (
    <Tabs value={activeTab} onValueChange={setTab}>
      <TabsList>
        {showAll && (
          <TabsTrigger value="all">
            <Inbox className="h-4 w-4" /> All
            <Badge variant="secondary" className="ml-1.5">{visibleTotal}</Badge>
          </TabsTrigger>
        )}
        {activeGroups.map((g) => (
          <TabsTrigger key={g.key} value={g.key}>
            <g.icon className="h-4 w-4" /> {g.label}
            <Badge variant="secondary" className="ml-1.5">{g.items.length}</Badge>
          </TabsTrigger>
        ))}
      </TabsList>
      {showAll && (
        <TabsContent value="all">
          <Card><CardContent className="divide-y pt-4 sm:pt-6">{merged.map(({ g, r }) => rowFor(g, r, true))}</CardContent></Card>
        </TabsContent>
      )}
      {activeGroups.map((g) => (
        <TabsContent key={g.key} value={g.key}>
          <Card><CardContent className="divide-y pt-4 sm:pt-6">{g.items.map((r) => rowFor(g, r, false))}</CardContent></Card>
        </TabsContent>
      ))}
    </Tabs>
  );

  return (
    <div>
      <PageHeader
        title="Approvals"
        description="Requests waiting on your approval, and everything you've already decided."
      />

      <TruncationNotice collection={APPROVAL_COLLECTIONS} what="pending requests" className="mb-3" />
      {/* "You're all caught up" is a claim a manager acts on, and a queue contributes no rows whether it is
          empty, still arriving, or failed - three states that looked identical here. The wait is the shape of
          the list that is coming; a failed read says so and offers a retry, because the one thing this page
          must never do is report an empty inbox it could not actually read. */}
      {loading && total === 0 && historyTotal === 0 ? (
        <CardsSkeleton count={4} />
      ) : error && total === 0 && historyTotal === 0 ? (
        <DataState state="error" error={error} onRetry={reload}><div /></DataState>
      ) : total === 0 && historyTotal === 0 ? (
        <EmptyState icon={CheckCheck} title="You're all caught up" illustration="allClear"
                description="Nothing is waiting on your approval right now." />
      ) : (
        <>
          {/* Pending inbox vs decided history. */}
          <div className="mb-4 inline-flex rounded-lg border p-0.5 text-sm">
            {([["pending", "Pending", total], ["history", "History", historyTotal]] as const).map(([m, label, count]) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={cn("inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition-colors", mode === m ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}
              >
                {m === "pending" ? <Inbox className="h-4 w-4" /> : <History className="h-4 w-4" />} {label}
                {count > 0 && <Badge variant="secondary">{count}</Badge>}
              </button>
            ))}
          </div>

          {mode === "pending" ? (
            queueTotal === 0 && taxVerifications.length === 0 ? (
              <EmptyState icon={CheckCheck} title="You're all caught up" description="All pending requests have been decided." />
            ) : (
              <>
                {/* Reading this queue and DECIDING on it are separate grants, and the decision is a PATCH of
                    `employees/<id>/tax`. Not the stripped capability: `employees.me.tax.**` is a write grant
                    every employee holds, so `employees.tax.write` is true for all of them - and this queue is
                    never one's own declaration (the server's maker-checker refuses that outright). The
                    caller's write BREADTH past their own rows is the grant that can actually decide here; a
                    queue spans many people, so there is no one subject to ask `access.subject` about. */}
                {taxVerifications.length > 0 && (
                  <TaxVerificationsCard rows={taxVerifications} money={money} canDecide={canDecideTax} onDone={reload} />
                )}
                {queueTotal > 0 && (
                  <>
                    <SummaryStrip
                      items={[
                        { label: "Awaiting your decision", value: queueTotal, icon: Inbox, tone: "warning", hint: "the whole queue", onClick: () => { kf.clear(); setTab("all"); }, active: kf.focus === null },
                        { label: "Longest waiting", value: waitingLabel(oldestWait), icon: Hourglass, tone: oldestWait >= AGING_DAYS ? "warning" : "default", hint: agingCount ? `${agingCount} over ${AGING_DAYS}d` : "oldest in the queue", ...(agingCount ? kf.kpi("aging") : {}) },
                        ...(decidableCount && decidableCount < queueTotal
                          ? [{ label: "Yours to decide", value: decidableCount, icon: CheckCheck, tone: "primary" as const, hint: "rest are read-only", ...kf.kpi("mine") }]
                          : []),
                        ...(todayCount ? [{ label: "Arrived today", value: todayCount, icon: Inbox, tone: "default" as const, hint: "raised today", ...kf.kpi("today") }] : []),
                        // A distinct-person count over the same rows the first tile opens - there is no narrower
                        // list behind it, so it stays a read-only figure rather than a filter that does nothing.
                        { label: "People waiting", value: requesterCount, icon: Users, hint: requesterCount === 1 ? "one requester" : "distinct requesters" },
                      ]}
                    />
                    {kf.focus && visibleTotal === 0 && (
                      <p className="mb-4 rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                        No {kf.activeLabel}.{" "}
                        <button type="button" className="font-medium text-primary underline-offset-2 hover:underline" onClick={kf.clear}>Show the whole queue</button>
                      </p>
                    )}
                    {sel.size > 0 && (
                      // `top-16`, not `top-2`: the app bar is `sticky top-0 h-14` at z-30, so a bar that
                      // pins 8px from the top of the VIEWPORT pins underneath it - the selection count and
                      // its Approve/Reject buttons slid out of sight the moment the list scrolled, which is
                      // exactly when a bulk decision is being made. 4rem clears the bar with a small gap.
                      <div className="sticky top-16 z-20 mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-card px-3 py-2 shadow-pop">
                        <span className="text-sm font-medium tabular-nums">{sel.size} selected</span>
                        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setSel(new Set())}>
                          Clear
                        </Button>
                        {sel.size < selectablePaths.length && (
                          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setSel(new Set(selectablePaths))}>
                            Select all {selectablePaths.length}
                          </Button>
                        )}
                        <div className="min-w-4 flex-1" />
                        <Button size="sm" variant="success" loading={bulkBusy === "approve"} disabled={bulkBusy === "reject"} onClick={() => void runBulkDecision("approve")}>
                          <CheckCheck className="h-4 w-4" /> Approve selected
                        </Button>
                        <Button size="sm" variant="outline" loading={bulkBusy === "reject"} disabled={bulkBusy === "approve"} onClick={() => void runBulkDecision("reject")}>
                          <X className="h-4 w-4" /> Reject selected
                        </Button>
                      </div>
                    )}
                    {visibleTotal > 0 && tabsBlock}
                  </>
                )}
              </>
            )
          ) : historyTotal === 0 ? (
            <EmptyState icon={History} title="No decided requests yet" description="Requests you approve, reject, or that get cancelled will appear here." />
          ) : (
            tabsBlock
          )}
        </>
      )}
      <RejectDialog target={rejecting} onClose={() => setRejecting(null)} onRejected={settle} />
    </div>
  );
}
