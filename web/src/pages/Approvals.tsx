import * as React from "react";
import { useMemo, useState } from "react";
import { CalendarCheck, ReceiptText, Hourglass, House, Check, X, CheckCheck, ExternalLink, Clock, Coins, Banknote, Timer, Inbox, Users, History, Landmark, type LucideIcon } from "lucide-react";
import { useCollection } from "@/hooks/useCollection";
import { navigate } from "@/router";
import { useApprovals, APPROVAL_COLLECTIONS } from "@/lib/approvals";
import { invoke, patch } from "@/api";
import { idOf, formatDate, formatMoney, cn } from "@/lib/utils";
import { useOrg, currencyDecimals } from "@/lib/org";
import { PageHeader } from "@/components/common/PageHeader";
import { RowActivityButton } from "@/components/common/RowActivityButton";
import { resourceRoute } from "@/lib/resourceRoute";
import { EmptyState } from "@/components/common/EmptyState";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { AccessAction } from "@/components/access/AccessAction";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirm } from "@/components/common/confirm";
import { bulkInvoke, mergeBulkResults, bulkSummary } from "@/lib/bulk";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import type { Employee, LeaveRequest, LeaveType, LeaveBalance, ReimbursementCategory, Project, Me, Reimbursement, OvertimeRequest, RemoteWorkRequest, AttendanceRegularization, LeaveEncashment, Loan, TimeEntry } from "@/types";
import type { ApprovalsBuckets, TaxVerification } from "@/lib/approvals";
import { TruncationNotice } from "@/components/common/TruncationNotice";

// The minimum shape every approvable row shares: an id/etag and the per-object verb hints the server attaches.
type Approvable = { path: string; etag?: string; create_time?: string; update_time?: string; access?: { can?: string[] } };

// A single inbox tab. `summary`/`context` erase to accept the heterogeneous union; the group() factory below
// preserves each tab's concrete row type at the call site so a renamed/removed field fails the typecheck.
type GroupDef = { key: string; label: string; icon: LucideIcon; collection: string; items: Approvable[]; summary: (r: Approvable) => React.ReactNode; context?: (r: Approvable) => React.ReactNode };
function group<T extends Approvable>(g: { key: string; label: string; icon: LucideIcon; collection: string; items: T[]; summary: (r: T) => React.ReactNode; context?: (r: T) => React.ReactNode }): GroupDef {
  return g as unknown as GroupDef;
}

// Each request type lives on its own page; "Open" jumps there from the unified inbox.

// Collections whose :reject verb accepts an optional `note` in the body (relayed to the requester).
const REJECT_NOTE = new Set(["overtime-requests", "remote-work-requests"]);

// How long a request has been sitting in the inbox, from its create time.
const waitingDays = (t?: string) => (t ? Math.max(0, Math.floor((Date.now() - +new Date(t)) / 86_400_000)) : 0);
const waitingLabel = (d: number) => (d === 0 ? "Today" : d === 1 ? "1 day" : `${d} days`);

