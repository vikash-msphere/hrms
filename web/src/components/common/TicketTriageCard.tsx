import { useState } from "react";
import { Sparkles, Copy, Check, X } from "lucide-react";
import { invoke } from "@/api";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { useAiFeature } from "@/lib/aiFeatures";

// The triage suggestion on a ticket: which servicing department, category and priority the nearest RESOLVED
// tickets carry, and which open ones may be the same problem.
//
// FETCHED ON REQUEST, not on open. The index query is metered, and a panel that fires on every ticket anyone
// glances at would spend the allowance on tickets nobody was triaging. It is also the honest affordance: an
// agent asks for a second opinion, they are not given one unasked.
//
// NOTHING HERE APPLIES ANYTHING. Accept calls the ticket's own `:route` / `:prioritize`, which is what puts
// the change through the normal service, its validation and its audit row; this component only reports what
// was decided so the accept rate is measurable. The buttons are wrapped in `AccessAction` on those verbs, so
// a caller who may not route a ticket is not shown a button that would fail.

export type TriageVote = { value: string; votes: number; of: number } | null;
export type Triage = {
  department: TriageVote;
  category: TriageVote;
  priority: TriageVote;
  basis: { id: string; subject: string; score: number }[];
  duplicates: { id: string; subject: string; score: number; state: string }[];
};

