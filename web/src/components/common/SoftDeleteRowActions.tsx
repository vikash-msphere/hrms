import { Pencil, Trash2, RotateCcw, ShieldX, Lock, Unlock, Ban, CheckCircle2, Send, FileEdit } from "lucide-react";
import { RowActions, type RowAction } from "@/components/common/RowActions";
import type { Lifecycle } from "@/hooks/useLifecycle";

type Item = { path: string; etag?: string; delete_time?: string; disabled?: boolean; locked?: boolean; published?: boolean; access?: { can?: string[] } };

type SoftActions = {
  softDelete: (row: Item) => void;
  restore: (row: Item) => void;
  permanentlyDelete: (row: Item) => void;
};

/** Row actions + state badges. Active rows: edit/disable/lock/(publish)/delete.
 *  Locked rows: only Unlock (edits/deletes are blocked server-side). Deleted rows:
 *  Restore + (super_admin) Delete permanently. */
export function SoftDeleteRowActions<T extends Item>({
  row,
  writable,
  canPurge,
  actions,
  onEdit,
  lifecycle,
  publishable,
  extra,
}: {
  row: T;
  writable: boolean;
  canPurge: boolean;
  actions: SoftActions;
  onEdit?: (row: T) => void;
  lifecycle?: Lifecycle;
  publishable?: boolean;
  /** Page-specific actions for an ACTIVE row, offered right after Edit (e.g. "Duplicate to next period").
   *  Deleted and locked rows keep their restricted menus - the caller's actions never appear there. */
  extra?: RowAction[];
}) {
  const deleted = !!row.delete_time;
  const locked = !!row.locked;

  const items: RowAction[] = [];
  if (deleted) {
    if (writable) items.push({ label: "Restore", icon: <RotateCcw className="h-4 w-4" />, onClick: () => actions.restore(row), verb: "restore" });
    if (canPurge) items.push({ label: "Delete permanently", icon: <ShieldX className="h-4 w-4" />, onClick: () => actions.permanentlyDelete(row), destructive: true, verb: "delete" });
  } else if (locked) {
    // While locked, the only thing you can do is try to unlock (server checks authority).
    if (writable && lifecycle) items.push({ label: "Unlock", icon: <Unlock className="h-4 w-4" />, onClick: () => lifecycle.unlock(row), verb: "unlock" });
  } else {
    if (writable && onEdit) items.push({ label: "Edit", icon: <Pencil className="h-4 w-4" />, onClick: () => onEdit(row), verb: "update" });
    if (extra) items.push(...extra);
    if (writable && lifecycle && publishable)
      items.push(
        row.published === false
          ? { label: "Publish", icon: <Send className="h-4 w-4" />, onClick: () => lifecycle.publish(row), verb: "publish" }
          : { label: "Unpublish", icon: <FileEdit className="h-4 w-4" />, onClick: () => lifecycle.unpublish(row), verb: "unpublish" }
      );
    if (writable && lifecycle)
      items.push(
        row.disabled
          ? { label: "Enable", icon: <CheckCircle2 className="h-4 w-4" />, onClick: () => lifecycle.enable(row), verb: "enable" }
          : { label: "Disable", icon: <Ban className="h-4 w-4" />, onClick: () => lifecycle.disable(row), verb: "disable" }
      );
    if (writable && lifecycle) items.push({ label: "Lock", icon: <Lock className="h-4 w-4" />, onClick: () => lifecycle.lock(row), verb: "lock" });
    if (writable) items.push({ label: "Delete", icon: <Trash2 className="h-4 w-4" />, onClick: () => actions.softDelete(row), destructive: true, verb: "delete" });
  }

  return <RowActions actions={items} objectPath={row.path} can={row.access?.can} />;
}
