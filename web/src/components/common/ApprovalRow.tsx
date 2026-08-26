import * as React from "react";
import { useState } from "react";
import { Check, X, ExternalLink, type LucideIcon } from "lucide-react";
import { invoke } from "@/api";
import { navigate } from "@/router";
import { idOf, formatDate } from "@/lib/utils";
import { resourceRoute } from "@/lib/resourceRoute";
import { RowActivityButton } from "@/components/common/RowActivityButton";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { AccessAction } from "@/components/access/AccessAction";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";
import { confirmDecision } from "@/lib/confirmDecision";

// One pending request, rendered the same wherever a decision can be made: the unified Approvals inbox, and the
// per-feature pages that surface their own slice of the queue (Leaves' "Pending your decision" band). Shared so
// the two can't drift on what an approver sees - the waiting time, the per-object ACL gate, and the reject-with-
// note confirmation are decision-safety properties, not decoration.

// The minimum shape every approvable row shares: an id/etag and the per-object verb hints the server attaches.
export type Approvable = { path: string; etag?: string; create_time?: string; update_time?: string; access?: { can?: string[] } };

// Collections whose :reject verb accepts an optional `note` in the body (relayed to the requester).
export const REJECT_NOTE = new Set(["overtime-requests", "remote-work-requests", "asset-requests", "expenses"]);

// How long a request has been sitting in the inbox, from its create time.
export const waitingDays = (t?: string) => (t ? Math.max(0, Math.floor((Date.now() - +new Date(t)) / 86_400_000)) : 0);
export const waitingLabel = (d: number) => (d === 0 ? "Today" : d === 1 ? "1 day" : `${d} days`);

// A single pending item: who raised it, a one-line summary, decision context, and inline approve/reject.
// Buttons follow the row's own `access.can` so this respects per-object ACLs exactly like each source page does.
export function ApprovalRow({
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
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const can = row.access?.can ?? [];
  const ref = { collection, objectPath: row.path, can };
  const waited = waitingDays(row.create_time);
  // Approving from an inbox row is one click next to a dozen identical rows, and it notifies the requester
  // and commits whatever they asked for. Rejection already goes through its own dialog (it takes a note), so
  // this is the half that was missing.
  async function approve() {
    if (!(await confirmDecision(confirm, "approve", `${name}'s ${kind?.label?.toLowerCase() ?? "request"}`))) return;
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
          <p className="truncate text-sm text-muted-foreground">{summary}</p>
          {context && <p className="truncate text-xs text-muted-foreground">{context}</p>}
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
        {resourceRoute(collection) && (
          <Button size="sm" variant="ghost" onClick={() => navigate(resourceRoute(collection)!)} title="Open the source page" aria-label="Open the source page">
            <ExternalLink className="h-4 w-4" /> <span className="hidden sm:inline">Open</span>
          </Button>
        )}
        {/* The flex-1 lives on a wrapper, not on AccessAction: that component renders its children through
            AccessTarget and takes no class of its own. */}
        {!decidedState && can.includes("approve") && (
          <span className="flex-1 sm:flex-none">
            <AccessAction {...ref} verb="approve" label="Approve">
              <Button size="sm" variant="success" loading={busy} onClick={approve} className="w-full coarse:h-10 sm:w-auto"><Check className="h-4 w-4" /> Approve</Button>
            </AccessAction>
          </span>
        )}
        {!decidedState && can.includes("reject") && (
          <span className="flex-1 sm:flex-none">
            <AccessAction {...ref} verb="reject" label="Reject">
              <Button size="sm" variant="outline" disabled={busy} onClick={onRejectClick} className="w-full coarse:h-10 sm:w-auto"><X className="h-4 w-4" /> Reject</Button>
            </AccessAction>
          </span>
        )}
      </div>
    </div>
  );
}

// Terminal-state badge for the history view (approved/rejected/cancelled/other).
export function DecidedBadge({ state }: { state: string }) {
  const s = state.toUpperCase();
  const variant = s === "APPROVED" || s === "DISBURSED" || s === "CLOSED" ? "success" : s === "REJECTED" ? "destructive" : "muted";
  const label = s.charAt(0) + s.slice(1).toLowerCase();
  return <Badge variant={variant} className="shrink-0">{label}</Badge>;
}

// What the reject dialog is acting on.
export type RejectTarget = { collection: string; row: Approvable; name: string; summary: React.ReactNode };

// Reject confirmation: prevents the accidental one-click reject and, where the API supports it, carries an
// optional note back to the requester explaining why.
export function RejectDialog({ target, onClose, onRejected }: { target: RejectTarget | null; onClose: () => void; onRejected: (path: string) => void }) {
  const { toast } = useToast();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const supportsNote = !!target && REJECT_NOTE.has(target.collection);
  async function reject() {
    if (!target) return;
    setBusy(true);
    try {
      // already confirmed: this runs from the reject dialog's own button, which collected the reason.
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
