import { useState } from "react";
import { FileText } from "lucide-react";
import { api, download } from "@/api";
import { usePermission } from "@/lib/perm";
import type { DocumentResource } from "@/types";
import { documentFileName } from "@/lib/documents";
import { currentFy, fyOptions, fySpan } from "@/lib/fy";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Field } from "@/components/common/Field";
import { WriteDialog } from "@/components/common/WriteDialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";

/** Generate an employee's Form 16 (Part B) for a financial year and file it as their personal document. Gated
 *  to HR + super (server enforces personal-documents.generateForm16); renders nothing for anyone else. */
export function GenerateForm16Button({ employeeId, onGenerated }: { employeeId: string; onGenerated?: () => void }) {
  const canGenerate = usePermission("personal-documents.write");
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  // A year label is a format, not a free-text field: "2025-26" is right, "FY25" and "2025-2026" are rejected
  // by the server. Picking from the years that exist removes the whole class of mistake.
  const [fy, setFy] = useState(currentFy());

  if (!canGenerate) return null;

  async function generate() {
    const doc = await api<DocumentResource>("/personal-documents:generateForm16", {
      method: "POST",
      body: JSON.stringify({ employee: `employees/${employeeId}`, financial_year: fy }),
    });
    toast({ title: "Form 16 generated", description: doc.display_name, variant: "success" });
    onGenerated?.();
    try { await download(doc.path, documentFileName({ ...doc, content_type: doc.content_type ?? "application/pdf" })); } catch { /* filed under the employee's documents */ }
  }

  const incomplete = fy === currentFy();

  return (
    <>
      <AccessAction collection="personal-documents" verb="generateForm16" label="Generate Form 16">
        <Button variant="outline" size="sm" onClick={() => { setFy(currentFy()); setOpen(true); }}>
          <FileText className="h-4 w-4" /> Generate Form 16
        </Button>
      </AccessAction>
      <WriteDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Generate Form 16 (Part B)"
        description="Built from the year's finalized payroll and income-tax computation, then filed under the employee's documents and downloaded now."
        collection="personal-documents"
        guardLabel="Form 16"
        form={{ fy }}
        submitLabel="Generate"
        onSubmit={generate}
      >
        <Field label="Financial year" hint={`${fySpan(fy)}.${incomplete ? " This year is still running - the figures cover the runs finalized so far." : ""}`}>
          <Select value={fy} onValueChange={setFy}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{fyOptions().map((y) => <SelectItem key={y} value={y}>FY {y}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
      </WriteDialog>
    </>
  );
}
