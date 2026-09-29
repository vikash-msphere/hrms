// Who may see and work a board, as pure data (no I/O).
//
// A board's access is decided by CODE, like every record in the app, and three facts about the codes carry it:
//
//   - A board's code starts with its VISIBILITY segment: `ve-0a` is seen and worked by everyone, `vr-0a` is
//     seen by everyone and worked by those it is shared with, `vp-0a` is seen only by those it is shared with.
//     The seeded employee rules name the first two by subtree (`boards.ve-*.**`, `cards.vr-*.**`), so an
//     org-visible board needs no rule of its own, and a private one is reached by nothing broad.
//   - A board's cards and sprints are coded UNDER the board (`ve-0a-001`), so one subtree rule on the board's
//     code (`cards.ve-0a-*.**`) reaches every task on it, now and later.
//   - A per-board share is therefore a handful of subtree rules on the board's code, and a subtree rule is a
//     BROAD rule (match_code NULL): it sits in the holder's cached grant, so a list, a list's access hints and
//     the create gate all see it without a per-object read.
//
// Changing a board's visibility moves it to another segment, which re-codes the board, its cards and its
// sprints and the rules that name them (services/boardShares.ts recodeBoard). The uuid - and so the wire id -
// never changes.
//
// No role may hold `me` / `my-dept` / `my-reports` / `my-org` on boards, cards or sprints: those tokens match
// by code, and a board-coded row is not an employee's or a department's code. test/roleFiles.test.ts holds it.

/** The collections a board's rules and codes live in. */
export const BOARD_NAMESPACES = ["boards", "cards", "sprints"] as const;

export type BoardVisibility = "edit" | "view" | "private";
export const BOARD_VISIBILITIES: readonly BoardVisibility[] = ["edit", "view", "private"];

/** The first code segment each visibility is filed under. Two base32 characters, like every segment. */
export const VISIBILITY_SEG: Record<BoardVisibility, string> = { edit: "ve", view: "vr", private: "vp" };

/** A board's visibility, read off its code. Null for a code in none of the three segments. */
export function visibilityOfCode(code: string | null | undefined): BoardVisibility | null {
  const seg = code?.split("-")[0];
  for (const v of BOARD_VISIBILITIES) if (VISIBILITY_SEG[v] === seg) return v;
  return null;
}

/** What one person or role may do on one board. */
export type BoardLevel = "view" | "edit" | "manage";
export const BOARD_LEVELS: readonly BoardLevel[] = ["view", "edit", "manage"];
export const BOARD_LEVEL_RANK: Record<BoardLevel, number> = { view: 1, edit: 2, manage: 3 };

/** Card verbs that read and follow, without changing the work. */
export const CARD_VIEW_VERBS = ["flow", "triage", "watch", "unwatch"] as const;

/**
 * Card verbs that work a task. NAMED, not a wildcard: a card verb added later is withheld until someone decides
 * who works it, the same reason the employee role names its card verbs.
 */
export const CARD_WORK_VERBS = [
  ...CARD_VIEW_VERBS,
  "move", "block", "unblock", "assign", "prioritize", "comment",
  "addTodos", "toggleTodo", "removeTodo", "promoteTodo", "suggestSteps", "suggestGoal",
] as const;

export type BoardRule = { pattern: string; level: "read" | "write" | null };

/**
 * The rules one level amounts to on the board coded `boardCode` (or, with a visibility segment as the code, on
 * every board in it). `level: null` is a verb rule. Pure, so the seed, the share service and the tests build the
 * same rows.
 *
 * - view: read the board, its tasks and its sprints, and the read-only verbs on them.
 * - edit: view, plus writing tasks and every card work verb.
 * - manage: edit, plus the board itself (rename, shape, archive, sharing) and its sprints - every board, card
 *   and sprint verb, since whoever manages a board is trusted with what is added to it later.
 */
export function boardLevelRules(boardCode: string, level: BoardLevel): BoardRule[] {
  const at = `${boardCode}-*`;
  const rules: BoardRule[] = [];
  if (level === "manage") {
    rules.push(
      { pattern: `boards.${at}.**`, level: "write" },
      { pattern: `boards.${at}.**`, level: null },
      { pattern: `cards.${at}.**`, level: "write" },
      { pattern: `cards.${at}.**`, level: null },
      { pattern: `sprints.${at}.**`, level: "write" },
      { pattern: `sprints.${at}.**`, level: null },
    );
    return rules;
  }
  rules.push(
    { pattern: `boards.${at}.**`, level: "read" },
    { pattern: `boards.${at}.metrics`, level: null },
    { pattern: `sprints.${at}.**`, level: "read" },
    { pattern: `cards.${at}.**`, level: level === "edit" ? "write" : "read" },
  );
  for (const v of level === "edit" ? CARD_WORK_VERBS : CARD_VIEW_VERBS) rules.push({ pattern: `cards.${at}.${v}`, level: null });
  return rules;
}

/** One entry of a board's sharing list: a user account or a role, at a level. */
export type BoardMember = { kind: "user" | "role"; subject: string; level: BoardLevel };
