// A starter kanban board so a fresh org has somewhere to drop work on day one. Swimlanes group tasks by
// WORK TYPE (Feature / Bug / Chore / Tech debt) — the lanes are the useful default the team asked for. The work
// types are the board's task-type catalog and the lanes follow it (`swimlane_mode = task_type`), so a task's type
// and its lane are one field. Columns are the shared kanban defaults. Coded in the everyone-works-it segment
// (`ve-`, domain/boardAccess.ts), so every employee sees it and works its tasks, as every board did before
// visibility existed. No department and no sharing list: super admin and the project manager manage it until
// someone files it under a department. No cards seeded (created in-app).
import { type Ctx, T0, q, j, code2, rows } from "../lib";
import { DEFAULT_BOARD_COLUMNS } from "../../src/domain/boards";
import { VISIBILITY_SEG } from "../../src/domain/boardAccess";

// Work types. Keys are lowercase slugs (KEY_RE: [a-z0-9][a-z0-9_]*), so "tech_debt" not "tech-debt".
const TASK_TYPES = [
  { key: "feature", label: "Feature", color: "#16a34a", icon: "feature" },
  { key: "bug", label: "Bug", color: "#dc2626", icon: "bug" },
  { key: "chore", label: "Chore", color: "#64748b", icon: "chore" },
  { key: "tech_debt", label: "Tech debt", color: "#d97706", icon: "debt" },
];

export function boards(ctx: Ctx): string {
  return rows(
    "INSERT INTO boards (uuid,code,name,description,task_prefix,mode,columns_json,swimlane_mode,swimlanes_json,labels_json,task_types_json,created_at,updated_at) VALUES",
    [
      ` (${q(ctx.nid())},${q(`${VISIBILITY_SEG.edit}-${code2(1)}`)},${q("General")},${q("Team work board — tasks are grouped by type.")},${q("GEN")},${q("kanban")},${j(DEFAULT_BOARD_COLUMNS)},${q("task_type")},${q("[]")},${q("[]")},${j(TASK_TYPES)},${T0},${T0})`,
    ],
  );
}
