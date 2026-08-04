import { remove, purge, restore as restoreApi } from "@/api";
import { idOf } from "@/lib/utils";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";

type Deletable = { path: string; etag?: string; delete_time?: string };

/**
 * Centralizes the confirm + API + toast + reload flow for soft delete, restore,
 * and permanent (super_admin) delete. `collection` is the kebab segment, `label`
 * the singular noun used in messages (e.g. "department").
 */
export function useSoftDelete(collection: string, label: string, reload: () => void) {
  const confirm = useConfirm();
  const { toast } = useToast();
  const cap = label.charAt(0).toUpperCase() + label.slice(1);

  // Soft delete is reversible by design, so it skips the confirm dialog: the row disappears immediately and
  // the toast carries an Undo (restore) for the change-of-heart window. Hard delete below still confirms.
  async function softDelete(row: Deletable) {
    try {
      await remove(`${collection}/${idOf(row.path)}`, row.etag);
      reload();
      toast({
        title: `${cap} deleted`,
        description: "Moved to deleted items.",
        variant: "success",
        duration: 8000,
        action: {
          label: "Undo",
          onClick: () => {
            restoreApi(`${collection}/${idOf(row.path)}`)
              .then(() => {
                toast({ title: `${cap} restored`, variant: "success" });
                reload();
              })
              .catch((e) =>
                toast({ title: "Couldn't restore", description: (e as Error).message, variant: "destructive" })
              );
          },
        },
      });
    } catch (e) {
      toast({ title: "Couldn't delete", description: (e as Error).message, variant: "destructive" });
    }
  }

  async function restore(row: Deletable) {
    try {
      await restoreApi(`${collection}/${idOf(row.path)}`);
      toast({ title: `${cap} restored`, variant: "success" });
      reload();
    } catch (e) {
      toast({ title: "Couldn't restore", description: (e as Error).message, variant: "destructive" });
    }
  }

  async function permanentlyDelete(row: Deletable) {
    const ok = await confirm({
      title: `Permanently delete this ${label}?`,
      description: "This cannot be undone. The record will be erased for good.",
      confirmLabel: "Delete permanently",
      destructive: true,
    });
    if (!ok) return;
    try {
      await purge(`${collection}/${idOf(row.path)}`, row.etag);
      toast({ title: `${cap} permanently deleted`, variant: "success" });
      reload();
    } catch (e) {
      toast({ title: "Couldn't delete", description: (e as Error).message, variant: "destructive" });
    }
  }

  return { softDelete, restore, permanentlyDelete };
}
