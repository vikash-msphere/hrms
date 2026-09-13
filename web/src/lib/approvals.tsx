import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useCollection } from "@/hooks/useCollection";
import { get } from "@/api";
import { subscribeInvalidations, storedCopiesTrusted, storedIdentity, subscribePurge } from "@/lib/resourceStore";
import { registerHydrator, put, del } from "@/lib/clientStore";
import type { LeaveRequest, Reimbursement, OvertimeRequest, RemoteWorkRequest, AttendanceRegularization, LeaveEncashment, Loan, TimeEntry, Expense, AssetRequest } from "@/types";

// A prior-employer tax declaration awaiting HR/payroll verification (GET /v1/tax-verifications). Not a
// collection row - a bespoke queue assembled server-side from the encrypted per-employee tax blob - so it
// rides its own field on the state, not the generic ApprovalsBuckets. The verify/reject action is a PATCH to
// employees/<id>/tax, handled by its own inbox section (not the generic ApprovalRow).
export type TaxVerification = { employee: string; employee_name: string; prior_employer_income: number; prior_employer_tds: number };

// Shared source of "things awaiting my decision", consumed by both the sidebar count badge and the pages that
// show the queues - so the badge and a page never disagree, and deciding on a page updates the badge.
//
// The BADGE is a count, not rows: `GET /v1/approvals-summary` answers it in one request that returns numbers,
// gated per queue by the same `approve` decision the rows would get. Reading the ten collections for it (which
// is what this provider used to do) cost eleven list requests on EVERY page in the app, for one number.
//
// The ROWS are fetched only for the queues the current page actually renders (`queues`, chosen per route in
// App.tsx). A queue nobody is showing stays empty here - which is why every consumer must read `total` for
// counts and treat the buckets as "what this page asked for".
export type ApprovalsBuckets = {
  leaves: LeaveRequest[];
  reimbs: Reimbursement[];
  overtimes: OvertimeRequest[];
  remotes: RemoteWorkRequest[];
  regularizations: AttendanceRegularization[];
  encashments: LeaveEncashment[];
  loans: Loan[];
  timeEntries: TimeEntry[];
  expenses: Expense[];
  assetRequests: AssetRequest[];
};
// `total` is the server's count across EVERY queue the caller may decide in (including ones this page didn't
// load rows for); the top-level buckets are the PENDING inbox for the loaded queues; `history` is the
// already-decided requests the caller can see (approved/rejected/cancelled/…) from those same rows, so the
// page can show an audit trail alongside the live queue.
type ApprovalsState = ApprovalsBuckets & {
  // True while a queue this route asked for is still on its way and nothing has arrived. Without it the page
  // cannot tell an empty inbox from an unread one, and "You're all caught up" is a claim a manager acts on -
  // it was being made before a single queue had been read.
  loading: boolean;
  // A queue that failed to load contributes no rows, which is indistinguishable from a queue with nothing in
  // it - so without this a failed read renders as "You're all caught up", the most confidently wrong thing
  // this page could say. Holds the first failure's message.
  error: string | null;
  total: number;
  counts: Record<string, number>; // queue (collection id) -> awaiting count, straight from the server
  history: ApprovalsBuckets;
  taxVerifications: TaxVerification[];
  reload: () => void;
};

const EMPTY_BUCKETS: ApprovalsBuckets = { leaves: [], reimbs: [], overtimes: [], remotes: [], regularizations: [], encashments: [], loans: [], timeEntries: [], expenses: [], assetRequests: [] };
// `loading: false` outside a provider: nothing is coming, so a consumer of the default renders its zero state.
const EMPTY: ApprovalsState = { loading: false, error: null, total: 0, counts: {}, ...EMPTY_BUCKETS, history: EMPTY_BUCKETS, taxVerifications: [], reload: () => {} };
const ApprovalsContext = createContext<ApprovalsState>(EMPTY);
export const useApprovals = () => useContext(ApprovalsContext);

// The collections the pending queue is assembled from. Exported so a page can warn when any of them came
// back truncated: the queue filters CACHED rows, so a request sitting past the first page would never appear
// for approval, and nothing on screen would hint that it exists.
export const APPROVAL_COLLECTIONS = [
  "leave-requests", "reimbursements", "overtime-requests", "remote-work-requests",
  "attendance-regularizations", "leave-encashments", "loans", "time-entries", "expenses", "asset-requests",
];
// The tax queue is not a collection, but a page asks for it the same way (see QUEUES_BY_ROUTE in App.tsx).
export const TAX_VERIFICATIONS_QUEUE = "tax-verifications";

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

