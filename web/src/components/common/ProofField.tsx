import * as React from "react";
import { Download, FileCheck2, Loader2, Unlink } from "lucide-react";
import { download, upload } from "@/api";
import { createDocument } from "@/lib/documents";
import { Field } from "@/components/common/Field";
import { FileDropField } from "@/components/common/FileDropField";
import { AccessAction } from "@/components/access/AccessAction";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";

/**
 * File a proof document and return its resource path.
 *
 * A challan number proves nothing on its own and a note is not a vendor's report, so records that assert
 * something happened (a statutory filing, a verification outcome) need to be able to hold the paper. It goes on
 * the document shelf rather than into a second file store: the shelf already owns access, audit, expiry and the
 * download endpoint - the record just keeps a link.
 */
export async function fileProof(opts: { file: File; title: string; employee?: string | null; documentType?: string }): Promise<string> {
  const doc = await createDocument({
    display_name: opts.title,
    document_type: opts.documentType ?? "OTHER",
    employee: opts.employee ?? null,
    expire_time: null,
  });
  await upload(doc.path, opts.file);
  return doc.path;
}

/**
 * The form half: either the proof already linked (with a way to read it, and a way to unlink it) or a drop
 * target for the file to attach on save. The parent owns both the staged `file` and the saved `documentPath`,
 * so the upload happens inside its own submit - one write, one failure path.
 */
export function ProofField({
  label,
  hint,
  collection,
  documentPath,
  fileName,
  file,
  onFile,
  onUnlink,
  accept,
  dropHint,
}: {
  label: string;
  hint?: string;
  /** Where the proof will be filed - the shelf whose create/upload grant this control actually needs. */
  collection: "org-documents" | "personal-documents";
  /** The already-linked proof, if any (`org-documents/<id>` or `personal-documents/<id>`). */
  documentPath?: string | null;
  /** What to call the file when it is downloaded. */
  fileName: string;
  file: File | null;
  onFile: (f: File | null) => void;
  onUnlink: () => void;
  accept?: string;
  dropHint?: string;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = React.useState(false);

  async function open() {
    if (!documentPath) return;
    setBusy(true);
    try {
      await download(documentPath, fileName);
    } catch (e) {
      toast({ title: "Couldn't open the proof", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Field label={label} hint={documentPath ? "Unlinking leaves the file on the document shelf." : hint}>
      {documentPath ? (
        <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-background">
            <FileCheck2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          </div>
          <p className="min-w-0 flex-1 truncate text-sm font-medium">Proof on file</p>
          <Button type="button" variant="ghost" size="sm" className="h-8 shrink-0 text-xs" onClick={open} disabled={busy}>
            {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-1 h-3.5 w-3.5" />} Open
          </Button>
          <Button type="button" variant="ghost" size="sm" className="h-8 shrink-0 text-xs" onClick={onUnlink}>
            <Unlink className="mr-1 h-3.5 w-3.5" /> Unlink
          </Button>
        </div>
      ) : (
        // The write this control performs lands on the document shelf, not on the record being edited, so the
        // affordance it carries is the shelf's create gate - the grant that actually decides whether attaching
        // a proof works at all.
        <AccessAction collection={collection} create label={label}>
          <FileDropField file={file} onFile={onFile} accept={accept} hint={dropHint} />
        </AccessAction>
      )}
    </Field>
  );
}
