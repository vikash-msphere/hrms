import { useEffect, useState } from "react";
import { get, patch } from "@/api";
import { CATEGORY_META } from "@/lib/notificationMeta";
import { useToast } from "@/components/ui/use-toast";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useUnsaved } from "@/components/common/UnsavedChanges";
import { pushSupported, getPushState, enablePush, disablePush, type PushState } from "@/lib/webPush";
import type { NotificationPrefs } from "@/types";
import { RowsSkeleton } from "@/components/common/Skeletons";

// Self-service notification preferences: silence event categories FOR YOURSELF (layered over the org config).
// Reads/writes the caller's own employees/<id>/notification-prefs. Ordered by the shared category meta so
// labels + icons match the feed. Muting stops those notifications being created for you at all. Rendered as a
// user-scoped settings panel (the "notification-prefs" registry entry) in the inline Sheet.
const ORDER = Object.entries(CATEGORY_META).filter(([k]) => k !== "system");

export function NotificationPrefsPanel({ employeeId }: { employeeId: string }) {
  const { toast } = useToast();
  const [muted, setMuted] = useState<string[] | null>(null); // null = not yet loaded
  const [digest, setDigest] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    get<NotificationPrefs>(`employees/${employeeId}/notification-prefs`)
      .then((r) => { setMuted(r.muted ?? []); setDigest(r.digest ?? false); })
      .catch(() => setMuted([]));
  }, [employeeId]);

  const toggle = (k: string) =>
    setMuted((m) => (m?.includes(k) ? m.filter((x) => x !== k) : [...(m ?? []), k]));

  const { markSaved } = useUnsaved({ muted, digest }, muted !== null, save);
  async function save() {
    if (muted === null) return;
    setSaving(true);
    try {
      await patch(`employees/${employeeId}/notification-prefs`, { muted, digest });
      markSaved();
      toast({ title: "Preferences saved" });
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't save", description: String((e as Error).message) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Turn a category off to stop those notifications for you.</p>
      {muted === null ? (
        <RowsSkeleton rows={6} />
      ) : (
        <div className="divide-y rounded-md border">
          {ORDER.map(([key, meta]) => {
            const enabled = !muted.includes(key);
            const Icon = meta.icon;
            return (
              <label key={key} className="flex cursor-pointer items-center gap-2.5 px-3 py-2.5 hover:bg-accent">
                <span className={cn("flex h-6 w-6 items-center justify-center rounded-full", meta.cls)}>
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <span className={cn("flex-1 text-sm", !enabled && "text-muted-foreground line-through")}>{meta.label}</span>
                <input type="checkbox" checked={enabled} onChange={() => toggle(key)} className="h-4 w-4 accent-primary" />
              </label>
            );
          })}
        </div>
      )}
      <label className="flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 hover:bg-accent">
        <input type="checkbox" checked={digest} onChange={() => setDigest((d) => !d)} className="mt-0.5 h-4 w-4 accent-primary" />
        <span className="flex-1">
          <span className="block text-sm font-medium">Daily digest</span>
          <span className="block text-xs text-muted-foreground">Batch low-priority updates into one summary each day instead of pinging you one by one. Urgent items and anything needing your action still arrive right away.</span>
        </span>
      </label>
      <BrowserPushRow />
      <div className="flex justify-end border-t pt-3">
        <Button size="sm" onClick={save} loading={saving} disabled={muted === null}>Save</Button>
      </div>
    </div>
  );
}

// Enrol/withdraw THIS browser for push while no tab is open. Renders only when the deployment has push
// configured (VAPID key baked into the build) and the browser supports it; permission-denied shows how to fix
// it rather than a dead toggle. Applies immediately (its own server write) - not part of the Save flow above.
function BrowserPushRow() {
  const { toast } = useToast();
  const [state, setState] = useState<PushState>("unsupported");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void getPushState().then(setState);
  }, []);
  // Never render nothing. This is the screen where someone comes to ask "why am I not getting notified?",
  // and an empty space answers by implying the feature does not exist. Say which of the two reasons applies
  // - the browser cannot, or this build was not configured for it - so the answer is on the page instead of
  // in a support conversation.
  if (!pushSupported()) {
    const browserCant = !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window);
    return (
      <div className="flex items-start gap-2.5 rounded-md border border-dashed px-3 py-2.5">
        <div className="flex-1">
          <span className="block text-sm font-medium text-muted-foreground">Browser notifications unavailable</span>
          <span className="block text-xs text-muted-foreground">
            {browserCant
              ? "This browser can't deliver them. Private/incognito windows usually block them too - try a normal window, or a different browser."
              : "Not enabled for this deployment. An administrator has to configure the push keys."}
          </span>
        </div>
      </div>
    );
  }
  const on = state === "on";
  async function toggle() {
    setBusy(true);
    try {
      if (on) {
        await disablePush();
        setState("off");
        toast({ title: "Browser notifications off" });
      } else {
        await enablePush();
        setState("on");
        toast({ title: "Browser notifications on", description: "This device now gets notified even with the app closed.", variant: "success" });
      }
    } catch (e) {
      setState(await getPushState());
      toast({ variant: "destructive", title: "Couldn't update browser notifications", description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex items-start gap-2.5 rounded-md border px-3 py-2.5">
      <div className="flex-1">
        <span className="block text-sm font-medium">Browser notifications on this device</span>
        <span className="block text-xs text-muted-foreground">
          {state === "denied"
            ? "Blocked in your browser's site settings - allow notifications for this site to turn these on."
            : "Get notified even when no tab is open. Applies to this browser only."}
        </span>
      </div>
      <Button size="sm" variant={on ? "outline" : "default"} loading={busy} disabled={state === "denied"} onClick={() => void toggle()}>
        {on ? "Turn off" : "Turn on"}
      </Button>
    </div>
  );
}
