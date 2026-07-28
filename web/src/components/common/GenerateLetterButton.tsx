import { useState } from "react";
import { Sparkles } from "lucide-react";
import { api, download } from "@/api";
import { usePermission } from "@/lib/perm";
import { useLetterTemplates, groupByCategory } from "@/lib/letterTemplates";
import type { DocumentResource } from "@/types";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Field } from "@/components/common/Field";
import { LetterInputFields, missingRequiredInputs } from "@/components/common/LetterInputFields";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

/** Generate an HR letter for a fixed employee and file it as their personal document. Gated to HR + super
 *  (the server enforces personal-documents.generateLetter); renders nothing for anyone else. The available
 *  letter types come from the letter-templates setting. */
export function GenerateLetterButton({ employeeId, onGenerated }: { employeeId: string; onGenerated?: () => void }) {
  const canGenerate = usePermission("personal-documents.write");
  const templates = useLetterTemplates();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState("");
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  if (!canGenerate) return null;

  const selected = templates.find((t) => t.path === type);

  async function generate() {
    setBusy(true);
    try {
      const doc = await api<DocumentResource>("/personal-documents:generateLetter", {
        method: "POST",
        body: JSON.stringify({ employee: `employees/${employeeId}`, letter_type: type, ...(selected?.inputs?.length ? { input: inputs } : {}) }),
      });
      toast({ title: "Letter generated", description: doc.display_name, variant: "success" });
      setOpen(false);
      onGenerated?.();
      try { await download(doc.path, doc.file_name || `${doc.display_name}.pdf`); } catch { /* it's filed under the employee's documents */ }
    } catch (e) {
      toast({ title: "Couldn't generate letter", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <AccessAction collection="personal-documents" verb="generateLetter" label="Generate letter">
        <Button variant="outline" size="sm" onClick={() => { setType(templates[0]?.path ?? ""); setInputs({}); setOpen(true); }}>
          <Sparkles className="h-4 w-4" /> Generate letter
        </Button>
      </AccessAction>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Generate letter</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Built from the employee's record, compensation and your organization's letter defaults.
          </p>
          <Field label="Letter type">
            <Select value={type} onValueChange={(v) => { setType(v); setInputs({}); }}>
              <SelectTrigger><SelectValue placeholder="Select a letter…" /></SelectTrigger>
              <SelectContent>
                {groupByCategory(templates).map((g) => (
                  <SelectGroup key={g.category}>
                    <SelectLabel>{g.category}</SelectLabel>
                    {g.items.map((t) => <SelectItem key={t.path} value={t.path}>{t.label}</SelectItem>)}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {selected?.inputs?.length ? <LetterInputFields inputs={selected.inputs} values={inputs} onChange={(k, v) => setInputs((s) => ({ ...s, [k]: v }))} /> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={generate} loading={busy} disabled={!type || missingRequiredInputs(selected?.inputs, inputs)}>Generate</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
