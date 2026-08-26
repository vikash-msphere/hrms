import { useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { blobUrl } from "@/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

/** What to render: the resource path + custom method that returns the PDF bytes, plus how to label the viewer.
 *  `fileName` also names the file if the viewer's Save button is used. */
export type PdfSource = {
  path: string; // e.g. "payroll-runs/abc" or "payslips/xyz"
  verb: string; // the binary custom method, e.g. "previewPayslip" / "preview"
  body?: Record<string, unknown>;
  params?: Record<string, string>;
  title: string;
  description?: string;
  fileName: string;
  // Offer the Save button? Set false when the caller may view but not download (viewing and keeping a copy are
  // separate grants). This is an honesty-of-affordance thing, not a control: bytes already in the browser can
  // always be saved by other means. The download grant is what gets enforced (and audited) server-side.
  allowSave?: boolean;
};

/** Inline PDF viewer: fetches the bytes for `source` through the normal authorized API path, shows them in an
 *  iframe, and revokes the object URL on close (nothing is cached and no file touches the disk unless the
 *  viewer's Save button is used). Open/closed is driven by `source` being set - pass null to close.
 *  Server-side authz still decides every fetch; this component only renders what the caller was allowed. */
export function PdfPreviewDialog({ source, onClose }: { source: PdfSource | null; onClose: () => void }) {
  const { toast } = useToast();
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!source) return;
    let live = true;
    let objectUrl: string | null = null;
    setLoading(true);
    blobUrl(source.path, { verb: source.verb, body: source.body, params: source.params })
      .then((u) => {
        objectUrl = u;
        if (live) setUrl(u);
        else URL.revokeObjectURL(u); // closed while in flight
      })
      .catch((e: Error) => {
        if (live) {
          toast({ title: "Couldn't render the preview", description: e.message, variant: "destructive" });
          onClose();
        }
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
      setUrl(null);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch only when the source itself changes
  }, [source]);

  function save() {
    if (!url || !source) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = source.fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  return (
    <Dialog open={!!source} onOpenChange={(o) => !o && onClose()}>
      {/* Height ceiling from `sm` up; a phone keeps the shared sheet height (see ui/dialog.tsx). */}
      <DialogContent className="flex max-w-3xl flex-col overflow-hidden sm:max-h-[92vh] lg:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{source?.title}</DialogTitle>
          {source?.description && <DialogDescription>{source.description}</DialogDescription>}
        </DialogHeader>
        {loading || !url ? (
          <p className="flex items-center justify-center gap-2 py-24 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Rendering…
          </p>
        ) : (
          <iframe title={source?.title ?? "PDF preview"} src={url} className="h-[70dvh] w-full rounded-md border bg-muted/30" />
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
          {source?.allowSave !== false && <Button onClick={save} disabled={!url}><Download className="h-4 w-4" /> Save PDF</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
