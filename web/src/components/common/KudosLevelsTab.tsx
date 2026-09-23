import { useEffect, useState } from "react";
import { Award, ChevronDown, MessageSquareQuote, Plus, Save, Tag, Trash2 } from "lucide-react";
import { get } from "@/api";
import { DEFAULT_KUDOS_LEVELS, type KudosLevel, type KudosCategory } from "@/lib/kudosLevels";
import { IconPicker } from "@/lib/categoryIcons";
import { KudosArtPicker } from "@/components/common/KudosArtPicker";
import { kudosArtFiles } from "@/lib/kudosArt";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { useToast } from "@/components/ui/use-toast";
import { useUnsaved } from "@/components/common/UnsavedChanges";
import { getSetting, saveSetting } from "@/lib/settingsStore";

// HR editor for the kudos config (settings/kudos): the recognition LEVELS (weighted tiers feeding the
// leaderboard) and the CATEGORIES (a flat, optional taxonomy for tagging recognition), each with optional
// example remarks (prompts) that rotate through the give-kudos placeholder. All live in one blob, so saving
// writes them together. Open-read so any giver can pick; write-gated to HR.
export function KudosLevelsTab() {
  const { toast } = useToast();
  const [levels, setLevels] = useState<KudosLevel[]>(DEFAULT_KUDOS_LEVELS);
  const [categories, setCategories] = useState<KudosCategory[]>([]);
  const [promptsOpen, setPromptsOpen] = useState<number | null>(null); // index of the category whose prompts are unfolded
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getSetting<{ levels?: KudosLevel[]; categories?: KudosCategory[] }>("kudos")
      .then((s) => {
        if (s.value?.levels?.length) setLevels(s.value.levels);
        if (Array.isArray(s.value?.categories)) setCategories(s.value!.categories!);
      })
      .catch(() => { /* keep defaults */ })
      .finally(() => setReady(true));
  }, []);

  const setRow = (i: number, p: Partial<KudosLevel>) => setLevels((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const setCat = (i: number, p: Partial<KudosCategory>) => setCategories((cs) => cs.map((c, j) => (j === i ? { ...c, ...p } : c)));
  const setPrompts = (i: number, fn: (ps: string[]) => string[]) => setCat(i, { prompts: fn(categories[i]?.prompts ?? []) });

  const { markSaved } = useUnsaved({ levels, categories }, ready, save);
  async function save() {
    const cleanedLevels = levels.map((l) => ({ name: l.name.trim(), points: Number(l.points) || 0 })).filter((l) => l.name);
    if (!cleanedLevels.length) { toast({ title: "Add at least one level", variant: "destructive" }); return; }
    // Two categories of one name (case-insensitive) are refused, not merged: the save used to keep the first and
    // drop the rest without a word, so a category added under a name already on the list - icon, art, prompts
    // and all - vanished behind a "saved" toast.
    const names = categories.map((c) => c.name.trim().toLowerCase()).filter(Boolean);
    const clash = names.find((n, i) => names.indexOf(n) !== i);
    if (clash) {
      const shown = categories.find((c) => c.name.trim().toLowerCase() === clash)!.name.trim();
      toast({ title: `Two categories are called "${shown}"`, description: "Rename or remove one, then save.", variant: "destructive" });
      return;
    }
    // Blanks dropped. Empty list is valid (no category axis). Prompts are trimmed with blank lines dropped; an
    // empty list is omitted from the blob.
    const seen = new Set<string>();
    const cleanedCats = categories
      .map((c) => {
        const prompts = (c.prompts ?? []).map((p) => p.trim()).filter(Boolean);
        const art = kudosArtFiles(c.art);
        return { name: c.name.trim(), icon: c.icon || undefined, art: art.length ? art : undefined, prompts: prompts.length ? prompts : undefined };
      })
      .filter((c) => c.name && !seen.has(c.name.toLowerCase()) && seen.add(c.name.toLowerCase()));
    setSaving(true);
    try {
      await saveSetting("kudos", { value: { levels: cleanedLevels, categories: cleanedCats } });
      setLevels(cleanedLevels);
      setCategories(cleanedCats);
      markSaved();
      toast({ title: "Kudos config saved", variant: "success" });
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          <AccessAction collection="settings" objectPath="settings/kudos" label="Kudos config"><span className="flex items-center gap-2"><Award className="h-4 w-4 text-primary" /> Kudos recognition</span></AccessAction>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium">Levels</p>
            <p className="text-sm text-muted-foreground">Tiers a giver can pick when sending kudos. Each level's points feed the "most recognized" leaderboard (higher = more weight). Order them lowest to highest.</p>
          </div>
          <div className="space-y-2">
            {levels.map((l, i) => (
              <div key={i} className="editor-row">
                <Input className="editor-row-main" value={l.name} placeholder="Level name (e.g. Impact)" onChange={(e) => setRow(i, { name: e.target.value })} />
                <span className="text-sm text-muted-foreground">points</span>
                <Input type="number" className="w-24" value={l.points} onChange={(e) => setRow(i, { points: Number(e.target.value) })} />
                <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="Remove level" onClick={() => setLevels((ls) => ls.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
              </div>
            ))}
            {levels.length === 0 && <p className="text-sm text-muted-foreground">No levels - add one below.</p>}
          </div>
          <Button size="sm" variant="outline" onClick={() => setLevels((ls) => [...ls, { name: "", points: ls.length + 1 }])}><Plus className="h-4 w-4" /> Add level</Button>
        </div>

        <div className="space-y-3 border-t pt-5">
          <div>
            <p className="flex items-center gap-1.5 text-sm font-medium"><Tag className="h-3.5 w-3.5 text-muted-foreground" /> Categories</p>
            <p className="text-sm text-muted-foreground">An optional taxonomy a giver can tag a kudos with (e.g. Teamwork, Innovation). Unweighted - purely for grouping and filtering. Leave empty to hide the category picker.</p>
          </div>
          <div className="space-y-2">
            {categories.map((c, i) => {
              const count = (c.prompts ?? []).filter((p) => p.trim()).length;
              const open = promptsOpen === i;
              return (
                <div key={i} className={cn("rounded-md", open && "border bg-muted/30 p-2")}>
                  <div className="editor-row">
                    <IconPicker value={c.icon} onChange={(v) => setCat(i, { icon: v })} />
                    <KudosArtPicker value={c.art} onChange={(v) => setCat(i, { art: v })} />
                    {/* Not `editor-row-main` here: the two pickers and the Prompts button only come to
                        ~170px between them, so the name field still gets a usable ~130px on the same
                        line. A forced full-width field would cost a third line for no gain. */}
                    <Input className="min-w-[7rem] flex-1" value={c.name} placeholder="Category name (e.g. Teamwork)" onChange={(e) => setCat(i, { name: e.target.value })} />
                    <Button
                      type="button"
                      size="sm"
                      variant={open ? "secondary" : "ghost"}
                      className="h-8 gap-1.5 px-2 text-muted-foreground"
                      onClick={() => setPromptsOpen(open ? null : i)}
                      aria-expanded={open}
                    >
                      <MessageSquareQuote className="h-3.5 w-3.5" />
                      <span className="text-xs tabular-nums">{count}</span>
                      <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="Remove category" onClick={() => { setCategories((cs) => cs.filter((_, j) => j !== i)); setPromptsOpen((cur) => (cur === i ? null : cur !== null && cur > i ? cur - 1 : cur)); }}><Trash2 className="h-4 w-4" /></Button>
                  </div>
                  {open && (
                    <div className="mt-2 space-y-2 border-t pt-2">
                      <p className="text-xs text-muted-foreground">
                        Inspiration prompts: example remarks that rotate in the message box while a giver picks this category, to spark what to write. Optional.
                      </p>
                      {(c.prompts ?? []).map((p, k) => (
                        <div key={k} className="flex items-start gap-2">
                          <Textarea
                            rows={1}
                            className="min-h-9 flex-1 resize-y text-sm"
                            value={p}
                            placeholder="e.g. You made the whole sprint feel lighter - thanks for pairing on the tricky bits."
                            onChange={(e) => setPrompts(i, (ps) => ps.map((x, j) => (j === k ? e.target.value : x)))}
                          />
                          <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" aria-label="Remove prompt" onClick={() => setPrompts(i, (ps) => ps.filter((_, j) => j !== k))}><Trash2 className="h-4 w-4" /></Button>
                        </div>
                      ))}
                      {count === 0 && (c.prompts ?? []).length === 0 && <p className="text-xs text-muted-foreground">No prompts yet - the message box falls back to a generic placeholder.</p>}
                      <Button size="sm" variant="outline" onClick={() => setPrompts(i, (ps) => [...ps, ""])}><Plus className="h-4 w-4" /> Add prompt</Button>
                    </div>
                  )}
                </div>
              );
            })}
            {categories.length === 0 && <p className="text-sm text-muted-foreground">No categories yet.</p>}
          </div>
          <Button size="sm" variant="outline" onClick={() => setCategories((cs) => [...cs, { name: "", icon: "" }])}><Plus className="h-4 w-4" /> Add category</Button>
        </div>

        <div className="border-t pt-4">
          <Button size="sm" onClick={save} loading={saving}><Save className="h-4 w-4" /> Save</Button>
        </div>
      </CardContent>
    </Card>
  );
}
