import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AccessAction } from "@/components/access/AccessAction";
import { useToast } from "@/components/ui/use-toast";
import { useUnsaved } from "@/components/common/UnsavedChanges";
import { getSetting, saveSetting } from "@/lib/settingsStore";

// The thresholds behind the dashboard's "Needs you" list and its weekly roundup.
//
// WHY THESE ARE SETTINGS AT ALL. They were constants, and that meant the product held an opinion nobody could
// argue with on the one screen that tells somebody their work is in trouble. Three weeks of silence on a goal
// is a fine default and nothing more: a team running two-week sprints wants it shorter, and a company whose
// goals are annual wants it longer. Getting it wrong in either direction is expensive - too short and the
// list cries wolf until people stop reading it, too long and it says nothing until the goal is already lost.
//
// NO AI IS INVOLVED IN ANY OF THIS, which the copy says plainly because the list sits next to features that
// do use one. What is on the list is worked out from dates and progress; a separate switch in AI features
// adds a written line over it.

type AttentionConfig = {
  goalStaleDays?: number;
  cardAgedDays?: number;
  limit?: number;
  digestEnabled?: boolean;
  digestWeekday?: number;
};

const DEFAULTS = { goalStaleDays: 21, cardAgedDays: 21, limit: 8, digestEnabled: true, digestWeekday: 1 };

const WEEKDAYS = [
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
  { value: "0", label: "Sunday" },
];

export function AttentionSettingsTab() {
  const { toast } = useToast();
  const [goalStaleDays, setGoalStaleDays] = useState(String(DEFAULTS.goalStaleDays));
  const [cardAgedDays, setCardAgedDays] = useState(String(DEFAULTS.cardAgedDays));
  const [limit, setLimit] = useState(String(DEFAULTS.limit));
  const [digestEnabled, setDigestEnabled] = useState(DEFAULTS.digestEnabled);
  const [digestWeekday, setDigestWeekday] = useState(String(DEFAULTS.digestWeekday));
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getSetting<AttentionConfig>("attention")
      .then((s) => {
        const v = s.value ?? {};
        if (typeof v.goalStaleDays === "number") setGoalStaleDays(String(v.goalStaleDays));
        if (typeof v.cardAgedDays === "number") setCardAgedDays(String(v.cardAgedDays));
        if (typeof v.limit === "number") setLimit(String(v.limit));
        if (typeof v.digestEnabled === "boolean") setDigestEnabled(v.digestEnabled);
        if (typeof v.digestWeekday === "number") setDigestWeekday(String(v.digestWeekday));
      })
      .catch(() => { /* nothing saved yet: the defaults stand, which is what the server uses too */ })
      .finally(() => setReady(true));
  }, []);

  const { markSaved } = useUnsaved({ goalStaleDays, cardAgedDays, limit, digestEnabled, digestWeekday }, ready, save);
  async function save() {
    setSaving(true);
    try {
      // Clamped here as well as on the server, and refused there too. This only keeps the field from
      // displaying a number the app will not honour; the server's refusal is the one that matters, because a
      // screen that accepts a value and quietly uses a different one is worse than one that says no.
      const whole = (s: string, lo: number, hi: number, fallback: number) => {
        const n = Math.round(Number(s));
        return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
      };
      await saveSetting("attention", {
        value: {
          goalStaleDays: whole(goalStaleDays, 1, 365, DEFAULTS.goalStaleDays),
          cardAgedDays: whole(cardAgedDays, 1, 365, DEFAULTS.cardAgedDays),
          limit: whole(limit, 1, 25, DEFAULTS.limit),
          digestEnabled,
          digestWeekday: whole(digestWeekday, 0, 6, DEFAULTS.digestWeekday),
        },
      });
      markSaved();
      toast({ title: "Saved", variant: "success" });
    } catch (e) {
      toast({ title: "Couldn't save that", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> What counts as needing attention</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted-foreground">
          The dashboard&apos;s &quot;Needs you&quot; list is worked out from dates and progress - no AI is involved.
          These are the lines it draws.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="text-sm font-medium">A goal is silent after</span>
            <Input type="number" min={1} max={365} value={goalStaleDays} onChange={(e) => setGoalStaleDays(e.target.value)} />
            <span className="block text-xs text-muted-foreground">
              Days with no progress recorded and nothing said. Silence arrives weeks before a goal is overdue,
              which is why it is worth its own line.
            </span>
          </label>

          <label className="space-y-1">
            <span className="text-sm font-medium">A task is stuck after</span>
            <Input type="number" min={1} max={365} value={cardAgedDays} onChange={(e) => setCardAgedDays(e.target.value)} />
            <span className="block text-xs text-muted-foreground">
              Days in the same board column. Past this the board is no longer telling the truth about the task
              being in flight.
            </span>
          </label>

          <label className="space-y-1">
            <span className="text-sm font-medium">Show at most</span>
            <Input type="number" min={1} max={25} value={limit} onChange={(e) => setLimit(e.target.value)} />
            <span className="block text-xs text-muted-foreground">
              Items on the list, worst first. A long list is a second inbox, which is the thing this is meant
              to save people from.
            </span>
          </label>
        </div>

        <div className="space-y-2 rounded-lg border p-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <Checkbox checked={digestEnabled} onCheckedChange={(v) => setDigestEnabled(v === true)} />
            Send everyone a weekly roundup
          </label>
          <p className="text-xs text-muted-foreground">
            One notification to each person who has something off track - their own work only, never their
            team&apos;s. People can mute it themselves under notification preferences.
          </p>
          {digestEnabled && (
            <label className="flex items-center gap-2 pt-1 text-sm">
              <span className="text-muted-foreground">Sent on</span>
              <Select value={digestWeekday} onValueChange={setDigestWeekday}>
                <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
                <SelectContent>{WEEKDAYS.map((d) => <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>)}</SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground">in the organisation&apos;s timezone</span>
            </label>
          )}
        </div>

        <AccessAction collection="settings" objectPath="settings/attention" label="Save">
          <Button onClick={save} disabled={saving || !ready}>{saving ? "Saving…" : "Save"}</Button>
        </AccessAction>
      </CardContent>
    </Card>
  );
}
