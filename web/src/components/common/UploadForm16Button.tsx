import { useState } from "react";
import { Upload } from "lucide-react";
import { upload } from "@/api";
import { usePermission } from "@/lib/perm";
import type { DocumentResource } from "@/types";
import { currentFy, fyOptions, fySpan } from "@/lib/fy";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Field } from "@/components/common/Field";
import { FileDropField } from "@/components/common/FileDropField";
import { WriteDialog } from "@/components/common/WriteDialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";

const isPdf = (f: File) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);

/** Upload the OFFICIAL TRACES Form 16 PDF for an employee + financial year. Filed as their personal document
 *  with official=true, so it takes precedence over the HRMS-generated Part-B copy. Gated to HR + super (server
 *  enforces personal-documents.uploadForm16); renders nothing for anyone else. */
export function UploadForm16Button({ employeeId, onUploaded }: { employeeId: string; onUploaded?: () => void }) {
  const canUpload = usePermission("personal-documents.write");
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [fy, setFy] = useState(currentFy());
  const [file, setFile] = useState<File | null>(null);

  if (!canUpload) return null;

  async function submit() {
    if (!file) return;
    const doc = await upload<DocumentResource>("personal-documents", file, {
      verb: "uploadForm16",
      params: { employee: `employees/${employeeId}`, financial_year: fy },
    });
    toast({ title: "Official Form 16 uploaded", description: doc.display_name, variant: "success" });
    setFile(null);
    onUploaded?.();
  }

  const wrongType = !!file && !isPdf(file);

  return (
    <>
      <AccessAction collection="personal-documents" verb="uploadForm16" label="Upload official Form 16">
        <Button variant="outline" size="sm" onClick={() => { setFy(currentFy()); setFile(null); setOpen(true); }}>
          <Upload className="h-4 w-4" /> Upload official Form 16
        </Button>
      </AccessAction>
      <WriteDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Upload official Form 16"
        description="The TRACES-issued Form 16. It takes precedence over the generated Part-B copy for that year, which is what the employee then sees."
        collection="personal-documents"
        guardLabel="Form 16"
        form={{ fy, file: file ? `${file.name}:${file.size}` : null }}
        submitLabel="Upload"
        canSubmit={!!file && !wrongType}
        whyNot={!file ? "Attach the Form 16 PDF." : "Form 16 must be a PDF."}
        onSubmit={submit}
      >
        <Field label="Financial year" hint={`${fySpan(fy)}.`}>
          <Select value={fy} onValueChange={setFy}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{fyOptions().map((y) => <SelectItem key={y} value={y}>FY {y}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="File" error={wrongType ? "Form 16 must be a PDF." : undefined} eager>
          <FileDropField file={file} onFile={setFile} accept="application/pdf,.pdf" hint="PDF only, as issued by TRACES." />
        </Field>
      </WriteDialog>
    </>
  );
}
