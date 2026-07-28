import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { upload } from "@/api";
import { usePermission } from "@/lib/perm";
import type { DocumentResource } from "@/types";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Field } from "@/components/common/Field";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

// Indian FY label (Apr–Mar) - defaults the dialog to the current financial year.
function currentFy(): string {
  const d = new Date();
  const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
}

/** Upload the OFFICIAL TRACES Form 16 PDF for an employee + financial year. Filed as their personal document
 *  with official=true, so it takes precedence over the HRMS-generated Part-B copy. Gated to HR + super (server
 *  enforces personal-documents.uploadForm16); renders nothing for anyone else. */
export function UploadForm16Button({ employeeId, onUploaded }: { employeeId: string; onUploaded?: () => void }) {
  const canUpload = usePermission("personal-documents.write");
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [fy, setFy] = useState(currentFy());
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!canUpload) return null;

  async function submit() {
    if (!file) return;
    setBusy(true);
    try {
      const doc = await upload<DocumentResource>("personal-documents", file, {
        verb: "uploadForm16",
        params: { employee: `employees/${employeeId}`, financial_year: fy.trim() },
      });
      toast({ title: "Official Form 16 uploaded", description: doc.display_name, variant: "success" });
      setOpen(false);
      setFile(null);
      onUploaded?.();
    } catch (e) {
      toast({ title: "Couldn't upload Form 16", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const fyValid = /^\d{4}-\d{2}$/.test(fy.trim());

  return (
    <>
      <AccessAction collection="personal-documents" verb="uploadForm16" label="Upload official Form 16">
        <Button variant="outline" size="sm" onClick={() => { setFy(currentFy()); setFile(null); setOpen(true); }}>
          <Upload className="h-4 w-4" /> Upload official Form 16
        </Button>
      </AccessAction>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Upload official Form 16</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">The official TRACES-issued Form 16 (PDF). It replaces the generated copy for the year.</p>
          <Field label="Financial year" hint="Apr–Mar, e.g. 2025-26."><Input value={fy} onChange={(e) => setFy(e.target.value)} placeholder="2025-26" /></Field>
          <Field label="File" hint="PDF only.">
            <Input ref={fileRef} type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} loading={busy} disabled={!fyValid || !file}>Upload</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
