import { useState } from "react";
import { History, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCanSeeActivity } from "@/lib/perm";
import { ActivityFeed } from "./ActivityFeed";

// A collapsed "Activity" disclosure. Starts CLOSED and mounts the feed only after the user clicks the header
// — the audit query never runs until then (Cloudflare D1 free-tier reads are scarce, so nothing loads on
// open).
//
// Two shapes, one disclosure:
//   `resource` — ONE record's trail, for a detail/edit dialog. Pass the wire path, e.g. `loans/{id}`.
//   `entity`   — a whole COLLECTION's trail, for the page or panel that administers it. "Who minted a key
//                last month" is a question about the collection, not about any one row, and it has nowhere
//                else to be asked: the row it concerns may well have been deleted since.
//   `apiKey`   — everything ONE credential DID, as opposed to what was done to it. A key acts as its owner,
//                so its rows name that human; this is the only way to tell "Priya" from "Priya's CI key".
export function ActivitySection({
  resource,
  entity,
  apiKey,
  label = "Activity",
  className = "",
}: {
  resource?: string;
  entity?: string;
  apiKey?: string;
  /** Overrides the header when "Activity" alone is ambiguous on a page with several of these. */
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  // A key's own trail spans every collection, so it is gated like the org-wide feed rather than per-collection.
  const collection = entity ?? (apiKey ? undefined : resource?.replace(/^\/v1\//, "").replace(/^\/+/, "").split("/")[0]);
  if (!useCanSeeActivity(collection)) return null; // no activity grant → hide the disclosure
  if (!resource && !entity && !apiKey) return null;
  return (
    <div className={cn("space-y-2", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight className={cn("h-4 w-4 transition-transform", open && "rotate-90")} />
        <History className="h-4 w-4" />
        {label}
      </button>
      {open && (apiKey ? <ActivityFeed global apiKey={apiKey} /> : entity ? <ActivityFeed global initialEntity={entity} /> : <ActivityFeed resource={resource} />)}
    </div>
  );
}
