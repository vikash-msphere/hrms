import { Badge } from "@/components/ui/badge";
import { humanize } from "@/lib/utils";

type Variant = "default" | "secondary" | "success" | "warning" | "destructive" | "muted";

const MAP: Record<string, Variant> = {
  // leave + payroll states
  APPROVED: "success",
  PUBLISHED: "success",
  PENDING: "warning",
  REVIEW: "warning",
  REJECTED: "destructive",
  CANCELLED: "muted",
  CANCELED: "muted",
  DRAFT: "secondary",
  // record lifecycle (soft delete)
  ACTIVE: "success",
  DELETED: "muted",
  // job / cron-run states
  DONE: "success",
  RUNNING: "warning",
  QUEUED: "secondary",
  ERROR: "destructive",
  // support ticket states
  OPEN: "warning",
  IN_PROGRESS: "default",
  RESOLVED: "success",
  CLOSED: "muted",
};

export function StatusBadge({ state }: { state: string }) {
  const variant = MAP[state?.toUpperCase()] ?? "secondary";
  return <Badge variant={variant}>{humanize(state)}</Badge>;
}
