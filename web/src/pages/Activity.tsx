import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/common/PageHeader";
import { ActivityFeed } from "@/components/common/ActivityFeed";
import type { Me } from "@/types";

// Org-wide activity: the whole audit trail across every collection — writes, sensitive-data reads, and
// denied attempts — newest-first. Gated by the `audit` capability (super-only by default; admins widen via
// the ACL), so the nav entry only appears for holders. The feed is self-paged and self-filtered.
export default function Activity(_props: { me: Me }) {
  return (
    <div>
      <PageHeader
        eyebrow="Admin"
        title="Activity"
        description="Everything that happened across the workspace — every change, sensitive-data view, and blocked attempt. Search, or filter by record type and action."
        accessCollection="audit"
      />
      <Card className="p-4">
        <ActivityFeed global />
      </Card>
    </div>
  );
}
