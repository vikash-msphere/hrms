import * as React from "react";
import { Lock } from "lucide-react";
import { api } from "@/api";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";

// The wall a route puts up when the caller has no access to it. Reaching one means the URL was typed, kept as
// a bookmark, or shared by somebody who does hold the access - the nav never offers a page it hides, and no
// page component renders behind this. It offers the same way out as the 403 toast (access-rules:requestAccess,
// itself permission-gated, so it apologises quietly where the org has not enabled the flow).
//
// The ask carries WHY and FOR HOW LONG. Both are what turns a request into something an admin can act on
// without a side conversation: "I'm covering payroll while Sam is out, until Friday" is a decision they can
// make, where a bare "someone wants expenses" is a question they have to go and ask. The duration grants
// nothing by itself - it travels to the admin so they set a matching expiry, which is the existing temporary
// -access mechanism rather than a new one.
// A Select item can never carry an empty value (Radix reserves "" for "cleared"), so "permanently" travels
// under a sentinel and maps back to "no hours on the request" when it is sent.
const PERMANENT = "permanent";
const DURATIONS: [string, string][] = [
  [PERMANENT, "Permanently"],
  ["4", "For 4 hours"],
  ["24", "For a day"],
  ["72", "For 3 days"],
  ["168", "For a week"],
];

export function NoAccess({ collection, what }: { collection?: string; what?: string }) {
  const { toast } = useToast();
  const [asking, setAsking] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [hours, setHours] = React.useState(PERMANENT);
  const [busy, setBusy] = React.useState(false);
  const label = what ?? collection?.replace(/-/g, " ") ?? "this page";

  function request() {
    if (!collection) return;
    setBusy(true);
    const body: Record<string, unknown> = { collection };
    if (note.trim()) body.note = note.trim();
    if (hours !== PERMANENT) body.hours = Number(hours);
    api("/access-rules:requestAccess", { method: "POST", body: JSON.stringify(body), skipForbiddenHandler: true })
      .then(() => {
        setAsking(false);
        toast({ title: "Request sent", description: "The access admins have been notified.", variant: "success" });
      })
      .catch(() => toast({ title: "Couldn't send the request", description: "Access requests aren't enabled here yet - ask an admin directly.", variant: "destructive" }))
      .finally(() => setBusy(false));
  }

  const form = (
    <div className="w-full max-w-sm space-y-2 text-left">
      <Input
        autoFocus
        value={note}
        maxLength={500}
        placeholder="Why do you need it? (optional)"
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="flex gap-2">
        <Select value={hours} onValueChange={setHours}>
          <SelectTrigger className="h-9 flex-1"><SelectValue /></SelectTrigger>
          <SelectContent>
            {DURATIONS.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button disabled={busy} onClick={request}>Send</Button>
        <Button variant="ghost" disabled={busy} onClick={() => setAsking(false)}>Cancel</Button>
      </div>
    </div>
  );

  return (
    <EmptyState
      icon={Lock}
      title="You don't have access to this"
      description={`Nothing here is yours to see yet. Ask an access admin for ${label}, and it will appear in your sidebar once granted.`}
      action={
        collection
          ? asking
            ? form
            : <Button variant="outline" onClick={() => setAsking(true)}>Request access</Button>
          : undefined
      }
    />
  );
}
