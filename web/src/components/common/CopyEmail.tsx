import { Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/use-toast";

/** An email address with a copy icon that reveals on hover (and on keyboard focus, so it stays
 *  reachable on touch/keyboard). Drop in wherever an email is displayed. Pass children to keep a
 *  custom rendering of the address (e.g. a mailto link) and just append the copy affordance. */
export function CopyEmail({ email, className, children }: { email: string; className?: string; children?: React.ReactNode }) {
  const { toast } = useToast();
  return (
    // max-w-full so the shrink-to-fit inline box can never out-size its container: an address is long enough
    // to spill out of a narrow cell (a hover card's value column, a card footer) if it is allowed to.
    <span className={cn("group/email inline-flex min-w-0 max-w-full items-center gap-1", className)}>
      {children ?? <span className="truncate">{email}</span>}
      <button
        type="button"
        title="Copy email"
        aria-label="Copy email"
        className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/email:opacity-100"
        onClick={(ev) => {
          ev.stopPropagation();
          navigator.clipboard
            .writeText(email)
            .then(() => toast({ title: "Email copied", variant: "success" }))
            .catch(() => {});
        }}
      >
        <Copy className="h-3 w-3" />
      </button>
    </span>
  );
}
