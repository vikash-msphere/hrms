// What a ⌘K result can be DONE to, from the palette, without opening its page: the approve / reject decisions
// on the requests that wait for one. Pure, so the palette and its tests agree on what is offered.
//
// HIDE, NEVER DISABLE. A verb is offered only when all three hold:
//   - the server says this caller may perform it on THIS record (`access.can`, http/accessHint.ts - computed
//     per object by the same engine that will decide the request),
//   - the record is in the state the verb acts on (a request already approved has nothing to approve),
//   - it is not the caller's own request, unless the org allows self-approval - the same rule the approvals
//     queue applies (lib/approvals.tsx), because the server refuses anybody deciding their own request in their
//     favour and `access.can` does not know that.
// Every decision still asks first (lib/confirmDecision.ts) - the palette only saves the trip to the page.

export type PaletteVerb = "approve" | "reject";
export type PaletteVerbOption = { verb: PaletteVerb; label: string };

type Def = { awaiting: string; field: "state" | "status" };

// Collections whose records wait on an approve/reject decision, and the value their state holds while they do.
// Company expenses call it SUBMITTED; the personal requests call it PENDING.
export const PALETTE_ACTIONS: Readonly<Record<string, Def>> = {
  "leave-requests": { awaiting: "PENDING", field: "state" },
  "overtime-requests": { awaiting: "PENDING", field: "state" },
  "remote-work-requests": { awaiting: "PENDING", field: "state" },
  "late-early-requests": { awaiting: "PENDING", field: "state" },
  reimbursements: { awaiting: "PENDING", field: "state" },
  expenses: { awaiting: "SUBMITTED", field: "state" },
};

const VERBS: PaletteVerbOption[] = [
  { verb: "approve", label: "Approve" },
  { verb: "reject", label: "Reject" },
];

export type ActionableRow = { state?: string | null; status?: string | null; employee?: string | null; access?: { can?: string[] } };

const lastSegment = (ref: string) => ref.split("/").pop() ?? ref;

/** The decisions this caller can make on this record right now, in display order. */
export function paletteVerbs(
  collection: string,
  row: ActionableRow,
  opts: { selfEmployeeId?: string | null; allowSelfApproval: boolean },
): PaletteVerbOption[] {
  const def = PALETTE_ACTIONS[collection];
  if (!def) return [];
  if ((row[def.field] ?? "").toUpperCase() !== def.awaiting) return [];
  const own = !!opts.selfEmployeeId && !!row.employee && lastSegment(row.employee) === lastSegment(opts.selfEmployeeId);
  if (own && !opts.allowSelfApproval) return [];
  const can = new Set(row.access?.can ?? []);
  return VERBS.filter((v) => can.has(v.verb));
}

/** Whether a result of this collection can have actions at all - so the palette only offers Tab where it helps. */
export const hasPaletteActions = (collection: string) => collection in PALETTE_ACTIONS;
