import { useState } from "react";
import { FileText } from "lucide-react";
import { api, download } from "@/api";
import { usePermission } from "@/lib/perm";
import type { DocumentResource } from "@/types";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Field } from "@/components/common/Field";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

// Indian FY label (Apr–Mar) for `asOf` - defaults the dialog to the current financial year.
function currentFy(): string {
  const d = new Date();
  const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
}

/** Generate an employee's Form 16 (Part B) for a financial year and file it as their personal document. Gated
 *  to HR + super (server enforces personal-documents.generateForm16); renders nothing for anyone else. */
export function GenerateForm16Button({ employeeId, onGenerated }: { employeeId: string; onGenerated?: () => void }) {
  const canGenerate = usePermission("personal-documents.write");
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [fy, setFy] = useState(currentFy());
  const [busy, setBusy] = useState(false);

  if (!canGenerate) return null;

  async function generate() {
    setBusy(true);
    try {
      const doc = await api<DocumentResource>("/personal-documents:generateForm16", {
        method: "POST",
        body: JSON.stringify({ employee: `employees/${employeeId}`, financial_year: fy.trim() || undefined }),
      });
      toast({ title: "Form 16 generated", description: doc.display_name, variant: "success" });
      setOpen(false);
      onGenerated?.();
      try { await download(doc.path, doc.file_name || `${doc.display_name}.pdf`); } catch { /* filed under the employee's documents */ }
    } catch (e) {
      toast({ title: "Couldn't generate Form 16", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <AccessAction collection="personal-documents" verb="generateForm16" label="Generate Form 16">
        <Button variant="outline" size="sm" onClick={() => { setFy(currentFy()); setOpen(true); }}>
          <FileText className="h-4 w-4" /> Generate Form 16
        </Button>
      </AccessAction>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Generate Form 16 (Part B)</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">Built from the year's finalized payroll and income-tax computation.</p>
          <Field label="Financial year" hint="Apr–Mar, e.g. 2025-26."><Input value={fy} onChange={(e) => setFy(e.target.value)} placeholder="2025-26" /></Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={generate} loading={busy} disabled={!/^\d{4}-\d{2}$/.test(fy.trim())}>Generate</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
