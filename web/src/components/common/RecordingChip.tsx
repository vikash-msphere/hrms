import { useEffect, useState } from "react";
import { Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { invoke } from "@/api";
import { idOf } from "@/lib/utils";
import { useToast } from "@/components/ui/use-toast";
import { navigate } from "@/router";
import { RECORD_SECONDS, onRecordingFinished, stopRecording, useRecording } from "@/lib/screenRecording";
import type { Ticket } from "@/types";

// The countdown, and the only thing on screen while a recording runs.
//
// It lives in the top bar rather than in whatever started the window, because the window deliberately gets out
// of the way: the report dialog hides itself, and a recording started from a ticket drawer outlives the drawer
// as the person navigates to reproduce the fault. This chip is therefore the state, the time left and the way
// out, and it is mounted for every signed-in caller so a reload cannot strand a running recorder.
//
// It also completes ticket-targeted windows. That belongs here for the same reason: after a reload the drawer
// that asked for the recording is gone, and something still has to attach the result.
export function RecordingChip() {
  const session = useRecording();
  const { toast } = useToast();
  const [left, setLeft] = useState(RECORD_SECONDS);

  // Ticks from the persisted deadline, not from a counter: a counter drifts, and after a reload it would start
  // again from the top while the real window carries on expiring.
  useEffect(() => {
    if (!session) return;
    const tick = () => setLeft(Math.max(0, Math.round((session.until - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [session]);

  useEffect(() => {
    if (session && left <= 0) void stopRecording();
  }, [session, left]);

  useEffect(
    () =>
      onRecordingFinished((id, target) => {
        if (target.kind !== "ticket") return; // the report dialog handles its own
        if (!id) {
          toast({ title: "That recording was too short to keep", description: "Try again and give it a few seconds.", variant: "destructive" });
          return;
        }
        // No etag: appending a recording is not an edit of anything a concurrent writer could have changed,
        // and a 409 here would lose a recording over a race that does not matter.
        void invoke<Ticket>(`tickets/${idOf(target.path)}`, "attachRecording", undefined, { session_replay_id: id })
          .then(() =>
            toast({
              title: "Recording added to the ticket",
              variant: "success",
              action: { label: "View ticket", onClick: () => navigate(`tickets/${idOf(target.path)}`) },
            }),
          )
          .catch(() => toast({ title: "The recording could not be added to the ticket", variant: "destructive" }));
      }),
    [toast],
  );

  if (!session) return null;
  return (
    <div
      role="status"
      className="flex h-9 items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 text-sm text-destructive"
    >
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-70" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-destructive" />
      </span>
      {/* m:ss - past 60 seconds a fixed "0:" prefix reads as "0:119". */}
      <span className="font-medium tabular-nums">
        Recording · {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
      </span>
      <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-destructive hover:bg-destructive/15" onClick={() => stopRecording()}>
        <Square className="h-3 w-3 fill-current" /> Stop
      </Button>
    </div>
  );
}
