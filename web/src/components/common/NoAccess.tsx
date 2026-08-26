import { Lock } from "lucide-react";
import { api } from "@/api";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";

// The wall a route puts up when the caller has no access to it. Reaching one means the URL was typed, kept as
// a bookmark, or shared by somebody who does hold the access - the nav never offers a page it hides, and no
// page component renders behind this. It offers the same way out as the 403 toast (access-rules:requestAccess,
// itself permission-gated, so it apologises quietly where the org has not enabled the flow).
export function NoAccess({ collection, what }: { collection?: string; what?: string }) {
  const { toast } = useToast();
  const label = what ?? collection?.replace(/-/g, " ") ?? "this page";
  function request() {
    if (!collection) return;
    api("/access-rules:requestAccess", { method: "POST", body: JSON.stringify({ collection }), skipForbiddenHandler: true })
      .then(() => toast({ title: "Request sent", description: "The access admins have been notified.", variant: "success" }))
      .catch(() => toast({ title: "Couldn't send the request", description: "Access requests aren't enabled here yet - ask an admin directly.", variant: "destructive" }));
  }
  return (
    <EmptyState
      icon={Lock}
      title="You don't have access to this"
      description={`Nothing here is yours to see yet. Ask an access admin for ${label}, and it will appear in your sidebar once granted.`}
      action={collection ? <Button variant="outline" onClick={request}>Request access</Button> : undefined}
    />
  );
}
