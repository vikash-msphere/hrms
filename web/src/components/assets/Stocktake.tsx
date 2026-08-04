import { useEffect, useMemo, useRef, useState } from "react";
import { ScanLine, X, Camera, CameraOff, CheckCircle2, CircleDashed, Keyboard, ImageUp } from "lucide-react";
import { patch } from "@/api";
import { cn, idOf, formatDate } from "@/lib/utils";
import type { Asset } from "@/types";
import { parseScanPayload } from "@/lib/assetTags";
import { exportTable } from "@/lib/exportTable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";

// Stocktake: the scanning half of the tag-printing loop. Walk the office, scan each sticker (live
// camera, an uploaded photo, a USB keyboard-wedge scanner, or hand-typed tags) and every sighted
// asset gets `last_verified_time` stamped on the SERVER - a real audit trail, visible to everyone.
// What's left in the "not seen" list at the end IS the missing-assets report.
//
// Decoding: the native BarcodeDetector when the browser has it (QR + Code128), otherwise the
// bundled jsQR decoder (QR only, works in every browser) - so the camera and photo-upload paths
// never dead-end on browser support. Code128 stickers in non-detector browsers are covered by USB
// scanners / typed tags.

// BarcodeDetector is not in TS's dom lib yet.
declare global {
  interface Window {
    BarcodeDetector?: new (opts?: { formats?: string[] }) => { detect(source: CanvasImageSource): Promise<{ rawValue: string }[]> };
  }
}
type NativeDetector = InstanceType<NonNullable<Window["BarcodeDetector"]>>;

type ScanResult = { asset: Asset; at: string; ok: boolean; note?: string };

