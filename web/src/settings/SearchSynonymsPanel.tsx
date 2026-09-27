import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AccessAction } from "@/components/access/AccessAction";
import { useToast } from "@/components/ui/use-toast";
import { useUnsaved } from "@/components/common/UnsavedChanges";
import { FormSkeleton } from "@/components/common/Skeletons";
import { getSetting, saveSetting } from "@/lib/settingsStore";

// The org's own ⌘K synonyms (settings/search-synonyms). Each group is a set of words that should find each
// other: typing any one of them also matches the rest, in ⌘K and in every list page's search box. The app's
// built-in groups (PTO / time off / vacation, WFH / work from home, ...) always apply on top of these.
//
// Fed by Settings > Search insights: a query people keep typing and finding nothing for is usually a word this
// org uses that the records do not, and "Add as synonym" there lands here with a group started for it
// (`?add=<query>`).

type SynonymsConfig = { groups?: string[][] };

// A group as the editor holds it: one comma-separated line, which is how people list alternatives anyway.
const toLine = (g: string[]) => g.join(", ");
const toGroup = (line: string) => line.split(",").map((t) => t.trim()).filter(Boolean);

export function SearchSynonymsPanel() {
  const { toast } = useToast();
  const [lines, setLines] = useState<string[]>([]);
  const [version, setVersion] = useState<string | undefined>();
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const add = new URLSearchParams(window.location.search).get("add")?.trim();
    getSetting<SynonymsConfig>("search-synonyms")
      .then((s) => {
        setVersion(s.version);
        const stored = (s.value?.groups ?? []).map(toLine);
        setLines(add ? [...stored, `${add}, `] : stored);
      })
      .catch(() => setLines(add ? [`${add}, `] : []))
      .finally(() => setReady(true));
  }, []);

  const groups = lines.map(toGroup).filter((g) => g.length > 0);
  // Only complete groups are saved; a line with a single word widens nothing and is kept on screen to finish.
  const complete = groups.filter((g) => g.length >= 2);
  const { markSaved } = useUnsaved({ lines }, ready, save);

  async function save() {
    setSaving(true);
    try {
      await saveSetting("search-synonyms", { value: { groups: complete } }, version);
      // The next save writes against what this one left, not against the version the panel opened on.
      setVersion((await getSetting<SynonymsConfig>("search-synonyms")).version);
      markSaved();
      toast({ title: "Saved", description: "Search uses these from the next search on.", variant: "success" });
    } catch (e) {
      toast({ title: "Couldn't save that", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  const setLine = (i: number, v: string) => setLines((ls) => ls.map((l, j) => (j === i ? v : l)));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Search synonyms</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Words your organisation uses that the records do not. Each line is one group, separated by commas -
          typing any word in a group also finds the others, in ⌘K and in every list&apos;s search box. Keep groups
          tight: every word widens every other one, so a loose word turns a precise search into a browse. The
          app&apos;s own groups (PTO and time off, WFH and work from home, payslip and salary slip, ...) always apply.
        </p>
        {!ready ? (
          <FormSkeleton rows={3} />
        ) : (
          <>
            <ul className="space-y-2">
              {lines.map((line, i) => (
                <li key={i} className="flex items-center gap-2">
                  <Input
                    value={line}
                    onChange={(e) => setLine(i, e.target.value)}
                    placeholder="cl, casual leave"
                    aria-label={`Synonym group ${i + 1}`}
                    autoFocus={i === lines.length - 1 && line.endsWith(", ")}
                  />
                  <Button variant="ghost" size="icon" aria-label={`Remove group ${i + 1}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
            {lines.length === 0 && <p className="text-sm text-muted-foreground">No groups of your own yet.</p>}
            {groups.length > complete.length && (
              <p className="text-xs text-warning">A group needs at least two words; one-word lines are not saved.</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setLines((ls) => [...ls, ""])}>
                <Plus className="mr-1 h-4 w-4" /> Add a group
              </Button>
              <AccessAction collection="settings" objectPath="settings/search-synonyms" label="Save">
                <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
              </AccessAction>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