type Summary = { counts?: Record<string, number>; total?: number };

// The badge counts, kept across page loads. They are derived entirely from the approval collections, and the
// store's change feed reports whether any of those has been written to - so an unchanged queue set means the
// stored numbers are still the right numbers, and the page load costs no request for them. A write anywhere in
// a queue invalidates that collection, which the subscription below turns into a refresh.
const SUMMARY_KEY = "approvals-summary";
let storedSummary: Summary | null = null;

registerHydrator("snapshot", {
  onRecords: (records) => {
    const rec = records.find((r) => r.key === SUMMARY_KEY);
    if (!rec) return;
    try {
      const parsed = JSON.parse(rec.value) as Summary;
      if (parsed && typeof parsed === "object") storedSummary = parsed;
    } catch {
      /* unparseable: the badge costs its request this load, as it did before any of this */
    }
  },
  onEvict: () => {
    storedSummary = null;
  },
  // A different caller decides in different queues, so the counts are not theirs.
  onReset: () => {
    storedSummary = null;
  },
});

// A whole-store purge means the caller's rights changed: which queues they may decide in is exactly what these
// counts are about, so the stored numbers are not theirs to keep.
subscribePurge(() => {
  storedSummary = null;
  del("snapshot", SUMMARY_KEY);
});

function readSummaryDisk(): Summary | null {
  return storedIdentity() ? storedSummary : null;
}

function writeSummaryDisk(s: Summary) {
  if (!storedIdentity()) return;
  storedSummary = s;
  put("snapshot", SUMMARY_KEY, JSON.stringify(s));
}

