import * as React from "react";
import { useState } from "react";
import { Check, X, ExternalLink, type LucideIcon } from "lucide-react";
import { invoke } from "@/api";
import { navigate } from "@/router";
import { idOf, formatDate } from "@/lib/utils";
import { requestRoute } from "@/lib/resourceRoute";
import { RowActivityButton } from "@/components/common/RowActivityButton";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { AccessAction } from "@/components/access/AccessAction";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/components/ui/use-toast";
import { useAskReason, useConfirm } from "@/components/common/confirm";
import { askRejectReason, confirmDecision } from "@/lib/confirmDecision";
import { useSelfApprovalAllowed } from "@/lib/approvals";

// One pending request, rendered the same wherever a decision can be made: the unified Approvals inbox, and the
// per-feature pages that surface their own slice of the queue (Leaves' "Pending your decision" band). Shared so
// the two can't drift on what an approver sees - the waiting time, the per-object ACL gate, and the reject-with-
// a-reason prompt are decision-safety properties, not decoration.

// The minimum shape every approvable row shares: an id/etag and the per-object verb hints the server attaches.
export type Approvable = { path: string; etag?: string; create_time?: string; update_time?: string; access?: { can?: string[] } };

// How long a request has been sitting in the inbox, from its create time.
export const waitingDays = (t?: string) => (t ? Math.max(0, Math.floor((Date.now() - +new Date(t)) / 86_400_000)) : 0);
export const waitingLabel = (d: number) => (d === 0 ? "Today" : d === 1 ? "1 day" : `${d} days`);

// A single pending item: who raised it, a one-line summary, decision context, and inline approve/reject.
// Buttons follow the row's own `access.can` so this respects per-object ACLs exactly like each source page does.
export function ApprovalRow({
  collection,
  row,
  employeeId,
  selfEmployeeId,
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
  // The viewer's own employee id: their own request opens on their self-service page, anybody else's on the
  // requester's profile.
  selfEmployeeId?: string | null;
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
  // Usually `() => reject(target)` from useRejectRequest; the Reject button spins on the promise it returns.
  onRejectClick: () => unknown;
  // Multi-select for bulk approve/reject (pending mode only). Undefined = row not selectable.
  checked?: boolean;
  onCheckedChange?: () => void;
}) {
  const waited = waitingDays(row.create_time);
  // The request itself, as the requester's record lists it - not the collection's page, which is the
  // decider's OWN requests.
  const openRoute = requestRoute(collection, row.path, employeeId, selfEmployeeId, !!decidedState);
  const waitLabel = waited === 0 ? "Today" : `Waiting ${waitingLabel(waited)}`;
  return (
    // One row on a tablet and up. On a phone the action cluster alone (activity, open, approve, reject) wants
    // ~300px, which on a 390px screen leaves the request itself nothing: the name truncates to an initial and
    // the summary - what is actually being decided - disappears. So the decision moves to its own line under
    // the request, where the buttons can be full-sized and the text can be read first.
    <div className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-3">
      <div className="flex min-w-0 items-center gap-3">
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
          {/* MASKED from session replay. This one line is the only cross-PERSON financial detail in the app
              that renders on an unmasked route: an approver's queue puts several colleagues' loan principals,
              reimbursement amounts and descriptions, encashment payouts and expense invoice numbers on one
              screen, and `loans` is in MEMORY_ONLY for exactly that content. Masking it here rather than at
              each caller covers every mount of this row (Approvals, Dashboard, Leaves, Expenses,
              LeaveCalendar) and cannot be forgotten by the next one. The name above stays readable - a replay
              of an approvals queue with no names in it says nothing about what was being triaged. */}
          <p className="truncate text-sm text-muted-foreground" data-sentry-mask>{summary}</p>
          {context && <p className="truncate text-xs text-muted-foreground" data-sentry-mask>{context}</p>}
          {/* How long it has waited is the queue's priority signal - too useful to drop on the device where
              the queue gets triaged. On a phone it rides here instead of in its own column. */}
          {!decidedState && (
            <p className={`text-xs sm:hidden ${waited >= 7 ? "font-medium text-warning" : "text-muted-foreground"}`}>{waitLabel}</p>
          )}
        </div>
      </div>
      {decidedState ? (
        <DecidedBadge state={decidedState} />
      ) : (
        <span
          className={`hidden shrink-0 text-xs sm:block ${waited >= 7 ? "font-medium text-warning" : "text-muted-foreground"}`}
          title={row.create_time ? `Requested ${formatDate(row.create_time)}` : undefined}
        >
          {waitLabel}
        </span>
      )}
      {/* Indented to the text above it on a phone (past the avatar), so the actions read as belonging to this
          request rather than to the list. Approve/Reject share the leftover width as real targets. */}
      <div className="flex items-center gap-1.5 pl-12 sm:ml-auto sm:shrink-0 sm:pl-0">
        <RowActivityButton resource={row.path} />
        {openRoute && (
          <Button size="sm" variant="ghost" onClick={() => navigate(openRoute)} title="Open this request" aria-label="Open this request">
            <ExternalLink className="h-4 w-4" /> <span className="hidden sm:inline">Open</span>
          </Button>
        )}
        {!decidedState && (
          <DecisionButtons
            collection={collection}
            row={row}
            what={`${name}'s ${kind?.label?.toLowerCase() ?? "request"}`}
            onApproved={onApproved}
            onRejectClick={onRejectClick}
            wrapClassName="flex-1 sm:flex-none"
            buttonClassName="w-full coarse:h-10 sm:w-auto"
          />
        )}
      </div>
    </div>
  );
}

