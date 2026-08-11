import * as React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/common/PageHeader";
import { ActivityFeed } from "@/components/common/ActivityFeed";
import type { Me } from "@/types";

// Org-wide activity: the whole audit trail across every collection — writes, sensitive-data reads, and
// denied attempts — newest-first. Gated by the `audit` capability (super-only by default; admins widen via
// the ACL), so the nav entry only appears for holders. The feed is self-paged and self-filtered.
export default function Activity(_props: { me: Me }) {
  // "What changed in permissions recently" is the one question this feed is asked often enough to deserve a
  // door of its own: access-rule writes are already audited, they are just buried among every other change.
  // The view is the same feed with its object-type filter pre-set, so every other filter still applies.
  const [view, setView] = React.useState<"all" | "access">("all");
  return (
    <div>
      <PageHeader
        eyebrow="Admin"
        title="Activity"
        description="Everything that happened across the workspace — every change, sensitive-data view, and blocked attempt. Search by person, record or action, or filter by record type, person and action."
        accessCollection="audit"
      />
      <div className="mb-3 flex gap-0.5 rounded-md border p-0.5 w-fit">
        <Button size="sm" variant={view === "all" ? "default" : "ghost"} className="h-7" onClick={() => setView("all")}>Everything</Button>
        <Button size="sm" variant={view === "access" ? "default" : "ghost"} className="h-7" onClick={() => setView("access")}>Permission changes</Button>
      </div>
      <Card className="p-4">
        {/* Remounted per view so the feed re-runs its initial load with the new filter. */}
        {view === "access" ? <ActivityFeed key="access" global initialEntity="access-rules" /> : <ActivityFeed key="all" global />}
      </Card>
    </div>
  );
}
