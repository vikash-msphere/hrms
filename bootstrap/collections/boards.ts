// A starter kanban board so a fresh org has somewhere to drop work on day one. Swimlanes group tasks by
// WORK TYPE (Feature / Bug / Chore / Tech debt) — the lanes are the useful default the team asked for.
// Columns are the shared kanban defaults. Private-by-default (no seeded grant; super sees it via **, admins
// widen via the ACL like any board). No cards seeded (those are employee-owned, created in-app).
import { type Ctx, T0, q, j, code2, rows } from "../lib";
import { DEFAULT_BOARD_COLUMNS } from "../../src/domain/boards";

// Work-type swimlanes. Keys are lowercase slugs (KEY_RE: [a-z0-9][a-z0-9_]*), so "tech_debt" not "tech-debt".
const SWIMLANES = [
  { key: "feature", label: "Feature" },
  { key: "bug", label: "Bug" },
  { key: "chore", label: "Chore" },
  { key: "tech_debt", label: "Tech debt" },
];

export function boards(ctx: Ctx): string {
  return rows(
    "INSERT INTO boards (uuid,code,name,description,task_prefix,mode,columns_json,swimlane_mode,swimlanes_json,labels_json,created_at,updated_at) VALUES",
    [
      ` (${q(ctx.nid())},${q(code2(1))},${q("General")},${q("Team work board — group tasks by type using the swimlanes.")},${q("GEN")},${q("kanban")},${j(DEFAULT_BOARD_COLUMNS)},${q("custom")},${j(SWIMLANES)},${q("[]")},${T0},${T0})`,
    ],
  );
}
