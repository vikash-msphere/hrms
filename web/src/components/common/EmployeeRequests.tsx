import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AlarmClock, Banknote, Clock, Coins, Hourglass, House, ReceiptText, Timer, type LucideIcon } from "lucide-react";
import { useCollection } from "@/hooks/useCollection";
import { useRoute } from "@/router";
import { cn, formatDate, formatMoney, idOf } from "@/lib/utils";
import { useOrg, currencyDecimals } from "@/lib/org";
import { REQUEST_PARAM } from "@/lib/resourceRoute";
import { KIND_LABEL, fmtMinutes, type LateEarlyKind } from "@/lib/lateEarly";
import type { AttendanceRegularization, LateEarlyRequest, LeaveEncashment, Loan, OvertimeRequest, Reimbursement, RemoteWorkRequest, TimeEntry } from "@/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/common/StatusBadge";
import { RowActivityButton } from "@/components/common/RowActivityButton";
import { TableSkeleton } from "@/components/common/Skeletons";
import { AccessAction } from "@/components/access/AccessAction";
import { DecisionButtons, RejectDialog, type Approvable, type RejectTarget } from "@/components/common/ApprovalRow";
import { describeCorrection } from "@/lib/attendance";

// One person's requests of one kind, on their record: the place an approver's "Open" lands. The self-service
// pages for these collections list only the caller's own requests, so somebody else's had no page at all.
//
// Rows come from the collection with `?employee=`, so the server's scope still decides - a caller who may not
// read this person's requests gets an empty card, which renders nothing. `?request=<collection>/<id>` in the
// address picks one row out: it is highlighted and scrolled to, so the link opens THAT request rather than a
// list the reader has to search.

/** How many rows a card shows. A profile answers "what has this person asked for lately", not the archive. */
const FOLD = 20;

export type EmployeeRequestKind =
  | "remote-work-requests"
  | "late-early-requests"
  | "attendance-regularizations"
  | "overtime-requests"
  | "time-entries"
  | "reimbursements"
  | "loans"
  | "leave-encashments";

type Row = Approvable;
type Spec<T extends Row> = {
  title: string;
  /** One of them, for the approve confirmation ("Asha's remote work request"). */
  noun: string;
  icon: LucideIcon;
  when: (r: T) => string | undefined;
  status: (r: T) => string | undefined;
  what: (r: T, ctx: Ctx) => React.ReactNode;
  // The decider's note, where the collection carries one.
  note?: (r: T) => string | null | undefined;
  // Name lookups a kind needs; read only when a card of that kind is on screen.
  needs?: "leave-types" | "projects" | "reimbursement-categories";
};
type Ctx = { money: (n: number) => string; name: (ref?: string | null) => string | undefined };

function spec<T extends Row>(s: Spec<T>): Spec<Row> {
  return s as unknown as Spec<Row>;
}

const SPECS: Record<EmployeeRequestKind, Spec<Row>> = {
  "remote-work-requests": spec<RemoteWorkRequest>({
    title: "Remote work",
    noun: "remote work request",
    icon: House,
    when: (r) => r.start_date,
    status: (r) => r.state,
    what: (r) => `${r.start_date === r.end_date ? formatDate(r.start_date) : `${formatDate(r.start_date)} – ${formatDate(r.end_date)}`} · ${r.days} day${r.days === 1 ? "" : "s"}${r.location ? ` · ${r.location}` : ""}${r.reason ? ` · ${r.reason}` : ""}`,
    note: (r) => r.decision_note,
  }),
  "late-early-requests": spec<LateEarlyRequest>({
    title: "Late arrival & early departure",
    noun: "late arrival / early departure request",
    icon: AlarmClock,
    when: (r) => r.date,
    status: (r) => r.state,
    what: (r) =>
      `${formatDate(r.date)} · ${KIND_LABEL[r.kind as LateEarlyKind] ?? r.kind} · ${r.kind === "early_departure" ? "leave at" : "in by"} ${r.at} (${fmtMinutes(r.minutes ?? 0)})${r.over_limit ? " · past the monthly allowance" : ""}${r.reason ? ` · ${r.reason}` : ""}`,
  }),
  "attendance-regularizations": spec<AttendanceRegularization>({
    title: "Attendance corrections",
    noun: "attendance correction",
    icon: Clock,
    when: (r) => r.date,
    status: (r) => r.state,
    what: (r) => {
      const t = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const times = describeCorrection(r.recorded_sessions, r.sessions, t, "remove punches");
      return `${formatDate(r.date)} · ${times}${r.reason ? ` · ${r.reason}` : ""}`;
    },
  }),
  "overtime-requests": spec<OvertimeRequest>({
    title: "Overtime",
    noun: "overtime request",
    icon: Hourglass,
    when: (r) => r.date,
    status: (r) => r.state,
    what: (r) => `${formatDate(r.date)} · ${Math.round(r.minutes / 6) / 10}h${r.reason ? ` · ${r.reason}` : ""}`,
  }),
  "time-entries": spec<TimeEntry>({
    title: "Timesheet entries",
    noun: "timesheet entry",
    icon: Timer,
    when: (r) => r.date,
    status: (r) => r.status,
    what: (r, c) => `${c.name(r.project) ?? "Project"}${r.date ? ` · ${formatDate(r.date)}` : ""} · ${r.hours}h${r.description ? ` · ${r.description}` : ""}`,
    needs: "projects",
  }),
  reimbursements: spec<Reimbursement>({
    title: "Reimbursements",
    noun: "reimbursement claim",
    icon: ReceiptText,
    when: (r) => r.incurred_on ?? r.create_time,
    status: (r) => r.state,
    what: (r, c) => `${c.money(r.amount)}${r.category ? ` · ${c.name(r.category) ?? "Claim"}` : ""}${r.description ? ` · ${r.description}` : ""}`,
    needs: "reimbursement-categories",
  }),
  loans: spec<Loan>({
    title: "Loans & advances",
    noun: "loan request",
    icon: Banknote,
    when: (r) => r.create_time,
    status: (r) => r.status,
    what: (r, c) => `${r.kind === "advance" ? "Advance" : "Loan"} · ${c.money(r.principal)} · ${r.installments} installment${r.installments === 1 ? "" : "s"}${r.reason ? ` · ${r.reason}` : ""}`,
  }),
  "leave-encashments": spec<LeaveEncashment>({
    title: "Leave encashments",
    noun: "leave encashment",
    icon: Coins,
    when: (r) => r.create_time,
    status: (r) => r.state,
    what: (r, c) => `${c.name(r.leave_type) ?? "Leave"} · ${r.days} day${r.days === 1 ? "" : "s"}${r.amount != null ? ` · ${c.money(r.amount)}` : ""}`,
    needs: "leave-types",
  }),
};

