import { useState } from "react";
import { Sparkles } from "lucide-react";
import { usePermission } from "@/lib/perm";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { GenerateLetterDialog } from "@/components/common/GenerateLetterDialog";

/** Generate an HR letter for a fixed employee and file it as their personal document. Gated to HR + super
 *  (the server enforces personal-documents.generateLetter); renders nothing for anyone else. The dialog itself
 *  is the shared one the Documents page opens, so this entry point gets the preview and the e-signature
 *  choice too. */
export function GenerateLetterButton({ employeeId, onGenerated }: { employeeId: string; onGenerated?: () => void }) {
  const canGenerate = usePermission("personal-documents.write");
  const [open, setOpen] = useState(false);

  if (!canGenerate) return null;

  return (
    <>
      <AccessAction collection="personal-documents" verb="generateLetter" label="Generate letter">
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <Sparkles className="h-4 w-4" /> Generate letter
        </Button>
      </AccessAction>
      <GenerateLetterDialog open={open} onClose={() => setOpen(false)} employee={`employees/${employeeId}`} onGenerated={onGenerated} />
    </>
  );
}
