import * as React from "react";
import { FileSearch, Loader2, PenLine, TriangleAlert, Users, X } from "lucide-react";
import { blobUrl, download, invoke } from "@/api";
import { documentFileName } from "@/lib/documents";
import { runSequential, batchSummary, type BatchProgress } from "@/lib/batchRun";
import { EmployeePicker } from "@/components/common/EmployeePicker";
import { useLetterTemplates, groupByCategory, type LetterTemplateOption } from "@/lib/letterTemplates";
import { useLetterheads } from "@/lib/letterheads";
import { useCollection } from "@/hooks/useCollection";
import { useOrg } from "@/lib/org";
import { LetterInputFields, missingRequiredInputs } from "@/components/common/LetterInputFields";
import { Field } from "@/components/common/Field";
import { WriteDialog } from "@/components/common/WriteDialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Combobox } from "@/components/ui/combobox";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";
import { cn, formatDate, idOf } from "@/lib/utils";
import { readLocal, writeLocal, userKey } from "@/lib/localPref";
import type { Department, DocumentResource, Employee } from "@/types";

// The letter type last generated on this device BY THIS PERSON, so the picker opens where their work is - an
// un-namespaced key defaulted B's dialog to whatever A generated last on a shared machine.
const LAST_KEY = () => userKey("letterTemplate:last");
const lastTemplate = (): string | null => {
  const key = LAST_KEY();
  return key ? readLocal(key) : null;
};
const rememberTemplate = (path: string) => {
  const key = LAST_KEY();
  if (key) writeLocal(key, path);
};

