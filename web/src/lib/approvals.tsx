import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useCollection } from "@/hooks/useCollection";
import { get } from "@/api";
import type { LeaveRequest, Reimbursement, OvertimeRequest, RemoteWorkRequest, AttendanceRegularization, LeaveEncashment, Loan, TimeEntry } from "@/types";

// A prior-employer tax declaration awaiting HR/payroll verification (GET /v1/tax-verifications). Not a
// collection row - a bespoke queue assembled server-side from the encrypted per-employee tax blob - so it
// rides its own field on the state, not the generic ApprovalsBuckets. The verify/reject action is a PATCH to
// employees/<id>/tax, handled by its own inbox section (not the generic ApprovalRow).
export type TaxVerification = { employee: string; employee_name: string; prior_employer_income: number; prior_employer_tds: number };

// Shared source of "things awaiting my decision", fetched ONCE for the whole session (only for callers who
// can approve something) and consumed by both the sidebar count badge and the Approvals inbox - so the badge
// and the page never disagree, and approving on the page updates the badge via the same `reload`.
export type ApprovalsBuckets = {
  leaves: LeaveRequest[];
  reimbs: Reimbursement[];
  overtimes: OvertimeRequest[];
  remotes: RemoteWorkRequest[];
  regularizations: AttendanceRegularization[];
  encashments: LeaveEncashment[];
  loans: Loan[];
  timeEntries: TimeEntry[];
};
// `total` + the top-level buckets are the PENDING inbox (awaiting the caller's decision); `history` is every
// already-decided request the caller can see (approved/rejected/cancelled/…), so the page can show a full
// audit trail alongside the live queue.
type ApprovalsState = ApprovalsBuckets & {
  total: number;
  history: ApprovalsBuckets;
  taxVerifications: TaxVerification[];
  reload: () => void;
};

const EMPTY_BUCKETS: ApprovalsBuckets = { leaves: [], reimbs: [], overtimes: [], remotes: [], regularizations: [], encashments: [], loans: [], timeEntries: [] };
const EMPTY: ApprovalsState = { total: 0, ...EMPTY_BUCKETS, history: EMPTY_BUCKETS, taxVerifications: [], reload: () => {} };
const ApprovalsContext = createContext<ApprovalsState>(EMPTY);
export const useApprovals = () => useContext(ApprovalsContext);

// The collections the pending queue is assembled from. Exported so the page can warn when any of them came
// back truncated: the queue filters CACHED rows, so a request sitting past the first page would never appear
// for approval, and nothing on screen would hint that it exists.
export const APPROVAL_COLLECTIONS = [
  "leave-requests", "reimbursements", "overtime-requests", "remote-work-requests",
  "attendance-regularizations", "leave-encashments", "loans", "time-entries",
];

const upper = (s?: string) => (s ?? "").toUpperCase();
const canApprove = (r: { access?: { can?: string[] } }) => (r.access?.can ?? []).includes("approve");
// Items the caller may approve, awaiting their decision. Most collections call the awaiting state PENDING on a
// `state` field; timesheets use `status: SUBMITTED`, loans use `status: PENDING` - so the awaiting value is
// passed per collection.
const awaiting = <T extends { access?: { can?: string[] } }>(rows: T[], status: (r: T) => string | undefined, value: string) =>
  rows.filter((r) => upper(status(r)) === value && canApprove(r));
const pending = <T extends { state: string; access?: { can?: string[] } }>(rows: T[]) => awaiting(rows, (r) => r.state, "PENDING");
// Decided (history): any terminal state - i.e. not awaiting a decision and not a pre-submission draft. Covers
// APPROVED/REJECTED/CANCELLED (state collections), plus loans' DISBURSED/CLOSED etc. Newest-decided first.
const NOT_DECIDED = new Set(["", "PENDING", "DRAFT", "SUBMITTED"]);
const decided = <T extends { update_time?: string }>(rows: T[], status: (r: T) => string | undefined) =>
  rows.filter((r) => !NOT_DECIDED.has(upper(status(r)))).sort((a, b) => (b.update_time ?? "").localeCompare(a.update_time ?? ""));