/** The `?request=` pick, when it names a row of `collection`: the row's id, else null. */
export function useFocusedRequest(collection: string): string | null {
  const ref = useRoute().query[REQUEST_PARAM];
  if (!ref) return null;
  const [col, id] = ref.split("/");
  return col === collection && id ? id : null;
}

/** Scrolls the focused row into view once it has rendered. */
export function useScrollToFocused<E extends HTMLElement = HTMLTableRowElement>(focusedId: string | null, ready: boolean) {
  const ref = useRef<E | null>(null);
  useEffect(() => {
    if (focusedId && ready) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusedId, ready]);
  return ref;
}

/** The row class for a request the address picked out. */
export const FOCUSED_ROW = "bg-primary/10 outline outline-2 -outline-offset-2 outline-primary/40";

// A row still awaiting a decision carries Approve / Reject when the row's own `access.can` names them - the same
// buttons and confirmation as the inbox (DecisionButtons), so opening a request from there loses nothing.
export function EmployeeRequests({ employeeId, employeeName, kind }: { employeeId: string; employeeName: string; kind: EmployeeRequestKind }) {
  const s = SPECS[kind];
  const [rejecting, setRejecting] = useState<RejectTarget | null>(null);
  const { rows: raw, state } = useCollection<Row>(kind, { params: { employee: `employees/${employeeId}` } });
  const { rows: lookup } = useCollection<{ path: string; display_name?: string; name?: string }>(s.needs ?? "leave-types", { all: true, enabled: !!s.needs });
  const { org } = useOrg();
  const focusedId = useFocusedRequest(kind);

  const ctx = useMemo<Ctx>(() => {
    const m = new Map(lookup.map((r) => [idOf(r.path), r.display_name ?? r.name ?? ""]));
    return {
      money: (n: number) => formatMoney(n, org.default_currency, currencyDecimals(undefined, org)),
      name: (ref) => (ref ? m.get(idOf(ref)) || undefined : undefined),
    };
  }, [lookup, org]);

  // Newest first; the picked-out row always makes the fold, wherever it sorts.
  const rows = useMemo(() => {
    const sorted = [...raw].sort((a, b) => (s.when(b) ?? "").localeCompare(s.when(a) ?? "") || (b.create_time ?? "").localeCompare(a.create_time ?? ""));
    const head = sorted.slice(0, FOLD);
    const picked = focusedId ? sorted.find((r) => idOf(r.path) === focusedId) : undefined;
    return picked && !head.includes(picked) ? [...head, picked] : head;
  }, [raw, s, focusedId]);
  const focusRef = useScrollToFocused(focusedId, state === "ready");

  if (state === "ready" && rows.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        {/* The card's own key: the tab it sits under names one collection and holds several of these. */}
        <CardTitle className="text-base">
          <AccessAction collection={kind} label={s.title}>
            <span className="flex items-center gap-2"><s.icon className="h-4 w-4 text-primary" /> {s.title}</span>
          </AccessAction>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {state !== "ready" && rows.length === 0 ? (
          <TableSkeleton rows={2} cols={3} />
        ) : (
          <div className="scroll-shadow-x [--scroll-ground:hsl(var(--card))] overflow-x-auto">
            <table className="table-stack w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Request</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 font-medium"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const focused = idOf(r.path) === focusedId;
                  const status = s.status(r) ?? "";
                  const note = s.note?.(r);
                  return (
                    <tr key={r.path} ref={focused ? focusRef : undefined} className={cn("border-b last:border-0", focused && FOCUSED_ROW)} aria-current={focused ? "true" : undefined}>
                      {/* Masked from session replay for the reason the approvals row is: amounts and reasons. */}
                      <td className="py-1.5 pr-3" data-sentry-mask>
                        {s.what(r, ctx)}
                        {note && <span className="block text-xs italic text-muted-foreground">“{note}”</span>}
                      </td>
                      <td data-label="Status" className="py-1.5 pr-3">{status && <StatusBadge state={status} />}</td>
                      <td className="py-1.5">
                        <div className="flex items-center justify-end gap-1.5">
                          <DecisionButtons
                            collection={kind}
                            row={r}
                            what={`${employeeName}'s ${s.noun}`}
                            onRejectClick={() => setRejecting({ collection: kind, row: r, name: employeeName, summary: s.what(r, ctx) })}
                            buttonClassName="coarse:h-10"
                          />
                          <RowActivityButton resource={r.path} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
      {/* The decision itself invalidates the collection (api.ts invoke), so the row re-reads as decided. */}
      <RejectDialog target={rejecting} onClose={() => setRejecting(null)} onRejected={() => {}} />
    </Card>
  );
}