// The one letter-generation dialog, used from the Documents page (pick anyone) and from an employee's profile
// (fixed employee). It used to be two near-identical copies, which is how the profile one quietly lost the
// e-signature choice.
//
// The thing that makes it usable is the preview: a letter is a legal document assembled from the employee
// record, their compensation and the org's letter defaults, and until now the only way to see what came out
// was to generate it, download it, read it, and delete it if it was wrong. `:previewLetter` renders the same
// bytes without persisting anything, so the read happens BEFORE the record exists.
export function GenerateLetterDialog({
  open,
  onClose,
  employee,
  employees,
  departments,
  onGenerated,
}: {
  open: boolean;
  onClose: () => void;
  /** Fixed subject ("employees/<id>"), for the profile entry point. Omit and pass `employees` to choose one. */
  employee?: string;
  /** Selectable subjects, for the Documents page entry point. */
  employees?: Employee[];
  /** Departments, so the extra-recipients picker can select by team. */
  departments?: Department[];
  onGenerated?: () => void;
}) {
  const templates = useLetterTemplates();
  const { org } = useOrg();
  const { toast } = useToast();
  // Only what the reader actually chose lives in state; the defaults (the fixed employee, the first template)
  // are derived below. That matters for the discard guard: a value written into state by an effect AFTER the
  // dialog opened would read as an edit, and cancelling an untouched form would ask to discard nothing.
  // `more` holds the extra recipients of a batch (increment letters go out to forty people at once); `employee`
  // is still the primary one, and the only one the preview renders.
  // `logo` is the letterhead for THIS run: null = whatever the letter type resolves to, "" = the plain square
  // mark, otherwise a `letterheads/<id>` ref. An org with several legal entities issues a letter on the
  // right entity's letterhead, and the same template gets used for all of them.
  const EMPTY = { employee: "", more: [] as string[], type: "", inputs: {} as Record<string, string>, logo: null as string | null, esign: null as boolean | null };
  const [form, setForm] = React.useState(EMPTY);
  const [pickMore, setPickMore] = React.useState(false);
  const [progress, setProgress] = React.useState<BatchProgress | null>(null);
  // Preview state: the rendered object URL plus the form snapshot it was rendered from, so the panel can admit
  // when it is showing something older than what the form now says.
  const [preview, setPreview] = React.useState<{ url: string; snap: string } | null>(null);
  const [rendering, setRendering] = React.useState(false);
  const [previewError, setPreviewError] = React.useState<string | null>(null);

  // Reset during the render that opens the dialog, not in an effect, so the guard's baseline is the empty form.
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) { setForm(EMPTY); setPreviewError(null); }
  }

  const subjectPath = employee ?? form.employee;
  // Whoever generates letters generates the same kind repeatedly (a week of offers, a round of increments), so
  // the default is the last type used rather than whatever sorts first.
  const typePath = form.type || (lastTemplate() && templates.some((t) => t.path === lastTemplate()) ? lastTemplate()! : templates[0]?.path) || "";
  const template = templates.find((t) => t.path === typePath);
  // The letterhead catalogue, fetched only once the dialog is open. Empty - no catalogue, or no
  // `letterheads.read` - means no picker, and the template's own choice still stands server-side.
  const letterheads = useLetterheads({ enabled: open });
  // What the picker SHOWS: this letter type's own letterhead, else the org-wide one for letters (Settings ->
  // Company -> Logos), else the square mark. What it SENDS is `form.logo` - only a real choice, so an untouched
  // picker leaves the server's own template -> org-wide -> square mark chain to run.
  const logo = form.logo ?? template?.letterhead ?? org.document_logos?.letter ?? "";
  const snap = JSON.stringify({ e: subjectPath, t: typePath, i: form.inputs, l: form.logo });
  const stale = !!preview && preview.snap !== snap;

  // One object URL at a time, and none left behind when the dialog closes.
  const dropPreview = React.useCallback(() => {
    setPreview((p) => { if (p) URL.revokeObjectURL(p.url); return null; });
  }, []);
  React.useEffect(() => { if (!open) dropPreview(); }, [open, dropPreview]);
  React.useEffect(() => () => dropPreview(), [dropPreview]);

  const templateEsign = template?.blocks?.some((b) => b.kind === "esignature") ?? false;
  const esign = form.esign ?? templateEsign;
  const missingInputs = missingRequiredInputs(template?.inputs, form.inputs);
  const canSubmit = !!subjectPath && !!typePath && !missingInputs;
  const whyNot = !subjectPath ? "Pick who this letter is for." : !typePath ? "Choose a letter type." : "Fill in the letter's required fields.";

  const empName = (path: string) => {
    const e = employees?.find((x) => idOf(x.path) === idOf(path));
    return e ? `${e.first_name} ${e.last_name}` : "";
  };
  const empNameOr = (path: string) => empName(path) || "Someone"; // a word, never a wire id (lib/utils.ts personName)
  const subject = employees ? empName(subjectPath) : "";
  // Everyone this run writes a letter for: the primary recipient plus any added, de-duplicated.
  const recipients = React.useMemo(
    () => [...new Set([subjectPath, ...form.more].filter(Boolean))],
    [subjectPath, form.more],
  );
  // WHO THE NEXT ATTEMPT IS FOR. A partly-failed batch leaves the dialog open holding the whole list, and
  // pressing Generate again re-ran all of it: for forty people with three failures that files thirty-seven
  // DUPLICATE letters - each a real document on that employee's record, and, where the template carries an
  // `esignature` block, each asking them to sign a second copy. `runSequential` already returns who was
  // missed; this is the half that acts on it.
  const [retryOnly, setRetryOnly] = React.useState<string[] | null>(null);
  const targets = retryOnly ?? recipients;
  // Editing the form is a new run, not a retry of the old one.
  React.useEffect(() => { setRetryOnly(null); }, [subjectPath, form.more, typePath]);

  // A letter of this kind already made for this person in the last month. Warn, never block: a corrected offer
  // or a re-issued certificate is legitimate - what isn't is finding out afterwards that there are now two.
  //
  // Read for THIS subject rather than sifting whatever list the page behind happened to have loaded: that list
  // is one page of documents for everyone, so the letter that makes this a duplicate is as likely as not off
  // the end of it - and the profile entry point has no such list at all, which left it with no warning ever.
  // Scoped to the subject and only once the dialog is open, so the page itself still pays nothing.
  const { rows: subjectDocs } = useCollection<DocumentResource>("personal-documents", {
    params: { employee: subjectPath },
    enabled: open && !!subjectPath,
  });
  const duplicate = React.useMemo(() => {
    if (!template || recipients.length !== 1 || !subjectPath) return null;
    const label = template.label.trim().toLowerCase();
    const cutoff = Date.now() - 30 * 86400000;
    return subjectDocs.find((d) =>
      !d.delete_time && !!d.employee && idOf(d.employee) === idOf(subjectPath) &&
      (d.display_name ?? "").toLowerCase().includes(label) &&
      !!d.create_time && Date.parse(d.create_time) >= cutoff) ?? null;
  }, [subjectDocs, template, recipients.length, subjectPath]);

  async function renderPreview() {
    if (!canSubmit || !template) return;
    setRendering(true);
    setPreviewError(null);
    try {
      const url = await blobUrl("personal-documents", {
        verb: "previewLetter",
        body: {
          employee: subjectPath,
          template: { id: template.path, label: template.label, letterhead: template.letterhead, inputs: template.inputs, blocks: template.blocks },
          ...(template.inputs?.length ? { input: form.inputs } : {}),
          ...(form.logo !== null ? { letterhead: form.logo } : {}),
        },
      });
      setPreview((p) => { if (p) URL.revokeObjectURL(p.url); return { url, snap }; });
    } catch (e) {
      setPreviewError((e as Error).message);
    } finally {
      setRendering(false);
    }
  }

  // Through `invoke`, not the raw `api` helper: a generated letter is a new document row, and only the write
  // helpers refresh the shared cache every list of somebody's documents reads from.
  const generateFor = (path: string) =>
    invoke<DocumentResource>("personal-documents", "generateLetter", undefined, {
      employee: path,
      letter_type: typePath,
      ...(template?.inputs?.length ? { input: form.inputs } : {}),
      ...(form.logo !== null ? { letterhead: form.logo } : {}),
      ...(form.esign !== null ? { esign: form.esign } : {}),
    });

  async function submit() {
    if (targets.length > 1 || retryOnly) {
      // A batch is a list of renders, one per person, walked sequentially and reported honestly: forty
      // downloads would be hostile, so nothing is downloaded - each letter is filed under its own employee.
      const missed: string[] = [];
      const result = await runSequential(
        targets,
        empNameOr,
        async (path) => { try { return await generateFor(path); } catch (e) { missed.push(path); throw e; } },
        setProgress,
      );
      setProgress(null);
      onGenerated?.();
      setRetryOnly(missed.length ? missed : null);
      if (result.failures.length) {
        // Thrown, not toasted: the dialog stays open with the list of who was missed - and the next press is
        // now over exactly those people, so nobody who already has their letter gets a second one.
        throw new Error(`${batchSummary(result, "letter")} Not done: ${result.failures.map((f) => `${f.label} (${f.message})`).join("; ")}. Generate again to retry just those ${missed.length === 1 ? "one" : missed.length}.`);
      }
      toast({ title: batchSummary(result, "letter"), description: "Each one is filed under its employee's documents.", variant: "success" });
      return;
    }
    const doc = await generateFor(subjectPath);
    toast({ title: "Letter generated", description: doc.display_name, variant: "success" });
    onGenerated?.();
    // Offer the freshly-rendered PDF straight away; it is filed under the employee's documents either way.
    try { await download(doc.path, documentFileName({ ...doc, content_type: doc.content_type ?? "application/pdf" })); } catch { /* it's in the list to download */ }
  }

  return (
    <WriteDialog
      open={open}
      onClose={onClose}
      title={retryOnly ? `Retry ${retryOnly.length} letter${retryOnly.length === 1 ? "" : "s"}` : recipients.length > 1 ? `Generate ${recipients.length} letters` : "Generate letter"}
      description={
        retryOnly
          ? `Only the ${retryOnly.length === 1 ? "one" : retryOnly.length} that could not be filed: ${retryOnly.map(empNameOr).join(", ")}. Everyone else already has theirs.`
          : recipients.length > 1
          ? `One letter each, filed under their own documents.${esign ? " Each recipient is asked to e-sign theirs." : ""} Nothing is downloaded - there would be ${recipients.length} files.`
          : esign
            ? `Filed under ${subject || "the employee"}'s documents and downloaded now. They are asked to e-sign it, and it locks once signed.`
            : `Filed under ${subject || "the employee"}'s documents and downloaded now.`
      }
      collection="personal-documents"
      guardLabel="letter"
      form={form}
      submitLabel={retryOnly ? `Retry ${retryOnly.length}` : recipients.length > 1 ? `Generate ${recipients.length}` : "Generate"}
      canSubmit={canSubmit}
      whyNot={whyNot}
      onSubmit={submit}
      className={cn(preview && "sm:max-w-5xl")}
    >
      <div className={cn(preview ? "flex flex-col gap-6 lg:flex-row" : "grid gap-4")}>
        <div className={cn("min-w-0 space-y-4", preview && "lg:w-[46%] lg:shrink-0")}>
          {employees && (
            <Field label="Employee" hint={form.more.length ? `Plus ${form.more.length} more - the preview shows this one.` : undefined}>
              <div className="flex items-center gap-2">
                <Combobox
                  className="flex-1"
                  value={subjectPath}
                  onValueChange={(v) => setForm({ ...form, employee: v })}
                  placeholder="Select an employee…"
                  searchPlaceholder="Search employees…"
                  options={employees.filter((e) => !e.disabled).map((e) => ({ value: `employees/${idOf(e.path)}`, label: `${e.first_name} ${e.last_name}` }))}
                />
                {/* The same letter usually goes to a batch: an increment round, a probation cohort. */}
                <Button type="button" variant="outline" onClick={() => setPickMore(true)}>
                  <Users className="h-4 w-4" /> {form.more.length ? `+${form.more.length}` : "Add more"}
                </Button>
              </div>
            </Field>
          )}
          {form.more.length > 0 && (
            <div className="-mt-1 flex flex-wrap items-center gap-1.5">
              {form.more.map((p) => (
                <span key={p} className="inline-flex items-center gap-1 rounded-full border py-0.5 pl-2 pr-1 text-xs">
                  {empNameOr(p)}
                  <button
                    type="button"
                    onClick={() => setForm({ ...form, more: form.more.filter((x) => x !== p) })}
                    aria-label={`Remove ${empNameOr(p)}`}
                    className="rounded-full p-0.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <Button type="button" variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setForm({ ...form, more: [] })}>Clear</Button>
            </div>
          )}
          {progress && (
            <p className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              Generating {progress.done + 1} of {progress.total}
              {progress.current ? ` - ${progress.current}` : ""}
              {progress.failures.length ? ` (${progress.failures.length} failed so far)` : ""}
            </p>
          )}
          <Field label="Letter type" hint={template?.category ? `${template.category} letter, built from the record and your letter defaults.` : "Built from the employee's record, compensation and your letter defaults."}>
            <Select value={typePath} onValueChange={(v) => { rememberTemplate(v); setForm({ ...form, type: v, inputs: {}, logo: null, esign: null }); }}>
              <SelectTrigger><SelectValue placeholder="Select a letter…" /></SelectTrigger>
              <SelectContent>
                {groupByCategory(templates).map((g) => (
                  <SelectGroup key={g.category}>
                    <SelectLabel>{g.category}</SelectLabel>
                    {g.items.map((t: LetterTemplateOption) => <SelectItem key={t.path} value={t.path}>{t.label}</SelectItem>)}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {/* Only shown when there is something to choose between: with no catalogue (or no access to it) every
              letter carries the organization logo and a picker would be a control with one option. */}
          {letterheads.length > 0 && (
            <Field
              label="Letterhead"
              hint={form.logo === null ? "What this letter type is set to. Change it for just this document." : "Overriding this letter type, for this document only."}
            >
              <Select
                value={letterheads.some((l) => l.path === logo) ? logo : "__org"}
                onValueChange={(v) => setForm({ ...form, logo: v === "__org" ? "" : v })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__org">Square mark</SelectItem>
                  {letterheads.map((l) => <SelectItem key={l.path} value={l.path!}>{l.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          )}
          {duplicate && (
            <p className="-mt-1 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning">
              <TriangleAlert className="mr-1 inline h-3.5 w-3.5" />
              "{duplicate.display_name}" was already filed for {subject || "this employee"}
              {duplicate.create_time ? ` on ${formatDate(duplicate.create_time)}` : ""} - generating another leaves two letters saying the same thing.
            </p>
          )}
          {template?.inputs?.length ? (
            <LetterInputFields inputs={template.inputs} values={form.inputs} onChange={(k, v) => setForm((s) => ({ ...s, inputs: { ...s.inputs, [k]: v } }))} />
          ) : null}
          {template && (
            <label className="flex items-start gap-2 rounded-lg border p-3">
              <Checkbox checked={esign} onCheckedChange={(v) => setForm({ ...form, esign: v === true })} className="mt-0.5" />
              <span>
                <span className="flex items-center gap-1.5 text-sm font-medium"><PenLine className="h-3.5 w-3.5" /> Require e-signature</span>
                <span className="block text-xs text-muted-foreground">
                  {esign
                    ? "The employee signs it in place; the letter locks once signed."
                    : "Filed as a final document - nobody is asked to sign it."}
                  {form.esign === null ? " Following this template's own setting." : " Overriding this template."}
                </span>
              </span>
            </label>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={renderPreview} loading={rendering} disabled={!canSubmit}>
              {!rendering && <FileSearch className="h-4 w-4" />} {preview ? "Refresh preview" : "Preview"}
            </Button>
            {stale && !rendering && <span className="text-xs text-muted-foreground">Showing the previous render.</span>}
            {!preview && !rendering && <span className="text-xs text-muted-foreground">Renders the real letter without filing it.</span>}
          </div>
          {previewError && <p className="text-xs text-destructive">{previewError}</p>}
        </div>
        {preview && (
          <div className="min-w-0 flex-1">
            <iframe title="Letter preview" src={preview.url} className={cn("h-[60dvh] w-full rounded-md border bg-muted/30", stale && "opacity-60")} />
          </div>
        )}
        {!preview && rendering && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Rendering the letter…</p>
        )}
      </div>
      {pickMore && employees && (
        <EmployeePicker
          title="Also generate for"
          confirmLabel="Add"
          employees={employees}
          departments={departments ?? []}
          onClose={() => setPickMore(false)}
          onConfirm={(refs) => {
            // The primary recipient is not a duplicate of themselves.
            setForm((s) => ({ ...s, more: [...new Set(refs.filter((r) => idOf(r) !== idOf(subjectPath)))] }));
            setPickMore(false);
          }}
        />
      )}
    </WriteDialog>
  );
}