function ActiveProvider({ children }: { children: ReactNode }) {
  const leave = useCollection<LeaveRequest>("leave-requests");
  const reimb = useCollection<Reimbursement>("reimbursements");
  const overtime = useCollection<OvertimeRequest>("overtime-requests");
  const remote = useCollection<RemoteWorkRequest>("remote-work-requests");
  const regular = useCollection<AttendanceRegularization>("attendance-regularizations");
  const encash = useCollection<LeaveEncashment>("leave-encashments");
  const loan = useCollection<Loan>("loans");
  const time = useCollection<TimeEntry>("time-entries");
  // Tax verifications are a bespoke endpoint, not a collection. A caller without the tax-verifications capability
  // gets 403 -> empty (the section stays hidden). Refetched by `reload` alongside the collections.
  const [taxVerifications, setTaxVerifications] = useState<TaxVerification[]>([]);
  const loadTax = useCallback(async () => {
    try {
      const r = await get<{ results: TaxVerification[] }>("tax-verifications");
      setTaxVerifications(r.results ?? []);
    } catch {
      setTaxVerifications([]);
    }
  }, []);
  useEffect(() => { void loadTax(); }, [loadTax]);

  const leaves = useMemo(() => pending(leave.rows), [leave.rows]);
  const reimbs = useMemo(() => pending(reimb.rows), [reimb.rows]);
  const overtimes = useMemo(() => pending(overtime.rows), [overtime.rows]);
  const remotes = useMemo(() => pending(remote.rows), [remote.rows]);
  const regularizations = useMemo(() => pending(regular.rows), [regular.rows]);
  const encashments = useMemo(() => pending(encash.rows), [encash.rows]);
  const loans = useMemo(() => awaiting(loan.rows, (r) => r.status, "PENDING"), [loan.rows]);
  const timeEntries = useMemo(() => awaiting(time.rows, (r) => r.status, "SUBMITTED"), [time.rows]);

  const reload = useCallback(() => {
    leave.reload();
    reimb.reload();
    overtime.reload();
    remote.reload();
    regular.reload();
    encash.reload();
    loan.reload();
    time.reload();
    void loadTax();
  }, [leave.reload, reimb.reload, overtime.reload, remote.reload, regular.reload, encash.reload, loan.reload, time.reload, loadTax]);

  const history = useMemo<ApprovalsBuckets>(
    () => ({
      leaves: decided(leave.rows, (r) => r.state),
      reimbs: decided(reimb.rows, (r) => r.state),
      overtimes: decided(overtime.rows, (r) => r.state),
      remotes: decided(remote.rows, (r) => r.state),
      regularizations: decided(regular.rows, (r) => r.state),
      encashments: decided(encash.rows, (r) => r.state),
      loans: decided(loan.rows, (r) => r.status),
      timeEntries: decided(time.rows, (r) => r.status),
    }),
    [leave.rows, reimb.rows, overtime.rows, remote.rows, regular.rows, encash.rows, loan.rows, time.rows],
  );

  const value = useMemo<ApprovalsState>(
    () => ({
      total: leaves.length + reimbs.length + overtimes.length + remotes.length + regularizations.length + encashments.length + loans.length + timeEntries.length + taxVerifications.length,
      leaves, reimbs, overtimes, remotes, regularizations, encashments, loans, timeEntries, taxVerifications, history, reload,
    }),
    [leaves, reimbs, overtimes, remotes, regularizations, encashments, loans, timeEntries, taxVerifications, history, reload],
  );
  return <ApprovalsContext.Provider value={value}>{children}</ApprovalsContext.Provider>;
}

// When the caller can't approve anything, provide the static empty state and skip all fetching.
export function ApprovalsProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  if (!enabled) return <ApprovalsContext.Provider value={EMPTY}>{children}</ApprovalsContext.Provider>;
  return <ActiveProvider>{children}</ActiveProvider>;
}
