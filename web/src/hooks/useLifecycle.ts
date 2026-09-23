import { invoke } from "@/api";
import { idOf } from "@/lib/utils";
import { useToast } from "@/components/ui/use-toast";

type Item = { path: string; etag?: string };

/** Lifecycle actions (enable/disable, lock/unlock, publish/unpublish) for a resource.
 *  Each runs the custom method, toasts, and reloads. The server enforces lock authority. */
export function useLifecycle(collection: string, label: string, reload: () => void) {
  const { toast } = useToast();
  const cap = label.charAt(0).toUpperCase() + label.slice(1);

  function act(verb: string, past: string) {
    return async (row: Item) => {
      try {
        await invoke(`${collection}/${idOf(row.path)}`, verb, row.etag);
        toast({ title: `${cap} ${past}`, variant: "success" });
        reload();
      } catch (e) {
        toast({ title: "Action failed", description: (e as Error).message, variant: "destructive" });
      }
    };
  }

  return {
    enable: act("enable", "enabled"),
    disable: act("disable", "disabled"),
    lock: act("lock", "locked"),
    unlock: act("unlock", "unlocked"),
    publish: act("publish", "published"),
    unpublish: act("unpublish", "unpublished"),
  };
}

export type Lifecycle = ReturnType<typeof useLifecycle>;
