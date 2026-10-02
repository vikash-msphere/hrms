import { remove, purge, restore as restoreApi } from "@/api";
import { idOf } from "@/lib/utils";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";

type Deletable = { path: string; etag?: string; delete_time?: string; access?: { can?: string[] } };

/** How one delete is put to the reader. Every field is optional: the hook's own wording fits most rows. */
export type SoftDeleteOptions = {
  /** What is being deleted, as the prompt names it: `"Q3 hiring plan"` (quoted by the caller) or `"this
   *  goal"`. Defaults to "this <label>". */
  subject?: string;
  /** A sentence of consequence for the prompt, in place of the default. */
  description?: string;
  /** Runs once the delete has gone through (and before the toast), for a caller with more to do than reload:
   *  close a drawer, leave a solo page. */
  onDeleted?: () => void;
};

/** Whether a deleted row can be brought back: its `can` lists `restore` only when its collection
 *  soft-deletes and the reader may restore (http/collectionRoute.ts). A row with no access hint keeps the
 *  benefit of the doubt, as the Undo always had. */
export const canRestore = (can?: string[]) => !can || can.includes("restore");

/**
 * The toast after a delete that has gone through, with an Undo where one can work - for the deletes that
 * call `remove()` themselves (their own wording, their own prompt) rather than going through `useSoftDelete`.
 * Every delete asks first AND offers the Undo; see `softDelete` below.
 */
export function useDeletedToast() {
  const { toast } = useToast();
  return ({ path, noun, can, reload, title }: {
    /** The path the delete was sent to, which is also what `:restore` takes. */
    path: string;
    /** The singular noun for the messages, lower case: "review cycle". */
    noun: string;
    can?: string[];
    reload: () => void;
    /** In place of "<Noun> deleted", for a delete with its own verb ("Referral withdrawn"). */
    title?: string;
  }) => {
    const cap = noun.charAt(0).toUpperCase() + noun.slice(1);
    toast({
      title: title ?? `${cap} deleted`,
      variant: "success",
      ...(canRestore(can) ? {
        description: "Moved to deleted items.",
        duration: 8000,
        action: {
          label: "Undo",
          onClick: () => {
            restoreApi(path)
              .then(() => {
                toast({ title: `${cap} restored`, variant: "success" });
                reload();
              })
              .catch((e) =>
                toast({ title: "Couldn't restore", description: (e as Error).message, variant: "destructive" })
              );
          },
        },
      } : {}),
    });
  };
}

/**
 * Centralizes the confirm + API + toast + reload flow for soft delete, restore,
 * and permanent (super_admin) delete. `collection` is the kebab segment, `label`
 * the singular noun used in messages (e.g. "department").
 */
export function useSoftDelete(collection: string, label: string, reload: () => void) {
  const confirm = useConfirm();
  const { toast } = useToast();
  const deleted = useDeletedToast();
  const cap = label.charAt(0).toUpperCase() + label.slice(1);

  // EVERY DELETE ASKS FIRST, AND STILL OFFERS AN UNDO. The prompt is for the press that was not meant; the
  // Undo is for the one that was meant and regretted a second later. Neither stands in for the other: an
  // Undo that times out after eight seconds is no help to somebody who did not notice what went, and a
  // prompt does nothing once the reader has said yes.
  //
  // The Undo is offered only where it can work: a row whose `can` lacks `restore` belongs to a collection
  // that does not soft-delete (or to a reader who may not restore), and an Undo button that answers 403 or
  // 404 is worse than none. A row that carries no access hint at all keeps the Undo, as it always had.
  //
  // Resolves true when the row was deleted, false when the reader backed out or the call failed - so a
  // caller that closes something on delete closes it only then.
  async function softDelete(row: Deletable, opts: SoftDeleteOptions = {}): Promise<boolean> {
    const restorable = canRestore(row.access?.can);
    const ok = await confirm({
      title: `Delete ${opts.subject ?? `this ${label}`}?`,
      description: opts.description ?? (restorable
        ? `It moves to deleted items. Undo on the message that follows brings it straight back.`
        : `This ${label} is removed outright and cannot be brought back.`),
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return false;
    try {
      await remove(`${collection}/${idOf(row.path)}`, row.etag);
      opts.onDeleted?.();
      reload();
      deleted({ path: `${collection}/${idOf(row.path)}`, noun: label, can: row.access?.can, reload });
      return true;
    } catch (e) {
      toast({ title: "Couldn't delete", description: (e as Error).message, variant: "destructive" });
      return false;
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
