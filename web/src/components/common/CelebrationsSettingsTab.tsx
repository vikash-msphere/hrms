import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { useToast } from "@/components/ui/use-toast";
import { useUnsaved } from "@/components/common/UnsavedChanges";
import { PanelSkeleton } from "@/components/common/Skeletons";
import { getSetting, saveSetting } from "@/lib/settingsStore";

// The Celebrations tab of the Dashboard settings panel (pages/Settings.tsx#DashboardTab): how far ahead
// birthdays and work anniversaries show (settings/celebrations `lead_days`). One number, read by the
// dashboard's Celebrations card and KPI, the team timeline's markers and the sidebar's company-anniversary
// orbit (hooks/useCelebrations.ts), and by the server feed when a caller asks without a window.
//
// Its own settings row rather than a leaf of `settings/dashboard`, because the server reads it too and the
// dashboard blob is the SPA's; so this tab loads and saves on its own, beside the panel's other three.
//
// No built-in value: the field starts on what is stored, and an org with no row sees it empty and must fill
// it in. The server refuses anything outside 0-90 (routes/settings.ts#validateCelebrations).
const MAX_LEAD_DAYS = 90;

export function CelebrationsSettingsTab() {
  const { toast } = useToast();
  const [leadDays, setLeadDays] = useState("");
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // getSetting remembers the version it hands out, and saveSetting writes against it.
    getSetting<{ lead_days?: number }>("celebrations")
      .then((s) => { if (typeof s.value?.lead_days === "number") setLeadDays(String(s.value.lead_days)); })
      .catch(() => { /* no row: the field stays empty until an admin sets it */ })
      .finally(() => setReady(true));
  }, []);

  const n = Number(leadDays);
  const valid = leadDays.trim() !== "" && Number.isInteger(n) && n >= 0 && n <= MAX_LEAD_DAYS;

  const { markSaved } = useUnsaved({ leadDays }, ready, save);
  async function save() {
    if (!valid) {
      toast({ title: "Couldn't save that", description: `Enter a whole number of days from 0 to ${MAX_LEAD_DAYS}.`, variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await saveSetting("celebrations", { value: { lead_days: n } });
      markSaved();
      toast({ title: "Celebrations saved", variant: "success" });
    } catch (e) {
      toast({ title: "Couldn't save that", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  // No live inputs before the stored value lands: a change made on the defaults was replaced by the hydration.
  if (!ready) return <PanelSkeleton />;
  return (
    <div className="space-y-3">
      <label className="block max-w-xs space-y-1">
        <span className="text-sm font-medium">Show birthdays and anniversaries this many days ahead</span>
        <Input type="number" min={0} max={MAX_LEAD_DAYS} value={leadDays} onChange={(e) => setLeadDays(e.target.value)} disabled={!ready} />
      </label>
      <p className="text-xs text-muted-foreground">
        A birthday or work anniversary starts to show on the dashboard, the team timeline and the company
        anniversary logo this many days before the day. 0 shows it on the day only. The leave calendar&apos;s
        birthdays layer still covers the next three months, because there you choose the dates you look at.
      </p>
      <AccessAction collection="settings" objectPath="settings/celebrations" label="Save celebrations">
        <Button onClick={save} disabled={saving || !ready || !valid} loading={saving}>{!saving && <Save className="h-4 w-4" />} Save celebrations</Button>
      </AccessAction>
    </div>
  );
}
