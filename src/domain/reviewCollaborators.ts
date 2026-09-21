// Who actually worked with this person during the cycle, and the evidence for saying so.
//
// A 360 is only worth running if the people asked saw the work. Nomination was a blank picker over the whole
// directory, so it got answered from memory - which favours whoever was loudest in the last month and misses
// the person on the other side of the project entirely. The app already records who worked with whom: two
// names on the same card, a share credited on somebody's goal, a kudos written.
//
// NO MODEL. This is joins and a count, and it has to be: a model ranking colleagues by how well they know
// somebody is an opinion about people, which is the line ai-rollout-plan.md decision 3 draws.
//
// IT RANKS EVIDENCE, NOT PEOPLE. The score orders a picker by how much shared work there is; it is never
// shown as a number, never stored, and says nothing about anybody's performance. Every entry carries the
// reasons that produced it, so the manager picking from the list is reading facts rather than a ranking.

export const COLLABORATOR_COLLECTIONS = ["goals", "cards", "announcements"] as const;

/** Why somebody is on the list. One line per signal, already worded for display. */
export type CollaboratorReason = { kind: CollaboratorKind; detail: string; count: number };

export type CollaboratorKind =
  /** Both names on the same card - owner, assignee or reporter. */
  | "same_task"
  /** A credited share on one of the other's goals, in either direction. */
  | "shared_goal"
  /** Kudos written in either direction. */
  | "kudos"
  /** Cards of their own on a board the subject was working on. */
  | "same_board";

export type Collaborator = {
  employee: string;
  name: string;
  /** How much shared work there is, for ORDER only. Not rendered, not stored, not about the person. */
  score: number;
  reasons: CollaboratorReason[];
};

/** What one signal is worth. Working the same card beats sharing a board, because a board can hold two teams
 *  who never spoke; a card is one piece of work with both their names on it. */
export const WEIGHT: Readonly<Record<CollaboratorKind, number>> = {
  same_task: 3,
  shared_goal: 3,
  kudos: 2,
  same_board: 1,
};

/** The most names a picker is worth. Past this it is a directory again. */
export const COLLABORATOR_CAP = 12;

/**
 * Fold the per-person signals into a ranked list.
 *
 * Pure, so the ordering is testable without a database, and so the only thing the service decides is which
 * rows the caller may read.
 */
export function rankCollaborators(
  signals: Map<string, CollaboratorReason[]>,
  names: Map<string, string>,
  cap: number = COLLABORATOR_CAP,
): Collaborator[] {
  const out: Collaborator[] = [];
  for (const [employeeId, reasons] of signals) {
    if (reasons.length === 0) continue;
    const score = reasons.reduce((sum, r) => sum + WEIGHT[r.kind] * r.count, 0);
    out.push({
      employee: `employees/${employeeId}`,
      name: names.get(employeeId) ?? "",
      score,
      // Strongest signal first, so the line a person reads first is the most specific one.
      reasons: [...reasons].sort((a, b) => WEIGHT[b.kind] * b.count - WEIGHT[a.kind] * a.count),
    });
  }
  // Ties fall back to the name, so two runs of the same cycle produce the same list rather than a picker
  // that reshuffles itself between visits.
  out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return out.slice(0, cap);
}