function ActiveProvider({ queues, withHistory, children }: { queues: readonly string[]; withHistory: boolean; children: ReactNode }) {
  // The badge: counts only, one request, every queue the caller may decide in. A caller who may decide in none
  // gets an empty map (the endpoint queries nothing for them).
  const [summary, setSummary] = useState<Summary>(() => readSummaryDisk() ?? {});
  const loadSummary = useCallback(async () => {
    try {
      const fresh = await get<Summary>("approvals-summary");
      setSummary(fresh);
      writeSummaryDisk(fresh);
    } catch {
      setSummary({}); // a failed count is a hidden badge, never a wrong one
    }
  }, []);
  useEffect(() => {
    // Stored numbers the change feed vouches for are the numbers: nothing to ask. If any queue HAS been
    // written to, the feed invalidates that collection and the subscription below re-reads them.
    if (storedCopiesTrusted() && readSummaryDisk()) return;
    void loadSummary();
  }, [loadSummary]);
  // The count is not a collection, so the store's write-invalidation can't refresh it. Listen for it instead:
  // any write to a queue (this tab's or a sibling's) re-reads the number, so approving from anywhere - the
  // inbox, a page's inline action - moves the badge without the page having to remember to ask.
  useEffect(
    () => subscribeInvalidations((cols) => { if (cols.some((c) => APPROVAL_COLLECTIONS.includes(c))) void loadSummary(); }),
    [loadSummary],
  );

  // Rows for the queues THIS page renders - and, for a page that only shows what is PENDING, only for the
  // queues the count says have something in them. That is what keeps the read list short: an org with two live
  // requests reads two collections, not ten, and the dashboard's first batch stays under the batch:run
  // sub-request cap instead of spilling into a second, smaller one.
  //
  // The inbox is the exception (`withHistory`): its History tab lists what was already DECIDED, which no pending
  // count can tell it about, so it reads every queue it was given.
  const wants = useMemo(() => new Set(queues), [queues]);
  const counts = summary.counts;
  const wanted = useCallback(
    (collection: string) => wants.has(collection) && (withHistory || (counts?.[collection] ?? 0) > 0),
    [wants, withHistory, counts],
  );
  const leave = useCollection<LeaveRequest>("leave-requests", { enabled: wanted("leave-requests") });
  const reimb = useCollection<Reimbursement>("reimbursements", { enabled: wanted("reimbursements") });
  const overtime = useCollection<OvertimeRequest>("overtime-requests", { enabled: wanted("overtime-requests") });
  const remote = useCollection<RemoteWorkRequest>("remote-work-requests", { enabled: wanted("remote-work-requests") });
  const regular = useCollection<AttendanceRegularization>("attendance-regularizations", { enabled: wanted("attendance-regularizations") });
  const encash = useCollection<LeaveEncashment>("leave-encashments", { enabled: wanted("leave-encashments") });
  const loan = useCollection<Loan>("loans", { enabled: wanted("loans") });
  const time = useCollection<TimeEntry>("time-entries", { enabled: wanted("time-entries") });
  const expense = useCollection<Expense>("expenses", { enabled: wanted("expenses") });
  const assetReq = useCollection<AssetRequest>("asset-requests", { enabled: wanted("asset-requests") });

  // Tax verifications are a bespoke endpoint, not a collection, and it scans the employees it decides on - so
  // the ROWS are read only where the inbox lists them. The badge counts them through the summary above.
  const wantTax = wants.has(TAX_VERIFICATIONS_QUEUE);
  const [taxVerifications, setTaxVerifications] = useState<TaxVerification[]>([]);
  const loadTax = useCallback(async () => {
    if (!wantTax) return;
    try {
      const r = await get<{ results: TaxVerification[] }>("tax-verifications");
      setTaxVerifications(r.results ?? []);
    } catch {
      setTaxVerifications([]); // a caller without the capability gets 403 -> the section stays hidden
    }
  }, [wantTax]);
  useEffect(() => { void loadTax(); }, [loadTax]);

  const leaves = useMemo(() => pending(leave.rows), [leave.rows]);
  const reimbs = useMemo(() => pending(reimb.rows), [reimb.rows]);
  const overtimes = useMemo(() => pending(overtime.rows), [overtime.rows]);
  const remotes = useMemo(() => pending(remote.rows), [remote.rows]);
  const regularizations = useMemo(() => pending(regular.rows), [regular.rows]);
  const encashments = useMemo(() => pending(encash.rows), [encash.rows]);
  const loans = useMemo(() => awaiting(loan.rows, (r) => r.status, "PENDING"), [loan.rows]);
  const timeEntries = useMemo(() => awaiting(time.rows, (r) => r.status, "SUBMITTED"), [time.rows]);
  // Company expenses call the awaiting state SUBMITTED, and a recurring TEMPLATE is never awaiting anything
  // (it stays DRAFT and only seeds real expenses), so it can't reach the queue.
  const expenses = useMemo(() => awaiting(expense.rows.filter((r) => !r.recurring), (r) => r.state, "SUBMITTED"), [expense.rows]);
  // Only the decision is an approval: an APPROVED asset request is waiting on a hand-over (`:issue` from the
  // person's profile), not on anybody's judgement, so it leaves the queue as soon as it is decided.
  const assetRequests = useMemo(() => pending(assetReq.rows), [assetReq.rows]);

  // Refetch what this page is showing, plus the badge. A disabled collection's reload is a no-op read-through,
  // so this stays correct whichever queues the route asked for.
  //
  // The reloaders are DESTRUCTURED first. Written as `leave.reload()` with `leave.reload` in the dependency
  // array, every entry was a member expression the linter cannot check - so it asked for the ten whole
  // collection objects instead, which change on every fetch and would rebuild this callback (and re-run
  // everything keyed to it) each time any queue refreshed. Naming the functions keeps the array checkable AND
  // keeps its identity tied to the ten functions rather than to the data behind them.
  const { reload: reloadLeave } = leave;
  const { reload: reloadReimb } = reimb;
  const { reload: reloadOvertime } = overtime;
  const { reload: reloadRemote } = remote;
  const { reload: reloadRegular } = regular;
  const { reload: reloadEncash } = encash;
  const { reload: reloadLoan } = loan;
  const { reload: reloadTime } = time;
  const { reload: reloadExpense } = expense;
  const { reload: reloadAssetReq } = assetReq;
  const reload = useCallback(() => {
    if (wanted("leave-requests")) reloadLeave();
    if (wanted("reimbursements")) reloadReimb();
    if (wanted("overtime-requests")) reloadOvertime();
    if (wanted("remote-work-requests")) reloadRemote();
    if (wanted("attendance-regularizations")) reloadRegular();
    if (wanted("leave-encashments")) reloadEncash();
    if (wanted("loans")) reloadLoan();
    if (wanted("time-entries")) reloadTime();
    if (wanted("expenses")) reloadExpense();
    if (wanted("asset-requests")) reloadAssetReq();
    void loadTax();
    void loadSummary();
  }, [wanted, reloadLeave, reloadReimb, reloadOvertime, reloadRemote, reloadRegular, reloadEncash, reloadLoan, reloadTime, reloadExpense, reloadAssetReq, loadTax, loadSummary]);

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
      expenses: decided(expense.rows.filter((r) => !r.recurring), (r) => r.state),
      assetRequests: decided(assetReq.rows, (r) => r.state),
    }),
    [leave.rows, reimb.rows, overtime.rows, remote.rows, regular.rows, encash.rows, loan.rows, time.rows, expense.rows, assetReq.rows],
  );

  // Only the ENABLED queues count: a disabled collection sits at its initial state forever, so including it
  // would leave the page waiting on a read that is never issued. A queue that has already delivered rows is
  // not "loading" either, even while it revalidates - the reader has something true to look at.
  //
  // THE FLAG TRAVELS WITH THE READ, which is what makes that paragraph true. Written as a bare array, the rule
  // was stated here and implemented nowhere: `useCollection` with `enabled: false` still calls `getSnapshot`,
  // which MINTS an entry in state "loading" with no rows (lib/resourceStore.ts) and never fetches it - so a
  // disabled queue satisfies the predicate for the life of the page. Only the inbox reads `loading` today, and
  // its route asks for every queue WITH history, so all ten are enabled and the bug was invisible; every other
  // route leaves most of them off (and, with `withHistory` false, disables even a listed queue whose server
  // count is zero), so the first page to render a spinner or an empty state off this would have rendered it
  // permanently - and it would have read as a data problem rather than a predicate one.
  const reads: [boolean, { state: string; rows: unknown[]; error?: string | null }][] = [
    [wanted("leave-requests"), leave],
    [wanted("reimbursements"), reimb],
    [wanted("overtime-requests"), overtime],
    [wanted("remote-work-requests"), remote],
    [wanted("attendance-regularizations"), regular],
    [wanted("leave-encashments"), encash],
    [wanted("loans"), loan],
    [wanted("time-entries"), time],
    [wanted("expenses"), expense],
    [wanted("asset-requests"), assetReq],
  ];
  const active = reads.filter(([on]) => on).map(([, q]) => q);
  const loading = active.some((q) => q.state === "loading" && q.rows.length === 0);
  // A caller without a capability gets a 403 that `useCollection` isolates into an empty collection rather
  // than an error, so this only fires on a real failure to read something the caller may read. Over the same
  // enabled set: an entry nobody fetched has no error to report either, and pretending otherwise would only
  // be right by accident.
  const error = active.find((q) => q.state === "error")?.error ?? null;

  const value = useMemo<ApprovalsState>(
    () => ({
      loading,
      error,
      total: summary.total ?? 0,
      counts: summary.counts ?? {},
      leaves, reimbs, overtimes, remotes, regularizations, encashments, loans, timeEntries, expenses, assetRequests, taxVerifications, history, reload,
    }),
    [loading, error, summary, leaves, reimbs, overtimes, remotes, regularizations, encashments, loans, timeEntries, expenses, assetRequests, taxVerifications, history, reload],
  );
  return <ApprovalsContext.Provider value={value}>{children}</ApprovalsContext.Provider>;
}

// When the caller can't approve anything, provide the static empty state and skip all fetching.
export function ApprovalsProvider({
  enabled,
  queues,
  history = false,
  children,
}: {
  enabled: boolean;
  queues: readonly string[];
  /** The route also lists DECIDED requests (the inbox's History tab), so its queues are read regardless of
   *  whether anything is pending in them. */
  history?: boolean;
  children: ReactNode;
}) {
  if (!enabled) return <ApprovalsContext.Provider value={EMPTY}>{children}</ApprovalsContext.Provider>;
  return <ActiveProvider queues={queues} withHistory={history}>{children}</ActiveProvider>;
}