export function Stocktake({ assets, onClose, onReload }: { assets: Asset[]; onClose: () => void; onReload: () => Promise<void> | void }) {
  const { toast } = useToast();
  const [catFilter, setCatFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [manual, setManual] = useState("");
  const [scans, setScans] = useState<ScanResult[]>([]); // newest first
  const [cameraState, setCameraState] = useState<"off" | "starting" | "on" | "unavailable">("off");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const detectorRef = useRef<NativeDetector | null>(null);
  const jsqrRef = useRef<typeof import("jsqr").default | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const seenRef = useRef(new Set<string>()); // asset ids verified this session
  const lastHitRef = useRef<{ raw: string; at: number }>({ raw: "", at: 0 });
  const [, bump] = useState(0); // re-render after seenRef changes

  // Decode one frame/image: native BarcodeDetector (QR + Code128) when available, bundled jsQR
  // (QR only, any browser) otherwise. Large sources are downscaled before jsQR - decoding cost is
  // quadratic in pixels and stickers are big in the frame anyway.
  async function decodeSource(src: HTMLVideoElement | ImageBitmap): Promise<string | null> {
    if (window.BarcodeDetector) {
      detectorRef.current ??= new window.BarcodeDetector({ formats: ["qr_code", "code_128"] });
      const codes = await detectorRef.current.detect(src);
      return codes[0]?.rawValue ?? null;
    }
    jsqrRef.current ??= (await import("jsqr")).default;
    const srcW = src instanceof ImageBitmap ? src.width : src.videoWidth;
    const srcH = src instanceof ImageBitmap ? src.height : src.videoHeight;
    if (!srcW || !srcH) return null;
    const cap = src instanceof ImageBitmap ? 1600 : 800;
    const scale = Math.min(1, cap / Math.max(srcW, srcH));
    const w = Math.round(srcW * scale);
    const h = Math.round(srcH * scale);
    const canvas = (canvasRef.current ??= document.createElement("canvas"));
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(src, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h);
    return jsqrRef.current(data.data, w, h)?.data ?? null;
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === "Escape" && !t?.closest("input, textarea, select")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const byId = useMemo(() => new Map(assets.map((a) => [idOf(a.path), a])), [assets]);
  const byTag = useMemo(() => {
    const m = new Map<string, Asset>();
    for (const a of assets) if (a.asset_tag) m.set(a.asset_tag.toLowerCase(), a);
    return m;
  }, [assets]);

  // The audit scope: what this walk-through is expected to sight.
  const scope = useMemo(
    () =>
      assets.filter((a) => {
        if (catFilter !== "all" && a.category !== catFilter) return false;
        if (statusFilter !== "all" && a.status !== statusFilter) return false;
        return true;
      }),
    [assets, catFilter, statusFilter],
  );
  const categories = useMemo(() => [...new Set(assets.map((a) => a.category).filter((c): c is string => !!c))].sort(), [assets]);
  const remaining = scope.filter((a) => !seenRef.current.has(idOf(a.path)));
  const seenInScope = scope.length - remaining.length;

  async function recordSighting(a: Asset) {
    const id = idOf(a.path);
    if (seenRef.current.has(id)) return; // one stamp per walk-through
    seenRef.current.add(id);
    bump((n) => n + 1);
    const now = new Date().toISOString();
    const canEdit = a.access?.can?.includes("update") ?? false;
    let ok = canEdit;
    let note = canEdit ? undefined : "sighted, but you can't edit this asset - time not recorded";
    if (canEdit) {
      try {
        await patch(a.path, { last_verified_time: now }, a.etag);
      } catch (e) {
        ok = false;
        note = `sighted, but saving failed: ${(e as Error).message}`;
      }
    }
    setScans((s) => [{ asset: a, at: now, ok, note }, ...s]);
  }

  function handleScan(raw: string): boolean {
    const parsed = parseScanPayload(raw);
    if (!parsed) return false;
    const asset = "id" in parsed ? byId.get(parsed.id) : byTag.get(parsed.tag.toLowerCase());
    if (!asset) {
      toast({ variant: "destructive", title: "No matching asset", description: raw.slice(0, 80) });
      return false;
    }
    void recordSighting(asset);
    return true;
  }

  function submitManual() {
    const t = manual.trim();
    if (!t) return;
    if (handleScan(t)) setManual("");
  }

  // --- Camera loop ---
  async function startCamera() {
    setCameraState("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraState("on");
    } catch {
      setCameraState("unavailable");
      toast({ variant: "destructive", title: "Camera unavailable", description: "Permission denied or no camera. USB scanners and typed tags still work below." });
    }
  }
  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraState("off");
  }
  useEffect(() => stopCamera, []); // release the camera on unmount

  useEffect(() => {
    if (cameraState !== "on") return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      const video = videoRef.current;
      if (video && video.readyState >= 2) {
        try {
          const raw = await decodeSource(video);
          // Debounce: the same code sits in front of the lens for many frames.
          if (raw && (raw !== lastHitRef.current.raw || Date.now() - lastHitRef.current.at > 3000)) {
            lastHitRef.current = { raw, at: Date.now() };
            handleScan(raw);
          }
        } catch {
          /* transient decode errors are normal */
        }
      }
      setTimeout(tick, 250);
    };
    void tick();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraState]);

  // --- Photo upload: decode stills (phone camera photos, screenshots) through the same pipeline. ---
  async function decodeFiles(files: FileList | null) {
    if (!files?.length) return;
    let hits = 0;
    let misses = 0;
    for (const file of Array.from(files)) {
      try {
        const bitmap = await createImageBitmap(file);
        const raw = await decodeSource(bitmap);
        bitmap.close();
        if (raw && handleScan(raw)) hits++;
        else misses++;
      } catch {
        misses++;
      }
    }
    if (misses > 0) {
      toast({
        variant: hits ? "default" : "destructive",
        title: hits ? `${hits} scanned, ${misses} unreadable` : "No code found",
        description: "Make sure the sticker is sharp and fills a good part of the photo." + (window.BarcodeDetector ? "" : " (This browser reads QR photos only, not barcodes.)"),
      });
    }
  }

  function exportMissing() {
    exportTable(
      "stocktake-missing",
      ["Tag", "Name", "Category", "Status", "Last verified"],
      remaining.map((a) => [a.asset_tag ?? "", a.name, a.category ?? "", a.status, a.last_verified_time ? formatDate(a.last_verified_time.slice(0, 10)) : "never"]),
      "csv",
    );
  }

  async function finish() {
    stopCamera();
    await onReload();
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex h-full max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border bg-background shadow-lg">
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <ScanLine className="h-5 w-5 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">Stocktake</h2>
            <p className="truncate text-xs text-muted-foreground">Scan each sticker you can physically see - sighted assets get their verified date stamped. What's left over is your missing list.</p>
          </div>
          <Button variant="outline" onClick={finish}>Finish</Button>
          <Button variant="ghost" size="sm" onClick={() => { stopCamera(); onClose(); }} aria-label="Close"><X className="h-4 w-4" /></Button>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="flex w-[340px] flex-shrink-0 flex-col gap-3 border-r p-4">
            <div>
              {cameraState === "on" ? (
                <div className="overflow-hidden rounded-md border">
                  {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                  <video ref={videoRef} className="aspect-video w-full bg-black object-cover" muted playsInline />
                </div>
              ) : (
                <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed text-xs text-muted-foreground">
                  {cameraState === "unavailable" ? <CameraOff className="h-5 w-5" /> : <Camera className="h-5 w-5" />}
                  {cameraState === "unavailable" ? "Camera unavailable - upload a photo or use the input below" : "Camera is off"}
                </div>
              )}
              <div className="mt-2 flex gap-2">
                {cameraState === "on" ? (
                  <Button size="sm" variant="outline" className="flex-1" onClick={stopCamera}><CameraOff className="h-4 w-4" /> Stop camera</Button>
                ) : (
                  <Button size="sm" variant="outline" className="flex-1" loading={cameraState === "starting"} onClick={startCamera}>
                    <Camera className="h-4 w-4" /> Start camera
                  </Button>
                )}
                <Button size="sm" variant="outline" className="flex-1" onClick={() => fileRef.current?.click()} title="Decode sticker photos (e.g. taken on a phone)">
                  <ImageUp className="h-4 w-4" /> Upload photos
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    void decodeFiles(e.target.files);
                    e.target.value = ""; // same file can be re-picked
                  }}
                />
              </div>
              {!window.BarcodeDetector && (
                <p className="mt-1 text-[11px] text-muted-foreground">This browser decodes QR stickers; Code 128 barcodes need a USB scanner or typed entry.</p>
              )}
            </div>

            <div>
              <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><Keyboard className="h-3.5 w-3.5" /> Scan or type</div>
              <div className="flex gap-2">
                <Input
                  autoFocus
                  placeholder="Tag, or scan into this field…"
                  value={manual}
                  onChange={(e) => setManual(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitManual();
                  }}
                />
                <Button size="sm" variant="outline" onClick={submitManual}>Log</Button>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">USB scanners type here and press Enter by themselves.</p>
            </div>

            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Audit scope</div>
              <div className="flex gap-2">
                <Select value={catFilter} onValueChange={setCatFilter}>
                  <SelectTrigger className="flex-1 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All categories</SelectItem>
                    {categories.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="flex-1 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any status</SelectItem>
                    <SelectItem value="in_stock">In stock</SelectItem>
                    <SelectItem value="assigned">Assigned</SelectItem>
                    <SelectItem value="repair">In repair</SelectItem>
                    <SelectItem value="retired">Retired</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="mt-auto rounded-md border bg-muted/40 p-3 text-center">
              <div className="text-2xl font-semibold">{seenInScope}<span className="text-base font-normal text-muted-foreground"> / {scope.length}</span></div>
              <div className="text-xs text-muted-foreground">sighted this walk-through</div>
            </div>
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="grid min-h-0 flex-1 grid-rows-2">
              <div className="flex min-h-0 flex-col border-b">
                <div className="flex items-center gap-2 px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <CircleDashed className="h-3.5 w-3.5" /> Not seen yet ({remaining.length})
                  {remaining.length > 0 && (
                    <button className="ml-auto font-normal normal-case tracking-normal underline decoration-dotted underline-offset-2 hover:text-foreground" onClick={exportMissing}>Export CSV</button>
                  )}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
                  {remaining.length === 0 ? (
                    <p className="py-6 text-center text-xs text-muted-foreground">Everything in scope has been sighted. 🎉</p>
                  ) : (
                    remaining.map((a) => (
                      <div key={a.path} className="flex items-center gap-2 border-b py-1.5 text-xs last:border-b-0">
                        <span className="w-28 flex-shrink-0 truncate font-mono">{a.asset_tag ?? "-"}</span>
                        <span className="min-w-0 flex-1 truncate">{a.name}</span>
                        <span className="flex-shrink-0 text-muted-foreground">{a.last_verified_time ? `last seen ${formatDate(a.last_verified_time.slice(0, 10))}` : "never verified"}</span>
                        <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" title="Sight it without scanning" onClick={() => recordSighting(a)}>Mark seen</Button>
                      </div>
                    ))
                  )}
                </div>
              </div>
              <div className="flex min-h-0 flex-col">
                <div className="flex items-center gap-2 px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Sighted ({scans.length})
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
                  {scans.length === 0 ? (
                    <p className="py-6 text-center text-xs text-muted-foreground">Scans land here as you go.</p>
                  ) : (
                    scans.map((s, i) => (
                      <div key={`${s.asset.path}-${i}`} className="flex items-center gap-2 border-b py-1.5 text-xs last:border-b-0">
                        <CheckCircle2 className={cn("h-3.5 w-3.5 flex-shrink-0", s.ok ? "text-success" : "text-amber-500")} />
                        <span className="w-28 flex-shrink-0 truncate font-mono">{s.asset.asset_tag ?? "-"}</span>
                        <span className="min-w-0 flex-1 truncate">{s.asset.name}</span>
                        {s.note ? <span className="flex-shrink-0 text-amber-600 dark:text-amber-400">{s.note}</span> : <span className="flex-shrink-0 text-muted-foreground">{new Date(s.at).toLocaleTimeString()}</span>}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
