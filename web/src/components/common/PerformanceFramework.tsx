import { useEffect, useState } from "react";
import { Plus, Trash2, Save } from "lucide-react";
import { get } from "@/api";
import { DEFAULT_PERFORMANCE, type Competency, type RatingLevel } from "@/lib/performance";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { AccessAction } from "@/components/access/AccessAction";
import { useToast } from "@/components/ui/use-toast";
import { useUnsaved } from "@/components/common/UnsavedChanges";
import { getSetting, saveSetting } from "@/lib/settingsStore";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

// HR editor for the org's review framework (settings/performance): the competencies each review rates and the
// rating scale. Competency `key` is stable once set (reviews store ratings by key); editing a label never
// changes it. Scale values are the row positions (1..N).
export function PerformanceFramework() {
  const { toast } = useToast();
  const [competencies, setCompetencies] = useState<Competency[]>(DEFAULT_PERFORMANCE.competencies);
  const [scale, setScale] = useState<RatingLevel[]>(DEFAULT_PERFORMANCE.scale);
  // Whether goals need agreeing before they count. Off is the shape most orgs run; on turns goal setting into
  // a handshake (the owner submits, their manager agrees or sends it back).
  const [goalApproval, setGoalApproval] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    getSetting<{ competencies?: Competency[]; scale?: RatingLevel[]; goal_approval?: string }>("performance")
      .then((s) => {
        if (s.value?.competencies?.length) setCompetencies(s.value.competencies);
        if (s.value?.scale?.length) setScale(s.value.scale);
        setGoalApproval(s.value?.goal_approval === "required");
      })
      .catch(() => { /* not configured -> defaults */ })
      .finally(() => setReady(true));
  }, []);

  const { markSaved } = useUnsaved({ competencies, scale, goalApproval }, ready, save);
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
      // A blank anchor and a zero weight are both "not set": stored as absent so a framework that uses
      // neither reads exactly as it did before either existed (and scores as a plain mean).
      const description = c.description?.trim();
      const weight = Number(c.weight) > 0 ? Number(c.weight) : undefined;
      comps.push({ key, label, ...(description ? { description } : {}), ...(weight ? { weight } : {}) });
    }
    const levels = scale.map((s, i) => ({ value: i + 1, label: s.label.trim() })).filter((s) => s.label);
    if (comps.length === 0 || levels.length < 2) {
      toast({ title: "Add at least one competency and two scale levels", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      await saveSetting("performance", { value: { competencies: comps, scale: levels, goal_approval: goalApproval ? "required" : "off" } });
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
          <div className="space-y-3">
            {competencies.map((c, i) => (
              <div key={i} className="space-y-1.5 rounded-md border p-2.5">
                <div className="flex items-center gap-2">
                  <Input value={c.label} placeholder="e.g. Impact & results" onChange={(e) => setCompetencies((arr) => arr.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                  {/* Relative importance. Blank means "counts like the others" - a framework with no weights
                      anywhere scores as the plain mean of its ratings. */}
                  <Input
                    type="number" min={0} className="w-24 shrink-0"
                    value={c.weight ?? ""}
                    placeholder="Weight"
                    aria-label={`Weight for ${c.label || "this competency"}`}
                    onChange={(e) => setCompetencies((arr) => arr.map((x, j) => (j === i ? { ...x, weight: e.target.value === "" ? undefined : Number(e.target.value) } : x)))}
                  />
                  <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0 text-destructive" onClick={() => setCompetencies((arr) => arr.filter((_, j) => j !== i))} aria-label="Remove competency"><Trash2 className="h-4 w-4" /></Button>
                </div>
                {/* The anchor. This is what stops two managers rating the same word against two different
                    meanings and then having their numbers compared in a calibration meeting. */}
                <Input
                  value={c.description ?? ""}
                  placeholder="What this means here - the behaviour a rater should look for"
                  aria-label={`Definition for ${c.label || "this competency"}`}
                  onChange={(e) => setCompetencies((arr) => arr.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))}
                />
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Weights are relative, on any scale you like - 3/2/1 and 30/20/10 score the same. A review then carries
            what its competency ratings add up to, next to the manager's own overall rating.
          </p>
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

        {/* Goal setting. A review scores people against their goals, so whether those goals were ever AGREED
            is a property of the review as much as of the goal - which is why the switch lives here, beside the
            scale, rather than on the Goals page. */}
        <div className="space-y-2 rounded-lg border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-medium">Goals need manager approval</p>
              <p className="text-xs text-muted-foreground">
                {goalApproval
                  ? "An employee's own new goals start as drafts. They submit them, and their manager agrees or sends them back with a note."
                  : "Setting a goal agrees it. Nobody submits anything, and every goal counts from the moment it is written."}
              </p>
            </div>
            <Checkbox checked={goalApproval} onCheckedChange={(v) => setGoalApproval(v === true)} aria-label="Goals need manager approval" />
          </div>
          <p className="text-xs text-muted-foreground">
            A goal a manager writes FOR a report is always agreed on the spot - the approver is the person typing.
            Turning this off leaves any goal already waiting exactly where it is; agree or withdraw those first.
          </p>
        </div>

        <div className="flex justify-end">
          <Button onClick={save} loading={busy}>{!busy && <Save className="h-4 w-4" />} Save framework</Button>
        </div>
      </CardContent>
    </Card>
  );
}