// The state each collection's request waits for a decision in. Most say PENDING on `state`; timesheets and company
// expenses say SUBMITTED, and loans keep theirs on `status` - the same values lib/approvals.tsx queues on.
const AWAITING: Record<string, { field: "state" | "status"; value: string }> = {
  "time-entries": { field: "status", value: "SUBMITTED" },
  loans: { field: "status", value: "PENDING" },
  expenses: { field: "state", value: "SUBMITTED" },
};
export function isAwaitingDecision(collection: string, row: object): boolean {
  const a = AWAITING[collection] ?? { field: "state", value: "PENDING" };
  return String((row as Record<string, unknown>)[a.field] ?? "").toUpperCase() === a.value;
}

// Approve / Reject on ONE request, wherever it is listed: the inbox row above, and the requester's own record
// (components/common/EmployeeRequests.tsx, the profile's leave history, the asset card). Shared so every surface
// asks the same confirmation and gates on the same things: the request is still awaiting a decision, and the
// row's own `access.can` names the verb (hidden otherwise, never disabled). Reject only calls back - the caller
// owns the rejection (useRejectRequest, below, asks for the required reason and fires it).
//
// `own`: the viewer's own request. The server refuses deciding one's own in one's favour unless the org allows
// self-approval (services/decisionGuard.ts), so the buttons are not offered there either.
export function DecisionButtons({
  collection,
  row,
  what,
  own = false,
  onApproved,
  onRejectClick,
  wrapClassName,
  buttonClassName,
}: {
  collection: string;
  row: Approvable;
  /** What is being decided, for the confirmation ("Asha's remote work"). */
  what: string;
  own?: boolean;
  onApproved?: (path: string) => void;
  onRejectClick: () => unknown;
  // The flex sizing lives on a wrapper, not on AccessAction: that component renders its children through
  // AccessTarget and takes no class of its own.
  wrapClassName?: string;
  buttonClassName?: string;
}) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const allowSelf = useSelfApprovalAllowed();
  const can = row.access?.can ?? [];
  const ref = { collection, objectPath: row.path, can };
  // Approving is one click next to a dozen identical rows, and it notifies the requester and commits whatever
  // they asked for. Rejection already asks (for its reason, through the caller), so this is the half that was
  // missing.
  async function approve() {
    if (!(await confirmDecision(confirm, "approve", what))) return;
    setBusy(true);
    try {
      await invoke(`${collection}/${idOf(row.path)}`, "approve", row.etag);
      toast({ title: "Approved", variant: "success" });
      onApproved?.(row.path);
    } catch (e) {
      toast({ title: "Couldn't update", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }
  if (!isAwaitingDecision(collection, row) || (own && !allowSelf)) return null;
  return (
    <>
      {can.includes("approve") && (
        <span className={wrapClassName}>
          <AccessAction {...ref} verb="approve" label="Approve">
            <Button size="sm" variant="success" loading={busy} onClick={approve} className={buttonClassName}><Check className="h-4 w-4" /> Approve</Button>
          </AccessAction>
        </span>
      )}
      {can.includes("reject") && (
        <span className={wrapClassName}>
          <AccessAction {...ref} verb="reject" label="Reject">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onRejectClick()} className={buttonClassName}><X className="h-4 w-4" /> Reject</Button>
          </AccessAction>
        </span>
      )}
    </>
  );
}

// Terminal-state badge for the history view (approved/rejected/cancelled/other).
export function DecidedBadge({ state }: { state: string }) {
  const s = state.toUpperCase();
  const variant = s === "APPROVED" || s === "DISBURSED" || s === "CLOSED" ? "success" : s === "REJECTED" ? "destructive" : "muted";
  const label = s.charAt(0) + s.slice(1).toLowerCase();
  return <Badge variant={variant} className="shrink-0">{label}</Badge>;
}

// What a rejection is acting on: the request, and how the row described it.
export type RejectTarget = { collection: string; row: Approvable; name: string; summary: React.ReactNode };

/**
 * Reject ONE request from wherever it is listed. Asks for the reason (lib/confirmDecision.ts#askRejectReason -
 * required, and sent to the requester), then fires `:reject` against the version the row was drawn from.
 * Resolves true when it was rejected, so a caller's button can spin on the returned promise. `onRejected` is
 * the caller's settle/reload.
 */
export function useRejectRequest(onRejected?: (path: string) => void) {
  const { toast } = useToast();
  const ask = useAskReason();
  return React.useCallback(async (target: RejectTarget): Promise<boolean> => {
    const reason = await askRejectReason(ask, `${target.name}'s request`, target.summary);
    if (reason === null) return false;
    try {
      await invoke(`${target.collection}/${idOf(target.row.path)}`, "reject", target.row.etag, { reason });
      toast({ title: "Rejected", variant: "success" });
      onRejected?.(target.row.path);
      return true;
    } catch (e) {
      toast({ title: "Couldn't update", description: (e as Error).message, variant: "destructive" });
      return false;
    }
  }, [ask, toast, onRejected]);
}
