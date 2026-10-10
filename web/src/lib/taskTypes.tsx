// Board task types: what KIND of work a task is (bug, feature, chore), drawn as a small coloured glyph beside the
// task key. A board's catalog (`board.task_types`) stores each type's `icon` as one of the names below; the set is
// short on purpose - a type glyph has to read at 14px on a dense board, so it is a vocabulary, not a picker over
// every icon the app has. An unknown or missing name draws a plain dot in the type's colour.
import {
  Sparkles, Bug, TrendingUp, Wrench, Hammer, SquareCheck, BookOpen, Zap, FlaskConical, FileText, TestTube, Palette, LifeBuoy,
  type LucideIcon,
} from "lucide-react";
import type { TaskType } from "@/types";
import { cn } from "@/lib/utils";

export const TASK_TYPE_ICONS: { name: string; label: string; Icon: LucideIcon }[] = [
  { name: "feature", label: "Feature", Icon: Sparkles },
  { name: "bug", label: "Bug", Icon: Bug },
  { name: "improvement", label: "Improvement", Icon: TrendingUp },
  { name: "chore", label: "Chore", Icon: Wrench },
  { name: "debt", label: "Tech debt", Icon: Hammer },
  { name: "task", label: "Task", Icon: SquareCheck },
  { name: "story", label: "Story", Icon: BookOpen },
  { name: "epic", label: "Epic", Icon: Zap },
  { name: "spike", label: "Spike", Icon: FlaskConical },
  { name: "docs", label: "Docs", Icon: FileText },
  { name: "test", label: "Test", Icon: TestTube },
  { name: "design", label: "Design", Icon: Palette },
  { name: "support", label: "Support", Icon: LifeBuoy },
];
const BY_NAME = new Map(TASK_TYPE_ICONS.map((i) => [i.name, i.Icon]));

export const DEFAULT_TYPE_COLOR = "#64748b";

/** The type a card carries, resolved against its board's catalog; a key the board no longer offers is no type. */
export function taskTypeOf(types: TaskType[] | undefined, key?: string | null): TaskType | undefined {
  return key ? types?.find((t) => t.key === key) : undefined;
}

export function TaskTypeIcon({ type, className }: { type: Pick<TaskType, "label" | "color" | "icon">; className?: string }) {
  const Icon = type.icon ? BY_NAME.get(type.icon) : undefined;
  const color = type.color ?? DEFAULT_TYPE_COLOR;
  if (!Icon) return <span role="img" aria-label={type.label} className={cn("inline-block h-2 w-2 shrink-0 rounded-full", className)} style={{ background: color }} />;
  return <Icon role="img" aria-label={type.label} className={cn("h-3.5 w-3.5 shrink-0", className)} style={{ color }} />;
}
