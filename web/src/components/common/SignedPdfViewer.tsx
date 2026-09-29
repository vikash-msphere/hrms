import * as React from "react";
import { ChevronLeft, ChevronRight, Loader2, CheckCircle2, XCircle, HelpCircle, ShieldQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/utils";
import { verifyPdfSignatures, type SignatureResult, type SignatureValidity } from "@/lib/pdfSignature";
import { openPdf } from "@/lib/pdfjs";

// In-app PDF viewer that draws the digital-signature validity stamp (green tick / red cross / amber ?) as a
// DOM overlay over the signature widget - exactly what Adobe/eMudhra viewers do, but client-side. The PDF
// bytes are never modified: verification runs in the browser (see lib/pdfSignature) and the stamp is DOM, not
// drawn into the file. Signature widget positions come from pdf.js getAnnotations(); results are correlated to
// widgets in document order (the common single-signer case is exact; see note on multi-signer below).

type SigWidget = { page: number; rect: [number, number, number, number] }; // rect in PDF points, bottom-left origin

const STYLE: Record<SignatureValidity, { label: string; icon: typeof CheckCircle2; cls: string; border: string; bg: string }> = {
  valid: { label: "Signature valid", icon: CheckCircle2, cls: "text-emerald-600 dark:text-emerald-400", border: "border-emerald-500/70", bg: "bg-emerald-50/90 dark:bg-emerald-950/70" },
  invalid: { label: "Signature invalid", icon: XCircle, cls: "text-red-600 dark:text-red-400", border: "border-red-500/70", bg: "bg-red-50/90 dark:bg-red-950/70" },
  unknown: { label: "Validity unknown", icon: HelpCircle, cls: "text-amber-600 dark:text-amber-500", border: "border-amber-500/70", bg: "bg-amber-50/90 dark:bg-amber-950/70" },
};

// The stamp content, shared by the positioned overlay and the unpositioned (invisible-signature) chip.
function StampCard({ r, compact }: { r: SignatureResult; compact?: boolean }) {
  const s = STYLE[r.validity];
  const Icon = s.icon;
  return (
    <div className={`pointer-events-none flex items-start gap-2 rounded-md border ${s.border} ${s.bg} px-2 py-1.5 shadow-sm backdrop-blur-[1px]`}>
      <Icon className={`${compact ? "h-6 w-6" : "h-8 w-8"} shrink-0 ${s.cls}`} strokeWidth={2.25} />
      <div className="min-w-0 leading-tight">
        <p className={`text-[11px] font-semibold ${s.cls}`}>{s.label}</p>
        {/* WHY it is not a plain valid - "content was appended after signing" is the one a reader has to be
            able to act on, and a coloured icon on its own does not say it. Kept on the compact chip too:
            an invisible signature that fails coverage is exactly as serious as a visible one that does. */}
        {r.note && <p className={`text-[10px] ${s.cls}`}>{r.note}</p>}
        {r.signerName && <p className="truncate text-[10px] text-foreground/80">Digitally signed by {r.signerName}</p>}
        {r.signingTime && <p className="text-[10px] text-muted-foreground">Date: {formatDateTime(r.signingTime)}</p>}
        {!compact && r.reason && <p className="truncate text-[10px] text-muted-foreground">Reason: {r.reason}</p>}
        {!compact && r.location && <p className="truncate text-[10px] text-muted-foreground">Location: {r.location}</p>}
      </div>
    </div>
  );
}

export function SignedPdfViewer({ bytes }: { bytes: Uint8Array }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [doc, setDoc] = React.useState<any>(null);
  const [numPages, setNumPages] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [viewport, setViewport] = React.useState<any>(null);
  const [results, setResults] = React.useState<SignatureResult[]>([]);
  const [widgets, setWidgets] = React.useState<SigWidget[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // Load the document + verify signatures + collect signature-widget positions (all once, on the bytes).
  React.useEffect(() => {
    let cancelled = false;
    let loaded: any = null;
    void (async () => {
      try {
        setLoading(true);
        // pdf.js transfers/detaches the buffer it renders; verify on a copy so both see intact bytes.
        loaded = await openPdf(bytes.slice());
        if (cancelled) { loaded.destroy?.(); return; }
        setDoc(loaded);
        setNumPages(loaded.numPages);

        const sigs = await verifyPdfSignatures(bytes.slice());
        const found: SigWidget[] = [];
        for (let p = 1; p <= loaded.numPages; p++) {
          const pg = await loaded.getPage(p);
          const annots = await pg.getAnnotations();
          for (const a of annots) {
            if (a.fieldType === "Sig" && Array.isArray(a.rect) && (a.rect[2] - a.rect[0]) > 1 && (a.rect[3] - a.rect[1]) > 1) {
              found.push({ page: p, rect: [a.rect[0], a.rect[1], a.rect[2], a.rect[3]] });
            }
          }
        }
        if (cancelled) return;
        setResults(sigs);
        setWidgets(found);
        setError(null);
      } catch (e) {
        if (!cancelled) setError((e as Error).message || "couldn't render the PDF");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; loaded?.destroy?.(); };
  }, [bytes]);

  // Render the current page, fit to width.
  React.useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    void (async () => {
      const p = await doc.getPage(page);
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const containerW = (canvas.parentElement?.parentElement?.clientWidth ?? 700) - 8;
      const base = p.getViewport({ scale: 1 });
      const scale = Math.min(containerW / base.width, 2);
      const vp = p.getViewport({ scale });
      canvas.width = vp.width;
      canvas.height = vp.height;
      await p.render({ canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;
      if (!cancelled) setViewport(vp);
    })();
    return () => { cancelled = true; };
  }, [doc, page]);

  // Positioned stamps for the current page: correlate result[i] <-> widget[i] (document order).
  const overlays = React.useMemo(() => {
    if (!viewport) return [];
    const canvas = canvasRef.current;
    const ratio = canvas ? canvas.getBoundingClientRect().width / canvas.width : 1;
    const out: { key: number; r: SignatureResult; left: number; top: number; width: number }[] = [];
    results.forEach((r, i) => {
      const w = widgets[i];
      if (!w || w.page !== page) return;
      const [x1, y1, x2, y2] = w.rect;
      const [tlx, tly] = viewport.convertToViewportPoint(Math.min(x1, x2), Math.max(y1, y2)) as [number, number];
      const [brx] = viewport.convertToViewportPoint(Math.max(x1, x2), Math.min(y1, y2)) as [number, number];
      out.push({ key: i, r, left: tlx * ratio, top: tly * ratio, width: Math.max(160, (brx - tlx) * ratio) });
    });
    return out;
  }, [viewport, results, widgets, page]);

  // Signatures with no visible widget (invisible signatures) - shown as chips in the toolbar instead.
  const unpositioned = results.filter((_, i) => !widgets[i]);
  const overall: SignatureValidity | null =
    results.length === 0 ? null
    : results.some((r) => r.validity === "invalid") ? "invalid"
    : results.every((r) => r.validity === "valid") ? "valid"
    : "unknown";

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <div className="flex items-center gap-2">
          {overall === null ? (
            <span className="flex items-center gap-1.5 text-muted-foreground"><ShieldQuestion className="h-4 w-4" /> No digital signature found</span>
          ) : (
            (() => { const s = STYLE[overall]; const I = s.icon; return <span className={`flex items-center gap-1.5 font-medium ${s.cls}`}><I className="h-4 w-4" /> {s.label}</span>; })()
          )}
          {unpositioned.map((r, i) => <div key={`u${i}`} className="max-w-[240px]"><StampCard r={r} compact /></div>)}
        </div>
        {numPages > 1 && (
          <div className="flex items-center gap-1">
            <Button type="button" variant="outline" size="icon" aria-label="Previous page" className="h-7 w-7" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}><ChevronLeft className="h-4 w-4" /></Button>
            <span className="tabular-nums">{page} / {numPages}</span>
            <Button type="button" variant="outline" size="icon" aria-label="Next page" className="h-7 w-7" disabled={page >= numPages} onClick={() => setPage((p) => Math.min(numPages, p + 1))}><ChevronRight className="h-4 w-4" /></Button>
          </div>
        )}
      </div>
      <div className="relative min-h-0 flex-1 overflow-auto rounded-md border bg-muted/30">
        {loading && <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Verifying signature…</div>}
        {error && <div className="p-6 text-sm text-destructive">Couldn't render the PDF: {error}</div>}
        <div className="relative inline-block">
          <canvas ref={canvasRef} className="block max-w-full" />
          {overlays.map((o) => (
            <div key={o.key} className="absolute" style={{ left: o.left, top: o.top, width: o.width }}>
              <StampCard r={o.r} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
