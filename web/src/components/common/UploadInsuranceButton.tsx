import { useState } from "react";
import { ShieldPlus } from "lucide-react";
import { upload } from "@/api";
import { createDocument } from "@/lib/documents";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AccessAction } from "@/components/access/AccessAction";
import { Field } from "@/components/common/Field";
import { FileDropField } from "@/components/common/FileDropField";
import { WriteDialog } from "@/components/common/WriteDialog";
import { useToast } from "@/components/ui/use-toast";

/** File the health-insurance e-card: a personal document typed INSURANCE, which is what the question "are
 *  they covered?" actually needs. It lives on the Documents tab beside the other document actions rather than
 *  on the Emergency card, because filing a document is a documents act - it is gated by
 *  `personal-documents` write for this person, not by whoever may edit the emergency contact, and the card it
 *  files is then listed and downloaded with every other document of theirs. The caller decides whether to
 *  render it (EmployeeProfile passes the subject-scoped write grant). */
export function UploadInsuranceButton({ employeeId, onUploaded }: { employeeId: string; onUploaded?: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");

  // The file's own name, minus its extension: what the document is called unless the reader says otherwise.
  const derived = file ? file.name.replace(/\.[^.]+$/, "") : "";

  async function submit() {
    if (!file) return;
    const doc = await createDocument({
      employee: `employees/${employeeId}`,
      document_type: "INSURANCE",
      display_name: name.trim() || derived || "Health insurance card",
    });
    await upload(doc.path, file);
    toast({ title: "Insurance card uploaded", description: doc.display_name, variant: "success" });
    setFile(null);
    setName("");
    onUploaded?.();
  }

  return (
    <>
      <AccessAction collection="personal-documents" create label="File an insurance card">
        <Button variant="outline" size="sm" onClick={() => { setFile(null); setName(""); setOpen(true); }}>
          <ShieldPlus className="h-4 w-4" /> Upload insurance card
        </Button>
      </AccessAction>
      <WriteDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Upload insurance card"
        description="The health-insurance e-card, filed with their documents. A PDF or a photo of the card is enough - it is read in a hurry, by somebody who is not them."
        collection="personal-documents"
        guardLabel="insurance card"
        form={{ name, file: file ? `${file.name}:${file.size}` : null }}
        submitLabel="Upload"
        canSubmit={!!file}
        whyNot="Attach the card."
        onSubmit={submit}
      >
        <Field label="File">
          <FileDropField file={file} onFile={setFile} accept="application/pdf,.pdf,image/*" hint="PDF or an image of the card." />
        </Field>
        <Field label="Name" hint="What it is called in their documents.">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={derived || "Health insurance card"} />
        </Field>
      </WriteDialog>
    </>
  );
}
