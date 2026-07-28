import { Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { Column } from "./DataTable";

type StateRow = { delete_time?: string; disabled?: boolean; locked?: boolean; published?: boolean };

// Single representative state for sorting/filtering (precedence: trash first).
export function primaryState(r: StateRow): string {
  if (r.delete_time) return "Deleted";
  if (r.disabled) return "Disabled";
  if (r.locked) return "Locked";
  if (r.published === false) return "Draft";
  return "Active";
}

/** Renders every applicable state badge (Active when none apply). */
export function StateBadges({ row, publishable }: { row: StateRow; publishable?: boolean }) {
  if (row.delete_time) return <Badge variant="muted">Deleted</Badge>;
  const badges: React.ReactNode[] = [];
  if (row.disabled) badges.push(<Badge key="d" variant="warning">Disabled</Badge>);
  if (row.locked) badges.push(<Badge key="l" variant="muted"><Lock className="h-3 w-3" /> Locked</Badge>);
  if (publishable && row.published === false) badges.push(<Badge key="p" variant="secondary">Draft</Badge>);
  if (badges.length === 0) return <Badge variant="success">Active</Badge>;
  return <div className="flex flex-wrap gap-1">{badges}</div>;
}

/** The unified "State" column: shows Active/Disabled/Locked/Draft/Deleted, filterable.
 *  Deleted rows are hidden by default (filter for "Deleted" to see the trash). */
export function stateColumn<T extends StateRow>(opts?: { publishable?: boolean }): Column<T> {
  return {
    id: "state",
    header: "State",
    filter: "select",
    hideValueByDefault: "Deleted",
    accessor: (r) => primaryState(r),
    cell: (r) => <StateBadges row={r} publishable={opts?.publishable} />,
  };
}