// A single pending item: who raised it, a one-line summary, decision context, and inline approve/reject.
// Buttons follow the row's own `access.can` so this respects per-object ACLs exactly like each source page does.
function ApprovalRow({
  collection,
  row,
  employeeId,
  name,
  photo,
  summary,
  context,
  kind,
  decidedState,
  onApproved,
  onRejectClick,
  checked,
  onCheckedChange,
}: {
  collection: string;
  row: Approvable;
  employeeId?: string;
  name: string;
  photo?: string;
  summary: React.ReactNode;
  // Extra decision context (balance, overlaps, the requester's reason) so the approver can decide here.
  context?: React.ReactNode;
  // Type chip shown on the merged "All" stream, where rows of different kinds interleave.
  kind?: { label: string; icon: LucideIcon };
  // History mode: the terminal state to badge (approved/rejected/…); no action buttons, no waiting label.
  decidedState?: string;
  onApproved: (path: string) => void;
  onRejectClick: () => void;
  // Multi-select for bulk approve/reject (pending mode only). Undefined = row not selectable.
  checked?: boolean;
  onCheckedChange?: () => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const can = row.access?.can ?? [];
  const ref = { collection, objectPath: row.path, can };
  const waited = waitingDays(row.create_time);
  async function approve() {
    setBusy(true);
    try {
      await invoke(`${collection}/${idOf(row.path)}`, "approve", row.etag);
      toast({ title: "Approved", variant: "success" });
      onApproved(row.path);
    } catch (e) {
      toast({ title: "Couldn't update", description: (e as Error).message, variant: "destructive" });
      setBusy(false);
    }
  }
  return (
    <div className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
      {onCheckedChange && (
        <Checkbox checked={checked} onCheckedChange={onCheckedChange} aria-label={`Select ${name}'s request`} className="shrink-0" />
      )}
      <PhotoAvatar employeeId={employeeId ?? ""} name={name} photo={photo} className="h-9 w-9 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 truncate text-sm font-medium">
          {name}
          {kind && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[11px] font-normal text-muted-foreground">
              <kind.icon className="h-3 w-3" /> {kind.label}
            </span>
          )}
        </p>
        <p className="truncate text-sm text-muted-foreground">{summary}</p>
        {context && <p className="truncate text-xs text-muted-foreground">{context}</p>}
      </div>
      {decidedState ? (
        <DecidedBadge state={decidedState} />
      ) : (
        <span
          className={`hidden shrink-0 text-xs sm:block ${waited >= 7 ? "font-medium text-warning" : "text-muted-foreground"}`}
          title={row.create_time ? `Requested ${formatDate(row.create_time)}` : undefined}
        >
          {waited === 0 ? "Today" : `Waiting ${waitingLabel(waited)}`}
        </span>
      )}
      <div className="flex shrink-0 items-center gap-1.5">
        <RowActivityButton resource={row.path} />
        {resourceRoute(collection) && (
          <Button size="sm" variant="ghost" onClick={() => navigate(resourceRoute(collection)!)} title="Open the source page">
            <ExternalLink className="h-4 w-4" /> Open
          </Button>
        )}
        {!decidedState && can.includes("approve") && (
          <AccessAction {...ref} verb="approve" label="Approve">
            <Button size="sm" variant="success" loading={busy} onClick={approve}><Check className="h-4 w-4" /> Approve</Button>
          </AccessAction>
        )}
        {!decidedState && can.includes("reject") && (
          <AccessAction {...ref} verb="reject" label="Reject">
            <Button size="sm" variant="outline" disabled={busy} onClick={onRejectClick}><X className="h-4 w-4" /> Reject</Button>
          </AccessAction>
        )}
      </div>
    </div>
  );
}

// Terminal-state badge for the history view (approved/rejected/cancelled/other).
function DecidedBadge({ state }: { state: string }) {
  const s = state.toUpperCase();
  const variant = s === "APPROVED" || s === "DISBURSED" || s === "CLOSED" ? "success" : s === "REJECTED" ? "destructive" : "muted";
  const label = s.charAt(0) + s.slice(1).toLowerCase();
  return <Badge variant={variant} className="shrink-0">{label}</Badge>;
}

// What the reject dialog is acting on.
type RejectTarget = { collection: string; row: Approvable; name: string; summary: React.ReactNode };

