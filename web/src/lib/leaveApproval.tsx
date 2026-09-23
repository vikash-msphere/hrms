import * as React from "react";
import { formatDate, idOf } from "@/lib/utils";
import type { LeaveBalance, LeaveRequest } from "@/types";

// What an approver reads about a leave request before deciding, in one place: the unified Approvals inbox and
// the Leaves page's own "pending your decision" band render the identical summary + decision context. Two
// surfaces phrasing the same decision differently is how an approver learns to trust one and skim the other.

/** "Casual Leave · 3 Mar 2026 - 5 Mar 2026 · 3 days" */
export const leaveSummary = (r: LeaveRequest, typeName: (ref?: string) => string) =>
  `${typeName(r.leave_type)} · ${formatDate(r.start_date)} - ${formatDate(r.end_date)} · ${r.days} day${r.days === 1 ? "" : "s"}`;

/** Remaining balance for the requested type, when the caller may read it (undefined = not visible / untracked). */
export const leaveBalanceOf = (r: LeaveRequest, balances: LeaveBalance[]): number | undefined =>
  r.employee && r.leave_type
    ? balances.find((b) => b.employee && b.leave_type && idOf(b.employee) === idOf(r.employee!) && idOf(b.leave_type) === idOf(r.leave_type!))?.balance_days
    : undefined;

/** How many OTHER people already hold approved leave overlapping this request's dates. */
export function leaveOverlapCount(r: LeaveRequest, allLeave: LeaveRequest[]): number {
  const others = new Set<string>();
  for (const l of allLeave) {
    if (l.path === r.path || !l.employee || (l.state ?? "").toUpperCase() !== "APPROVED") continue;
    if (r.employee && idOf(l.employee) === idOf(r.employee)) continue;
    if (l.start_date <= r.end_date && l.end_date >= r.start_date) others.add(idOf(l.employee));
  }
  return others.size;
}

/** Balance + overlap + the requester's own reason, joined as one muted context line under the summary. */
export function leaveDecisionContext(r: LeaveRequest, balances: LeaveBalance[], allLeave: LeaveRequest[]): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const bal = leaveBalanceOf(r, balances);
  if (bal != null)
    parts.push(
      bal < r.days
        ? <span key="bal" className="font-medium text-destructive">Balance {bal}d - not enough for {r.days}d</span>
        : <span key="bal">Balance after: {Math.round((bal - r.days) * 10) / 10}d</span>,
    );
  const overlap = leaveOverlapCount(r, allLeave);
  if (overlap > 0) parts.push(<span key="ov" className="font-medium text-warning">{overlap} {overlap === 1 ? "person is" : "people are"} already off then</span>);
  // Policy the org waives rather than enforces (`soft_rules`): the request was allowed through carrying what
  // it breaks, and this is the decision it was carried to. A waiver the approver is never shown is a rule
  // that quietly does nothing, so it leads the line rather than trailing it.
  for (const w of r.policy_warnings ?? []) {
    parts.push(<span key={`pw-${w.code}`} className="font-medium text-warning">{w.message}</span>);
  }
  if (r.reason?.trim()) parts.push(<span key="why">"{r.reason.trim()}"</span>);
  if (parts.length === 0) return undefined;
  return parts.map((p, i) => (
    <React.Fragment key={i}>{i > 0 && <span aria-hidden> · </span>}{p}</React.Fragment>
  ));
}
