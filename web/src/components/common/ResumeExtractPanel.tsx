import { useState } from "react";
import { Check, Sparkles, X } from "lucide-react";
import { api, blobOf, patch } from "@/api";
import { openPdf } from "@/lib/pdfjs";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { useToast } from "@/components/ui/use-toast";

// Read a candidate's CV into the candidate form, one field at a time.
//
// THE PDF IS READ HERE, IN THE BROWSER, and the TEXT is what goes to the server. The Worker has no PDF
// reader, this app already ships pdfjs for the document viewer, and a PDF parser is enough of an attack
// surface that keeping it out of the Worker is a feature rather than a workaround.
//
// NOTHING IS SAVED UNTIL SOMEBODY PRESSES ACCEPT, and accept is an ordinary PATCH of the candidate - the same
// write the form does, with the same validation and the same audit row. There is no bulk "accept all" on
// purpose: the point of the review is that a person looked at each value, and one button defeats that.
//
// Which fields can appear at all is the org's setting; this renders whatever comes back.

type Fields = Record<string, unknown>;

const LABELS: Record<string, string> = {
  name: "Name",
  email: "Email",
  phone: "Phone",
  skills: "Skills",
  current_employer: "Current employer",
  current_title: "Current job title",
  years_experience: "Years of experience",
  summary: "Summary",
};

/** Which candidate column each extracted field maps to. `summary` and `years_experience` have no column of
 *  their own - they are shown for the recruiter to read and copy into notes if they want them, never written
 *  automatically, because inventing a destination for them would be this component deciding something the
 *  data model did not. */
const PATCHABLE: Record<string, string> = {
  name: "name",
  email: "email",
  phone: "phone",
  current_employer: "notes",
  current_title: "notes",
  skills: "tags",
};

const render = (v: unknown): string => (Array.isArray(v) ? v.join(", ") : String(v ?? ""));

export function ResumeExtractPanel({ candidateId, candidatePath, can, hasResume, onSaved }: {
  candidateId: string;
  candidatePath: string;
  can?: string[];
  hasResume: boolean;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [fields, setFields] = useState<Fields | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Record<string, "accepted" | "dismissed">>({});

  if (!hasResume) return null;

  async function read() {
    setBusy(true);
    try {
      // The stored CV, then its text. `download` would save it to disk; this wants the bytes.
      const blob = await blobOf(`candidates/${candidateId}`, { verb: "download" });
      const doc = await openPdf(new Uint8Array(await blob.arrayBuffer()));
      let text = "";
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        // `items` mixes text runs with marked-content markers, which carry no `str` at all - hence the guard
        // rather than a cast: a marker stringified would put "[object Object]" into the CV text.
        text += content.items.map((i) => ("str" in i ? i.str : "")).join(" ") + "\n";
        // A CV is a few pages. Stopping at the server's cap here avoids sending a payload that would only be
        // refused, and keeps a pathological 300-page upload from locking the tab.
        if (text.length > 20_000) break;
      }
      const clean = text.trim().slice(0, 20_000);
      if (!clean) {
        toast({ title: "Nothing to read", description: "This file has no selectable text - it may be a scan.", variant: "destructive" });
        return;
      }
      const res = await api<{ fields: Fields }>(`/candidates/${candidateId}:extractResume`, {
        method: "POST",
        body: JSON.stringify({ text: clean }),
      });
      setFields(res.fields);
      setDone({});
    } catch (e) {
      toast({ title: "Couldn't read the CV", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function accept(key: string, value: unknown) {
    const column = PATCHABLE[key];
    if (!column) return;
    try {
      await patch(candidatePath.replace(/^\//, ""), { [column]: render(value) });
      setDone((d) => ({ ...d, [key]: "accepted" }));
      onSaved();
    } catch (e) {
      toast({ title: "Couldn't save that", description: (e as Error).message, variant: "destructive" });
    }
  }

  const shown = fields ? Object.entries(fields).filter(([, v]) => v !== null && v !== undefined && render(v) !== "") : [];

  return (
    <section className="rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold"><Sparkles className="h-4 w-4 text-muted-foreground" /> Read the CV</h2>
        <AccessAction verb="extractResume" collection="candidates" objectPath={candidatePath} can={can} label="Read the CV into the form">
          <Button variant="outline" size="sm" onClick={read} disabled={busy}>{busy ? "Reading…" : fields ? "Read again" : "Read CV"}</Button>
        </AccessAction>
      </div>

      {fields && shown.length === 0 && (
        <p className="mt-2 text-sm text-muted-foreground">The CV did not state any of the fields being looked for.</p>
      )}

      {shown.length > 0 && (
        <>
          <p className="mt-2 text-sm text-muted-foreground">
            Taken from the document. Check each one before accepting - nothing is saved until you do.
          </p>
          <ul className="mt-2 space-y-2">
            {shown.map(([key, value]) => {
              const state = done[key];
              const savable = !!PATCHABLE[key];
              return (
                <li key={key} className="flex flex-wrap items-start justify-between gap-2 rounded-md border p-2.5">
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">{LABELS[key] ?? key}</p>
                    <p className="whitespace-pre-wrap text-sm" data-sentry-mask>{render(value)}</p>
                    {!savable && <p className="text-xs text-muted-foreground">No field on the record holds this - copy it if you want it.</p>}
                  </div>
                  {!state && savable && (
                    <span className="flex gap-1.5">
                      <Button size="sm" variant="outline" onClick={() => accept(key, value)}><Check className="h-4 w-4" /> Accept</Button>
                      <Button size="sm" variant="ghost" onClick={() => setDone((d) => ({ ...d, [key]: "dismissed" }))}><X className="h-4 w-4" /> Dismiss</Button>
                    </span>
                  )}
                  {state === "accepted" && <span className="text-sm text-success">Saved</span>}
                  {state === "dismissed" && <span className="text-sm text-muted-foreground">Dismissed</span>}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
