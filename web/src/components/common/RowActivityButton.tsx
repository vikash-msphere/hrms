import { useState } from "react";
import { History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCanSeeActivity } from "@/lib/perm";
import { ActivityFeed } from "./ActivityFeed";

// A per-row "activity" affordance for list/card layouts that have no detail dialog to embed a feed in: a
// ghost History icon that opens a dialog with that record's audit trail. The feed reads lazily on open (the
// dialog mounts ActivityFeed only while open), so it costs nothing until clicked. Pass the record wire path.
export function RowActivityButton({ resource, label = "Activity", size = "icon" }: { resource: string; label?: string; size?: "icon" | "sm" }) {
  const [open, setOpen] = useState(false);
  // The record's collection is the first path segment (`leave-requests/<token>` or `/v1/leave-requests/...`).
  const collection = resource.replace(/^\/v1\//, "").replace(/^\/+/, "").split("/")[0];
  if (!useCanSeeActivity(collection)) return null; // no activity grant for this collection → no affordance
  return (
    <>
      {size === "icon" ? (
        <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" aria-label={label} title={label} onClick={(e) => { e.stopPropagation(); setOpen(true); }}>
          <History className="h-3.5 w-3.5" />
        </Button>
      ) : (
        <Button variant="ghost" size="sm" className="h-7 text-muted-foreground" onClick={(e) => { e.stopPropagation(); setOpen(true); }}>
          <History className="h-3.5 w-3.5" /> {label}
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Activity</DialogTitle></DialogHeader>
          {open && <ActivityFeed resource={resource} />}
        </DialogContent>
      </Dialog>
    </>
  );
}
