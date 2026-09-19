import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { useToast } from "@/components/ui/use-toast";
import { useUnsaved } from "@/components/common/UnsavedChanges";
import { getSetting, saveSetting } from "@/lib/settingsStore";

// The org's AI switches (settings/ai). Two things are decided here and they are different decisions:
// WHICH features may use a model at all, and HOW MUCH of the shared daily allowance they may spend.
//
// Everything defaults to OFF, and the copy says so plainly rather than hiding it behind a toggle that looks
// pre-enabled. Binding Workers AI in the deployment is an operator's act; deciding that this organisation's
// ticket text and directory entries may be processed by a model belongs to whoever is accountable for the
// employee data. Each feature also states what it does WITHOUT AI, because every one of them has a working
// non-AI path and switching it off is not a loss of function.

type AiFeatureKey = "search.semantic" | "tickets.triage" | "drafting" | "ats.extraction" | "tables.describe" | "analytics.narrate";
type AiConfig = { features?: Partial<Record<AiFeatureKey, boolean>>; dailyNeurons?: number; perUserHourlyGenerations?: number; resume_fields?: string[] };

// Which fields a CV may be read into, and which of those are the model doing more than copying. Mirrors
// src/domain/resumeFields.ts; the server validates the names on write, so a drift here is a 400 rather than a
// silently ignored setting.
const RESUME_FIELDS: { key: string; label: string; caution?: string }[] = [
  { key: "name", label: "Name" },
  { key: "email", label: "Email address" },
  { key: "phone", label: "Phone number" },
  { key: "skills", label: "Skills", caution: "The model decides what counts as a skill." },
  { key: "current_employer", label: "Current employer" },
  { key: "current_title", label: "Current job title" },
  { key: "years_experience", label: "Years of experience", caution: "Only when the CV states it, but this is the field most likely to read as fact when it is not." },
  { key: "summary", label: "Summary of experience", caution: "A paraphrase in the model's words, which a recruiter will read as what the CV said." },
];
const DEFAULT_RESUME_FIELDS = ["name", "email", "phone", "skills", "current_employer", "current_title"];

// Copy lives next to the key so adding a feature is one edit, and so no switch can ship without an
// explanation of what it turns on and what happens when it is off.
const FEATURES: { key: AiFeatureKey; title: string; on: string; off: string }[] = [
  {
    key: "search.semantic",
    title: "Semantic search",
    on: "Search also matches by MEANING, so \"maternity\" finds \"parental leave\". Titles and subtitles of the collections listed for indexing are embedded - the same text a search result already shows you.",
    off: "Search matches words and prefixes only, exactly as it does today. Nothing is embedded and the index is emptied as records change.",
  },
  {
    key: "tickets.triage",
    title: "Ticket triage suggestions",
    on: "A new ticket is compared to the resolved tickets nearest it, and the servicing department, category and priority they agree on is offered as a suggestion, with the tickets that voted. Possible duplicates are flagged. No text is generated and nothing is applied automatically.",
    off: "Tickets are routed and prioritised by hand, exactly as they are today.",
  },
  {
    key: "drafting",
    title: "Writing assistance",
    on: "A Draft button appears on announcements, job descriptions, goals and suggestion responses. It writes from what the person types into the box and nothing else: no record is read and no employee data goes into the request. The result lands in the editor for them to change and save, and is never saved on their behalf.",
    off: "No Draft buttons appear. Every one of those fields is typed by hand, as it is today.",
  },
  {
    key: "ats.extraction",
    title: "Read a CV into the candidate form",
    on: "A recruiter can have a candidate's CV read into the form fields, then accept or discard each one. The model transcribes only: it does not score, rank or comment on a candidate's suitability, and it is not asked to. Nothing is saved to the candidate until the recruiter accepts it. This is the one place candidate data is sent to a model, and it happens per candidate on a recruiter's action - never in bulk and never in the background.",
    off: "CVs are read by people. Candidate data is never sent to a model at all.",
  },
  {
    key: "tables.describe",
    title: "Describe a table in words",
    on: "In the table builder, someone can say what they want the grid to show and get columns, filters and sorting laid out for them to adjust. The model is shown only the field names that person can already pick from, and can only answer with those - anything it invents is reported back as not found rather than used. No rows are read and nothing is saved.",
    off: "Grids are built by picking fields from the catalogue, as they are today.",
  },
  {
    key: "analytics.narrate",
    title: "Write up what changed in team reports",
    on: "A team report can be summarised against the previous period in a sentence or two. Which measures moved is worked out arithmetically, not by the model, so it cannot report a change that did not happen; and a summary containing any number that was not in those measures is thrown away in favour of a plain one. Team totals only, never individuals.",
    off: "Reports show their numbers without a written summary, as they do today.",
  },
];

const DEFAULTS = { dailyNeurons: 7000, perUserHourlyGenerations: 20 };

