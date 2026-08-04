import { useEffect, useState } from "react";
import { Plus, Trash2, Save } from "lucide-react";
import { get, patch } from "@/api";
import { DEFAULT_PERFORMANCE, type Competency, type RatingLevel } from "@/lib/performance";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AccessAction } from "@/components/access/AccessAction";
import { useToast } from "@/components/ui/use-toast";
import { useUnsaved } from "@/components/common/UnsavedChanges";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

// HR editor for the org's review framework (settings/performance): the competencies each review rates and the
// rating scale. Competency `key` is stable once set (reviews store ratings by key); editing a label never
// changes it. Scale values are the row positions (1..N).
export function PerformanceFramework() {
  const { toast } = useToast();
  const [competencies, setCompetencies] = useState<Competency[]>(DEFAULT_PERFORMANCE.competencies);
  const [scale, setScale] = useState<RatingLevel[]>(DEFAULT_PERFORMANCE.scale);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    get<{ value?: { competencies?: Competency[]; scale?: RatingLevel[] } }>("settings/performance")
      .then((s) => {
        if (s.value?.competencies?.length) setCompetencies(s.value.competencies);
        if (s.value?.scale?.length) setScale(s.value.scale);
      })
      .catch(() => { /* not configured -> defaults */ })
      .finally(() => setReady(true));
  }, []);

  const { markSaved } = useUnsaved({ competencies, scale }, ready, save);
  async function save() {
    // Drop blank-label rows; assign a stable key to any new competency; dedupe keys; renumber the scale 1..N.
    const seen = new Set<string>();
    const comps: Competency[] = [];
    for (const c of competencies) {
      const label = c.label.trim();
      if (!label) continue;
      let key = c.key || slug(label) || "competency";
      while (seen.has(key)) key += "_x";
      seen.add(key);
      comps.push({ key, label });
    }
    const levels = scale.map((s, i) => ({ value: i + 1, label: s.label.trim() })).filter((s) => s.label);
    if (comps.length === 0 || levels.length < 2) {
      toast({ title: "Add at least one competency and two scale levels", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      await patch("settings/performance", { value: { competencies: comps, scale: levels } });
      setCompetencies(comps);
      setScale(levels);
      markSaved();
      toast({ title: "Framework saved", variant: "success" });
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <AccessAction collection="settings" objectPath="settings/performance" label="Performance framework"><span>Performance framework</span></AccessAction>
        </CardTitle>
        <p className="text-sm text-muted-foreground">The competencies every review rates and the rating scale. Applies to new and in-progress reviews.</p>
      </CardHeader>
      <CardContent className="space-y-6">
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium">Competencies</p>
            <Button variant="outline" size="sm" onClick={() => setCompetencies((c) => [...c, { key: "", label: "" }])}><Plus className="h-3.5 w-3.5" /> Add competency</Button>
          </div>
          <div className="space-y-2">
            {competencies.map((c, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input value={c.label} placeholder="e.g. Impact & results" onChange={(e) => setCompetencies((arr) => arr.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0 text-destructive" onClick={() => setCompetencies((arr) => arr.filter((_, j) => j !== i))} aria-label="Remove competency"><Trash2 className="h-4 w-4" /></Button>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium">Rating scale</p>
            <Button variant="outline" size="sm" onClick={() => setScale((s) => [...s, { value: s.length + 1, label: "" }])}><Plus className="h-3.5 w-3.5" /> Add level</Button>
          </div>
          <div className="space-y-2">
            {scale.map((s, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-muted text-sm font-medium tabular-nums">{i + 1}</span>
                <Input value={s.label} placeholder="e.g. Meets expectations" onChange={(e) => setScale((arr) => arr.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0 text-destructive" onClick={() => setScale((arr) => arr.filter((_, j) => j !== i))} aria-label="Remove level"><Trash2 className="h-4 w-4" /></Button>
              </div>
            ))}
          </div>
        </div>

        <div className="flex justify-end">
          <Button onClick={save} loading={busy}>{!busy && <Save className="h-4 w-4" />} Save framework</Button>
        </div>
      </CardContent>
    </Card>
  );
}
