// Board visibility and sharing, as the pages present it. The rules themselves are the server's
// (src/domain/boardAccess.ts, services/boardShares.ts); this is wording and one tree walk.
import { idOf } from "@/lib/utils";
import type { Board, Department } from "@/types";

export type BoardVisibility = NonNullable<Board["visibility"]>;
export type BoardLevel = "view" | "edit" | "manage";

export const VISIBILITY_OPTIONS: { value: BoardVisibility; label: string; hint: string }[] = [
  { value: "edit", label: "Everyone can work on it", hint: "Everyone sees the board and can add and move its tasks." },
  { value: "view", label: "Everyone can see it", hint: "Everyone sees the board and its tasks. Only the people it's shared with can work on them." },
  { value: "private", label: "Only people it's shared with", hint: "Hidden from everyone else, HR included. Its department's managers still manage it." },
];

export const LEVEL_OPTIONS: { value: BoardLevel; label: string }[] = [
  { value: "view", label: "Can view" },
  { value: "edit", label: "Can work on tasks" },
  { value: "manage", label: "Can manage" },
];

/**
 * The departments `employeeId` manages, and every department below them: the ones a manager may file a board
 * under (a department's managers manage its sub-departments' boards too). Empty for someone who manages none.
 */
export function managedDepartments(departments: Department[], employeeId: string | null | undefined): Department[] {
  if (!employeeId) return [];
  const live = departments.filter((d) => !d.delete_time);
  const byId = new Map(live.map((d) => [idOf(d.path), d]));
  const heads = new Set(live.filter((d) => (d.managers ?? []).some((m) => idOf(m) === employeeId)).map((d) => idOf(d.path)));
  const under = (d: Department): boolean => {
    for (let at: Department | undefined = d, i = 0; at && i < 64; i++) {
      if (heads.has(idOf(at.path))) return true;
      at = at.parent ? byId.get(idOf(at.parent)) : undefined;
    }
    return false;
  };
  return live.filter(under);
}