export function TicketTriageCard({ ticketPath, ticketId, can, deptName, onApplyDepartment, onApplyPriority, onOpenTicket }: {
  ticketPath: string;
  ticketId: string;
  can?: string[];
  deptName: (ref?: string) => string;
  onApplyDepartment: (ref: string) => Promise<boolean>;
  onApplyPriority: (priority: string) => Promise<boolean>;
  /**
   * Open a neighbour, or null when this page cannot. A neighbour is a ticket the caller may read, but the
   * open handler works off the list the page has LOADED, and a neighbour can easily sit outside the current
   * filter or page. Returning null for those lets the row render as text instead of as a button that does
   * nothing, which is the failure people report as "the link is broken".
   */
  onOpenTicket: (id: string) => (() => void) | null;
}) {
  const [triage, setTriage] = useState<Triage | null>(null);
  const [asked, setAsked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Gated inside the component, like the Draft button: the host page should not have to know that this is an
  // AI feature, and a "Suggest triage" button that answers "switched off" is a button that exists to fail.
  const enabled = useAiFeature("tickets.triage");

  async function ask() {
    setBusy(true);
    setError(null);
    try {
      const res = await invoke<{ triage: Triage | null }>(`tickets/${ticketId}`, "triage");
      setTriage(res.triage);
      setAsked(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const decide = (accepted: boolean) => invoke(`tickets/${ticketId}`, "decideTriage", undefined, { accepted }).catch(() => { /* measurement only, never the user's problem */ });

  if (!enabled) return null;

  if (!asked) {
    return (
      <div className="border-t pt-3">
        <Button size="sm" variant="outline" onClick={ask} disabled={busy}>
          <Sparkles className="h-4 w-4" /> {busy ? "Looking…" : "Suggest triage"}
        </Button>
        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      </div>
    );
  }

  // Asked and there is nothing to say. Stated plainly rather than left blank, because a button that appears
  // to do nothing reads as broken - and the reasons are all legitimate: a new ticket may not be indexed yet,
  // and a genuinely novel problem has no neighbours to learn from.
  if (!triage) {
    return (
      <div className="border-t pt-3">
        <p className="text-sm text-muted-foreground">
          No suggestion: nothing similar has been resolved yet, or this ticket has not been indexed yet (that
          happens within a few minutes of filing).
        </p>
      </div>
    );
  }

  const { department, category, priority, basis, duplicates } = triage;

  return (
    <div className="space-y-3 border-t pt-3">
      <h4 className="flex items-center gap-1.5 text-sm font-medium">
        <Sparkles className="h-4 w-4" /> Suggested triage
      </h4>

      {duplicates.length > 0 && (
        <div className="rounded-md border border-warning/40 bg-warning/5 p-3">
          <p className="text-sm font-medium text-warning">Possibly already reported</p>
          <ul className="mt-1 space-y-1">
            {duplicates.map((d) => (
              <li key={d.id}>
                <NeighbourLink id={d.id} subject={d.subject} onOpenTicket={onOpenTicket} />
                <span className="ml-1.5 text-xs text-muted-foreground">({d.state.toLowerCase().replace("_", " ")})</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {department && (
        <SuggestionRow
          label="Department"
          value={deptName(`departments/${department.value}`)}
          vote={department}
          verb="route"
          ticketPath={ticketPath}
          can={can}
          onAccept={async () => { if (await onApplyDepartment(`departments/${department.value}`)) void decide(true); }}
          onReject={() => void decide(false)}
        />
      )}
      {category && <SuggestionRow label="Category" value={category.value} vote={category} />}
      {priority && (
        <SuggestionRow
          label="Priority"
          value={priority.value}
          vote={priority}
          verb="prioritize"
          ticketPath={ticketPath}
          can={can}
          onAccept={async () => { if (await onApplyPriority(priority.value)) void decide(true); }}
          onReject={() => void decide(false)}
        />
      )}

      {basis.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Based on {basis.length} resolved {basis.length === 1 ? "ticket" : "tickets"}</summary>
          <ul className="mt-1 space-y-1 pl-4">
            {basis.map((n) => (
              <li key={n.id}><NeighbourLink id={n.id} subject={n.subject} onOpenTicket={onOpenTicket} /></li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** A neighbour's subject: a button when this page can open it, plain text when it cannot. */
function NeighbourLink({ id, subject, onOpenTicket }: { id: string; subject: string; onOpenTicket: (id: string) => (() => void) | null }) {
  const open = onOpenTicket(id);
  if (!open) return <span className="text-sm">{subject}</span>;
  return <button type="button" className="text-left text-sm underline underline-offset-2" onClick={open}>{subject}</button>;
}

/** One suggested field. Without a verb it is read-only: the category picker lives in the create dialog, so
 *  there is nothing on this page to apply it to, and offering a button that goes nowhere would be worse than
 *  showing the suggestion on its own. */
function SuggestionRow({ label, value, vote, verb, ticketPath, can, onAccept, onReject }: {
  label: string;
  value: string;
  vote: { votes: number; of: number };
  verb?: string;
  ticketPath?: string;
  can?: string[];
  onAccept?: () => void | Promise<void>;
  onReject?: () => void;
}) {
  const [done, setDone] = useState<"accepted" | "rejected" | null>(null);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
      <div className="min-w-0">
        <p className="text-sm"><span className="text-muted-foreground">{label}:</span> <span className="font-medium">{value}</span></p>
        {/* The evidence, always shown with the suggestion. A number somebody cannot interrogate is not a
            reason, and "2 of 3" is what makes a thin suggestion visibly thin. */}
        <p className="text-xs text-muted-foreground">{vote.votes} of {vote.of} nearest resolved tickets</p>
      </div>
      {verb && ticketPath && onAccept && !done && (
        <AccessAction collection="tickets" objectPath={ticketPath} verb={verb} can={can} label={`Apply suggested ${label.toLowerCase()}`}>
          <span className="flex gap-1.5">
            <Button size="sm" variant="outline" onClick={async () => { await onAccept(); setDone("accepted"); }}>
              <Check className="h-4 w-4" /> Apply
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { onReject?.(); setDone("rejected"); }}>
              <X className="h-4 w-4" /> Dismiss
            </Button>
          </span>
        </AccessAction>
      )}
      {done === "accepted" && <span className="flex items-center gap-1 text-sm text-success"><Copy className="h-3.5 w-3.5" /> Applied</span>}
      {done === "rejected" && <span className="text-sm text-muted-foreground">Dismissed</span>}
    </div>
  );
}
