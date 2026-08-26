import * as React from "react";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SignBox } from "@/types";
import { openPdf } from "@/lib/pdfjs";

// Fixed-size signature box, in PDF points (bottom-left origin). HR only chooses the position (by clicking)
// and page; the box size is constant, so there is no drag/resize.
const BOX_W = 180;
const BOX_H = 54;

// Visual signature-placement: renders the PDF (pdf.js, lazy-loaded), and on click drops a fixed-size box at
// that point on the current page. Emits the box in PDF points (bottom-left origin, 1-based page) so it matches
// the stored anchor + pdf-lib + Cashfree. pdf.js and its worker are dynamically imported so they never touch
// the main bundle, and the worker resolves to a same-origin asset URL (CSP: worker-src falls back to
// script-src 'self').
export function PdfSignaturePlacer({ src, value, onChange }: { src: File | Blob | string; value: SignBox | null; onChange: (b: SignBox) => void }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [doc, setDoc] = React.useState<any>(null);
  const [numPages, setNumPages] = React.useState(0);
  const [page, setPage] = React.useState(value?.page ?? 1);
  const [viewport, setViewport] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // Load the document once (pdf.js lazy).
  React.useEffect(() => {
    let cancelled = false;
    let loaded: any = null;
    (async () => {
      try {
        setLoading(true);
        loaded = await openPdf(typeof src === "string" ? src : new Uint8Array(await src.arrayBuffer()));
        if (cancelled) { loaded.destroy?.(); return; }
        setDoc(loaded);
        setNumPages(loaded.numPages);
        setError(null);
      } catch (e) {
        if (!cancelled) setError((e as Error).message || "couldn't render the PDF");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; loaded?.destroy?.(); };
  }, [src]);

  // Render the current page to the canvas, fit to the container width.
  React.useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    (async () => {
      const p = await doc.getPage(page);
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      // Measure the scroll container (the inline-block canvas wrapper shrink-wraps the canvas, so it can't
      // drive the fit width). Subtract a little for the scrollbar/padding.
      const containerW = (canvas.parentElement?.parentElement?.clientWidth ?? 600) - 8;
      const base = p.getViewport({ scale: 1 });
      const scale = Math.min(containerW / base.width, 2);
      const vp = p.getViewport({ scale });
      canvas.width = vp.width;
      canvas.height = vp.height;
      const ctx = canvas.getContext("2d")!;
      await p.render({ canvasContext: ctx, viewport: vp }).promise;
      if (!cancelled) setViewport(vp);
    })();
    return () => { cancelled = true; };
  }, [doc, page]);

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    const canvas = canvasRef.current;
    if (!canvas || !viewport) return;
    const rect = canvas.getBoundingClientRect();
    // CSS px -> canvas px (canvas may be displayed at a different width than its backing store).
    const cx = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const cy = ((e.clientY - rect.top) / rect.height) * canvas.height;
    const [px, py] = viewport.convertToPdfPoint(cx, cy) as [number, number]; // -> PDF points, bottom-left origin
    // Center the fixed box on the click; clamp within the page.
    const pageBase = viewport.viewBox as number[]; // [x0,y0,x1,y1] in PDF points
    const pw = pageBase[2]! - pageBase[0]!;
    const ph = pageBase[3]! - pageBase[1]!;
    const midX = Math.min(Math.max(px, BOX_W / 2), pw - BOX_W / 2);
    const midY = Math.min(Math.max(py, BOX_H / 2), ph - BOX_H / 2);
    onChange({ page, x1: midX - BOX_W / 2, y1: midY + BOX_H / 2, x2: midX + BOX_W / 2, y2: midY - BOX_H / 2 });
  }

  // The placed box, converted back to canvas CSS px for display (only on its page).
  const overlay = React.useMemo(() => {
    if (!viewport || !value || value.page !== page) return null;
    const [tlx, tly] = viewport.convertToViewportPoint(Math.min(value.x1, value.x2), Math.max(value.y1, value.y2)) as [number, number];
    const [brx, bry] = viewport.convertToViewportPoint(Math.max(value.x1, value.x2), Math.min(value.y1, value.y2)) as [number, number];
    const canvas = canvasRef.current;
    const ratio = canvas ? canvas.getBoundingClientRect().width / canvas.width : 1;
    return { left: tlx * ratio, top: tly * ratio, width: (brx - tlx) * ratio, height: (bry - tly) * ratio };
  }, [viewport, value, page]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{value && value.page === page ? "Signature placed here" : "Click on the page to place the signature box"}</span>
        {numPages > 1 && (
          <div className="flex items-center gap-1">
            <Button type="button" variant="outline" size="icon" aria-label="Previous page" className="h-7 w-7" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}><ChevronLeft className="h-4 w-4" /></Button>
            <span className="tabular-nums">{page} / {numPages}</span>
            <Button type="button" variant="outline" size="icon" aria-label="Next page" className="h-7 w-7" disabled={page >= numPages} onClick={() => setPage((p) => Math.min(numPages, p + 1))}><ChevronRight className="h-4 w-4" /></Button>
          </div>
        )}
      </div>
      <div className="relative min-h-0 flex-1 overflow-auto rounded-md border bg-muted/30">
        {loading && <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Rendering…</div>}
        {error && <div className="p-6 text-sm text-destructive">Couldn't render the PDF: {error}</div>}
        <div className="relative inline-block cursor-crosshair" onClick={handleClick}>
          <canvas ref={canvasRef} className="block max-w-full" />
          {overlay && (
            <div className="pointer-events-none absolute border-2 border-primary bg-primary/15" style={{ left: overlay.left, top: overlay.top, width: overlay.width, height: overlay.height }} />
          )}
        </div>
      </div>
    </div>
  );
}
