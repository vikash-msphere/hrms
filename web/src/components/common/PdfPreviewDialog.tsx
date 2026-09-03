import { useEffect, useRef, useState } from "react";
import { ChevronDown, Download, Loader2, Monitor, Printer } from "lucide-react";
import { blobUrl, download as downloadFile } from "@/api";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  // This document is rendered on a letterhead that may have a print page of its own, so the viewer offers a
  // Screen/Print switch. It re-fetches with `?variant=print`, which the render verb understands.
  hasPrintVariant?: boolean;
};

/** Inline PDF viewer: fetches the bytes for `source` through the normal authorized API path, shows them in an
 *  iframe, and revokes the object URL on close (nothing is cached and no file touches the disk unless the
 *  viewer's Save button is used). Open/closed is driven by `source` being set - pass null to close.
 *  Server-side authz still decides every fetch; this component only renders what the caller was allowed. */
export function PdfPreviewDialog({ source, onClose }: { source: PdfSource | null; onClose: () => void }) {
  const { toast } = useToast();
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Which of the letterhead's two pages this is showing. Reset per document, so opening the next one starts on
  // screen rather than inheriting the last reader's choice.
  const [variant, setVariant] = useState<"screen" | "print">("screen");
  const [saving, setSaving] = useState<"screen" | "print" | null>(null); // fetching the version that is not on screen
  useEffect(() => setVariant("screen"), [source?.path, source?.verb]);

  // The object URL must OUTLIVE the effect that made it: this re-runs when the reader switches Screen/Print,
  // and revoking in cleanup would pull the file out from under the iframe still showing it. The previous URL
  // is revoked once its replacement has arrived; the last one when the dialog closes.
  const current = useRef<string | null>(null);
  useEffect(() => {
    if (!source) return;
    let live = true;
    setLoading(true);
    blobUrl(source.path, {
      verb: source.verb,
      body: source.body,
      params: { ...source.params, ...(variant === "print" ? { variant: "print" } : {}) },
    })
      .then((u) => {
        if (!live) { URL.revokeObjectURL(u); return; } // closed while in flight
        const old = current.current;
        current.current = u;
        setUrl(u);
        if (old) URL.revokeObjectURL(old);
      })
      .catch((e: Error) => {
        if (live) {
          toast({ title: "Couldn't render the preview", description: e.message, variant: "destructive" });
          onClose();
        }
      })
      .finally(() => live && setLoading(false));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch when the source, or the page it is on, changes
  }, [source, variant]);

  // Closed: drop the last one and clear the frame, so reopening never flashes the previous document.
  useEffect(() => {
    if (source) return;
    if (current.current) URL.revokeObjectURL(current.current);
    current.current = null;
    setUrl(null);
  }, [source]);

  const nameFor = (v: "screen" | "print") =>
    v === "print" && source ? source.fileName.replace(/\.pdf$/i, "") + " (print).pdf" : (source?.fileName ?? "document.pdf");

  /**
   * Save one of the versions - not necessarily the one on screen. Saving what is displayed is free (the bytes
   * are already here); saving the other one fetches it, so choosing a version to keep never means switching
   * the view first and waiting for it to redraw.
   */
  async function save(v: "screen" | "print") {
    if (!source) return;
    const saveFrom = (href: string) => {
      const a = document.createElement("a");
      a.href = href;
      a.download = nameFor(v);
      document.body.appendChild(a);
      a.click();
      a.remove();
    };
    if (v === variant) {
      if (url) saveFrom(url);
      return;
    }
    setSaving(v);
    try {
      await downloadFile(source.path, nameFor(v), {
        verb: source.verb,
        body: source.body,
        params: { ...source.params, ...(v === "print" ? { variant: "print" } : {}) },
      });
    } catch (e) {
      toast({ title: "Couldn't save that version", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(null);
    }
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
        <DialogFooter className="sm:items-center sm:justify-between">
          {/* The letterhead's print page, when it has one: the same document without the flooded background,
              or with the header band off where the paper is already pre-printed. */}
          {source?.hasPrintVariant ? (
            <Tabs value={variant} onValueChange={(v) => setVariant(v as "screen" | "print")}>
              <TabsList variant="segmented">
                <TabsTrigger value="screen"><Monitor className="h-4 w-4" /> Screen</TabsTrigger>
                <TabsTrigger value="print"><Printer className="h-4 w-4" /> Print</TabsTrigger>
              </TabsList>
            </Tabs>
          ) : (
            <span />
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
            <Button variant="outline" onClick={onClose}>Close</Button>
            {/* One version: a plain Save. Two: the same button offers both, without making the reader switch
                the view first - the same shape the download control has everywhere else. */}
            {source?.allowSave !== false &&
              (source?.hasPrintVariant ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button disabled={!url || !!saving} className="gap-1">
                      {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Save
                      <ChevronDown className="h-3.5 w-3.5 opacity-70" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => void save("screen")}>
                      <Monitor className="h-4 w-4" /> Screen version
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void save("print")}>
                      <Printer className="h-4 w-4" /> Print version
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <Button onClick={() => void save("screen")} disabled={!url}>
                  <Download className="h-4 w-4" /> Save PDF
                </Button>
              ))}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