export function AiSettingsTab() {
  const { toast } = useToast();
  const [features, setFeatures] = useState<Record<string, boolean>>({});
  const [resumeFields, setResumeFields] = useState<string[]>([...DEFAULT_RESUME_FIELDS]);
  const [dailyNeurons, setDailyNeurons] = useState(DEFAULTS.dailyNeurons);
  const [perUserHourly, setPerUserHourly] = useState(DEFAULTS.perUserHourlyGenerations);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getSetting<AiConfig>("ai")
      .then((s) => {
        setFeatures({ ...(s.value?.features ?? {}) });
        if (Array.isArray(s.value?.resume_fields)) setResumeFields(s.value.resume_fields);
        if (typeof s.value?.dailyNeurons === "number") setDailyNeurons(s.value.dailyNeurons);
        if (typeof s.value?.perUserHourlyGenerations === "number") setPerUserHourly(s.value.perUserHourlyGenerations);
      })
      .catch(() => { /* nothing saved yet: everything stays off, which is the default */ })
      .finally(() => setReady(true));
  }, []);

  const { markSaved } = useUnsaved({ features, resumeFields, dailyNeurons, perUserHourly }, ready, save);
  async function save() {
    setSaving(true);
    try {
      await saveSetting("ai", {
        value: {
          features,
          // Sent in the canonical order rather than click order, so the stored blob is stable for one chosen
          // set - the server derives a cache key from it.
          resume_fields: RESUME_FIELDS.map((f) => f.key).filter((k) => resumeFields.includes(k)),
          // Clamped here as well as on the server. The server's clamp is the one that matters - a number
          // above the free allocation cannot buy any more of it - and this only keeps the field from
          // displaying a figure the app will not honour.
          dailyNeurons: Math.max(0, Math.min(Number(dailyNeurons) || 0, DEFAULTS.dailyNeurons)),
          perUserHourlyGenerations: Math.max(0, Math.min(Number(perUserHourly) || 0, DEFAULTS.perUserHourlyGenerations)),
        },
      });
      markSaved();
      toast({ title: "AI settings saved", variant: "success" });
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
          <AccessAction collection="settings" objectPath="settings/ai" label="AI features">
            <span className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary" /> AI features</span>
          </AccessAction>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <p className="text-sm text-muted-foreground">
          These features run on Cloudflare Workers AI, inside the same account that already holds this
          application's database and documents. Nothing is sent to an outside model provider, and the text
          involved is never salary, statutory, medical or assessment data - those are excluded in code, not by
          configuration. Every feature here is off until you turn it on, and each works without AI when it is off.
        </p>

        <div className="space-y-3">
          {FEATURES.map((f) => {
            const on = features[f.key] === true;
            return (
              <div key={f.key} className="rounded-md border p-3">
                <label className="flex cursor-pointer items-start gap-3">
                  <Checkbox
                    checked={on}
                    onCheckedChange={(v) => setFeatures((cur) => ({ ...cur, [f.key]: v === true }))}
                    aria-label={f.title}
                    className="mt-0.5"
                  />
                  <span className="min-w-0 space-y-1">
                    <span className="block text-sm font-medium">{f.title}</span>
                    <span className="block text-sm text-muted-foreground">{on ? f.on : f.off}</span>
                  </span>
                </label>
              </div>
            );
          })}
        </div>

        {features["ats.extraction"] === true && (
          <div className="space-y-3 border-t pt-5">
            <div>
              <p className="text-sm font-medium">Which fields a CV may be read into</p>
              <p className="text-sm text-muted-foreground">
                Only the fields ticked here are asked for, and anything else the model returns is discarded.
                A recruiter still accepts or discards each value before it is saved to the candidate.
              </p>
            </div>
            <div className="space-y-2">
              {RESUME_FIELDS.map((f) => {
                const on = resumeFields.includes(f.key);
                return (
                  <label key={f.key} className="flex cursor-pointer items-start gap-3 rounded-md border p-2.5">
                    <Checkbox
                      checked={on}
                      onCheckedChange={(v) => setResumeFields((cur) => (v === true ? [...cur, f.key] : cur.filter((k) => k !== f.key)))}
                      aria-label={f.label}
                      className="mt-0.5"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm">{f.label}</span>
                      {/* Shown for the fields where the model is doing more than copying, so the person
                          choosing can tell those apart without having read the prompt. */}
                      {f.caution && <span className="block text-sm text-warning">{f.caution}</span>}
                    </span>
                  </label>
                );
              })}
            </div>
            {resumeFields.length === 0 && (
              <p className="text-sm text-warning">
                Nothing is ticked, so extraction will refuse rather than read the whole CV. Tick at least one
                field, or switch the feature off above.
              </p>
            )}
          </div>
        )}

        <div className="space-y-3 border-t pt-5">
          <div>
            <p className="text-sm font-medium">Daily budget</p>
            <p className="text-sm text-muted-foreground">
              Cloudflare includes a free allowance of 10,000 neurons a day, shared by the whole account
              (including any staging deployment). These ceilings sit below it. They can only be lowered:
              setting a higher number does not buy more allowance, so the app ignores it. When the budget is
              spent, every feature falls back to its non-AI behaviour until the allowance resets at midnight UTC.
            </p>
          </div>
          <div className="editor-row">
            <span className="editor-row-main text-sm">Neurons per day, org-wide</span>
            <Input type="number" className="w-28" value={dailyNeurons} onChange={(e) => setDailyNeurons(Number(e.target.value))} />
          </div>
          <div className="editor-row">
            <span className="editor-row-main text-sm">Generated drafts per person, per hour</span>
            <Input type="number" className="w-28" value={perUserHourly} onChange={(e) => setPerUserHourly(Number(e.target.value))} />
          </div>
        </div>

        <div className="flex justify-end">
          <Button onClick={save} disabled={saving || !ready}>{saving ? "Saving..." : "Save"}</Button>
        </div>
      </CardContent>
    </Card>
  );
}
