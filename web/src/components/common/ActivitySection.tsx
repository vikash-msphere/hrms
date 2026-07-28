import { useState } from "react";
import { History, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCanSeeActivity } from "@/lib/perm";
import { ActivityFeed } from "./ActivityFeed";

// A collapsed "Activity" disclosure for a record's detail/edit dialog. Starts CLOSED and mounts the feed
// only after the user clicks the header — the audit query never runs until then (Cloudflare D1 free-tier
// reads are scarce, so nothing loads on dialog open). Pass the record's wire path, e.g. `loans/{id}`.
export function ActivitySection({ resource, className = "" }: { resource: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const collection = resource.replace(/^\/v1\//, "").replace(/^\/+/, "").split("/")[0];
  if (!useCanSeeActivity(collection)) return null; // no activity grant for this collection → hide the disclosure
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
        Activity
      </button>
      {open && <ActivityFeed resource={resource} />}
    </div>
  );
}