// Reject confirmation: prevents the accidental one-click reject and, where the API supports it, carries an
// optional note back to the requester explaining why.
function RejectDialog({ target, onClose, onRejected }: { target: RejectTarget | null; onClose: () => void; onRejected: (path: string) => void }) {
  const { toast } = useToast();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const supportsNote = !!target && REJECT_NOTE.has(target.collection);
  async function reject() {
    if (!target) return;
    setBusy(true);
    try {
      await invoke(`${target.collection}/${idOf(target.row.path)}`, "reject", target.row.etag, supportsNote && note.trim() ? { note: note.trim() } : undefined);
      toast({ title: "Rejected", variant: "success" });
      onRejected(target.row.path);
      onClose();
    } catch (e) {
      toast({ title: "Couldn't update", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={!!target} onOpenChange={(o) => { if (!o && !busy) { setNote(""); onClose(); } }}>
      <DialogContent
        className="max-w-md"
        onKeyDown={(e) => {
          // Enter rejects unless typing in the note (where Enter should make a new line).
          if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) {
            e.preventDefault();
            if (!busy) void reject();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Reject this request?</DialogTitle>
          <DialogDescription>
            {target?.name}
            {target?.summary ? <> · {target.summary}</> : null}
          </DialogDescription>
        </DialogHeader>
        {supportsNote && (
          <Textarea
            autoFocus
            placeholder="Reason for rejecting (optional, shared with the requester)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => { setNote(""); onClose(); }}>Keep pending</Button>
          <Button variant="destructive" loading={busy} onClick={reject}><X className="h-4 w-4" /> Reject request</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Prior-employer tax declarations awaiting verification. A bespoke queue (not a collection), so it renders as
// its own inbox section with a Verify/Reject that PATCHes employees/<id>/tax - the server still enforces the
// maker-checker (you can't verify your own). Hidden for callers without the tax-verifications capability (the
// endpoint 403s -> empty rows).
function TaxVerificationsCard({ rows, money, onDone }: { rows: TaxVerification[]; money: (n: number) => string; onDone: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  async function decide(v: TaxVerification, action: "verify" | "reject") {
    setBusy(v.employee + action);
    try {
      await patch(`employees/${idOf(v.employee)}/tax`, { values: { action } });
      toast({ title: action === "verify" ? "Previous employer details verified" : "Declaration rejected", variant: "success" });
      onDone();
    } catch (e) {
      toast({ title: "Couldn't update", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }
  return (
    <Card className="mb-4">
      <CardContent className="pt-6">
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
                <p className="text-xs text-muted-foreground">Income {money(v.prior_employer_income)} · TDS {money(v.prior_employer_tds)}</p>
              </div>
              <div className="flex items-center gap-1.5">
                <Button size="sm" variant="outline" loading={busy === v.employee + "verify"} disabled={!!busy} onClick={() => decide(v, "verify")}><Check className="h-4 w-4" /> Verify</Button>
                <Button size="sm" variant="ghost" className="text-destructive" disabled={!!busy} onClick={() => decide(v, "reject")}><X className="h-4 w-4" /> Reject</Button>
              </div>
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
  const { org } = useOrg();
  const money = (n: number) => formatMoney(n, org.default_currency, currencyDecimals(undefined, org));

  const { rows: employees } = useCollection<Employee>("employees");
  const { rows: leaveTypes } = useCollection<LeaveType>("leave-types");
  const { rows: categories } = useCollection<ReimbursementCategory>("reimbursement-categories");
  const { rows: projects } = useCollection<Project>("projects");
  // Decision context for leave: the requester's remaining balance and who else is already off in that window.
  // Both are served scoped to what the caller may read, so these quietly stay blank for approvers without access.
  const { rows: balances } = useCollection<LeaveBalance>("leave-balances");
  const { rows: allLeave } = useCollection<LeaveRequest>("leave-requests");
  // Pending items + a shared reload come from the session-wide provider, so approving here also updates the
  // sidebar count badge.
  const { leaves, reimbs, overtimes, remotes, regularizations, encashments, loans, timeEntries, taxVerifications, total, history, reload } = useApprovals();

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

  const personOf = (p?: string) => {
    const e = emp(p);
    return { employeeId: p ? idOf(p) : undefined, name: e ? `${e.first_name} ${e.last_name}` : "Someone", photo: e?.photo };
  };

  // Remaining balance for the requested leave type, when the caller may read it.
  const balanceOf = (r: LeaveRequest): number | undefined =>
    r.employee && r.leave_type
      ? balances.find((b) => b.employee && b.leave_type && idOf(b.employee) === idOf(r.employee!) && idOf(b.leave_type) === idOf(r.leave_type!))?.balance_days
      : undefined;
  // How many OTHER people already have approved leave overlapping this request's dates.
  const overlapOf = (r: LeaveRequest): number => {
    const others = new Set<string>();
    for (const l of allLeave) {
      if (l.path === r.path || !l.employee || (l.state ?? "").toUpperCase() !== "APPROVED") continue;
      if (r.employee && idOf(l.employee) === idOf(r.employee)) continue;
      if (l.start_date <= r.end_date && l.end_date >= r.start_date) others.add(idOf(l.employee));
    }
    return others.size;
  };
  // Balance + overlap + the requester's own reason, joined as one muted context line under the summary.
  const leaveContext = (r: LeaveRequest): React.ReactNode => {
    const parts: React.ReactNode[] = [];
    const bal = balanceOf(r);
    if (bal != null)
      parts.push(
        bal < r.days
          ? <span key="bal" className="font-medium text-destructive">Balance {bal}d - not enough for {r.days}d</span>
          : <span key="bal">Balance after: {Math.round((bal - r.days) * 10) / 10}d</span>,
      );
    const overlap = overlapOf(r);
    if (overlap > 0) parts.push(<span key="ov" className="font-medium text-warning">{overlap} {overlap === 1 ? "person is" : "people are"} already off then</span>);
    if (r.reason?.trim()) parts.push(<span key="why">"{r.reason.trim()}"</span>);
    if (parts.length === 0) return undefined;
    return parts.map((p, i) => (
      <React.Fragment key={i}>{i > 0 && <span aria-hidden> · </span>}{p}</React.Fragment>
    ));
  };

  const bySubmitTime = <T extends Approvable>(rows: T[]) =>
    rows.filter((r) => !decided.has(r.path)).sort((a, b) => (a.create_time ?? "").localeCompare(b.create_time ?? ""));

  // Per-type one-line summaries, pulled out as typed consts so the pending inbox AND the history trail share
  // the exact same rendering (each keeps `r` typed to its row type, so a renamed field fails the typecheck).
  const sumReg = (r: AttendanceRegularization) => {
    const t = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const times = r.sessions.length === 0 ? "remove punches" : r.sessions.map((s) => `${t(s.clock_in)}–${t(s.clock_out)}`).join(", ");
    return `${formatDate(r.date)} · ${times}${r.reason ? ` · ${r.reason}` : ""}`;
  };
  const sumLeave = (r: LeaveRequest) => `${typeName(r.leave_type)} · ${formatDate(r.start_date)} – ${formatDate(r.end_date)} · ${r.days} day${r.days === 1 ? "" : "s"}`;
  const sumReimb = (r: Reimbursement) => `${money(r.amount)}${r.category ? ` · ${catName(r.category)}` : ""}${r.description ? ` · ${r.description}` : ""}`;
  const sumOt = (r: OvertimeRequest) => `${formatDate(r.date)} · ${Math.round(r.minutes / 6) / 10}h${r.reason ? ` · ${r.reason}` : ""}`;
  const sumRemote = (r: RemoteWorkRequest) => `${formatDate(r.start_date)} – ${formatDate(r.end_date)} · ${r.days} day${r.days === 1 ? "" : "s"}${r.reason ? ` · ${r.reason}` : ""}`;
  const sumEncash = (r: LeaveEncashment) => `${typeName(r.leave_type)} · ${r.days} day${r.days === 1 ? "" : "s"}${r.amount != null ? ` · ${money(r.amount)}` : ""}`;
  const sumLoan = (r: Loan) => `${r.kind === "advance" ? "Advance" : "Loan"} · ${money(r.principal)} · ${r.installments} installment${r.installments === 1 ? "" : "s"}${r.reason ? ` · ${r.reason}` : ""}`;
  const sumTime = (r: TimeEntry) => `${projName(r.project) ?? "Project"}${r.date ? ` · ${formatDate(r.date)}` : ""} · ${r.hours}h${r.description ? ` · ${r.description}` : ""}`;

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
      group({ key: "regularization", label: "Attendance", icon: Clock, collection: "attendance-regularizations", items: items(b.regularizations), summary: sumReg }),
      group({ key: "encashment", label: "Leave encashment", icon: Coins, collection: "leave-encashments", items: items(b.encashments), summary: sumEncash }),
      group({ key: "loan", label: "Loans & advances", icon: Banknote, collection: "loans", items: items(b.loans), summary: sumLoan }),
      group({ key: "timesheet", label: "Timesheets", icon: Timer, collection: "time-entries", items: items(b.timeEntries), summary: sumTime }),
    ];
  };
  const isHistory = mode === "history";
  const groups = isHistory
    ? buildGroups(history, true)
    : buildGroups({ leaves, reimbs, overtimes, remotes, regularizations, encashments, loans, timeEntries }, false);
  const activeGroups = groups.filter((g) => g.items.length > 0);
  const visibleTotal = activeGroups.reduce((n, g) => n + g.items.length, 0);
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

  const oldestWait = merged.length ? waitingDays(merged[0]!.r.create_time) : 0;
  const requesterCount = (() => {
    const s = new Set<string>();
    for (const { r } of merged) {
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
          <Card><CardContent className="divide-y pt-6">{merged.map(({ g, r }) => rowFor(g, r, true))}</CardContent></Card>
        </TabsContent>
      )}
      {activeGroups.map((g) => (
        <TabsContent key={g.key} value={g.key}>
          <Card><CardContent className="divide-y pt-6">{g.items.map((r) => rowFor(g, r, false))}</CardContent></Card>
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
      {total === 0 && historyTotal === 0 ? (
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
            visibleTotal === 0 && taxVerifications.length === 0 ? (
              <EmptyState icon={CheckCheck} title="You're all caught up" description="All pending requests have been decided." />
            ) : (
              <>
                {taxVerifications.length > 0 && <TaxVerificationsCard rows={taxVerifications} money={money} onDone={reload} />}
                {visibleTotal > 0 && (
                  <>
                    <SummaryStrip
                      items={[
                        { label: "Awaiting your decision", value: visibleTotal, icon: Inbox, tone: "warning" },
                        { label: "Longest waiting", value: waitingLabel(oldestWait), icon: Hourglass, tone: oldestWait >= 7 ? "warning" : "default", hint: oldestWait >= 7 ? "Getting stale - decide these first" : "Oldest request in the queue" },
                        { label: "People waiting", value: requesterCount, icon: Users },
                      ]}
                    />
                    {sel.size > 0 && (
                      <div className="sticky top-2 z-20 mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-card px-3 py-2 shadow-pop">
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
                    {tabsBlock}
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
