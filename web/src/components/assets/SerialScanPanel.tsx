import { useEffect, useRef, useState } from "react";
import { Camera, CameraOff, ImageUp, ScanLine, CheckCircle2, X, AlertTriangle } from "lucide-react";
import { cleanScannedSerial, parseScanPayload } from "@/lib/assetTags";
import { SERIAL_FORMATS, useCodeScanner, hasNativeDetector, type Scan } from "@/lib/scanner";
import { ScanPreview, ScanPauseButton } from "@/components/assets/ScanPreview";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";

// Reading the SERIAL off the device, not our sticker off it. Nearly every laptop, phone, monitor and dock
// leaves the factory with the serial printed as a barcode next to the human-readable one, and typing a
// 14-character serial off the underside of a laptop is where asset records get their typos. So the serial
// field gets a camera: point it at the vendor label and the field fills itself.
//
// This is a panel inside the asset form rather than a dialog on top of it, for two reasons: the value lands in
// a field the reader is already looking at (and can still correct by hand), and a nested dialog on a phone
// would take the whole screen away from the form it belongs to.
//
// Not to be confused with AssetCustodyDialog / Stocktake, which read OUR tag and prove possession to the
// server. Nothing here talks to the server; it fills in a text field.

const FORMAT_LABEL: Record<string, string> = {
  code_128: "Code 128",
  code_39: "Code 39",
  code_93: "Code 93",
  codabar: "Codabar",
  itf: "ITF",
  data_matrix: "Data Matrix",
  qr_code: "QR",
  ean_13: "EAN-13",
  ean_8: "EAN-8",
  upc_a: "UPC-A",
  upc_e: "UPC-E",
  pdf417: "PDF417",
  aztec: "Aztec",
};

export function SerialScanPanel({
  onFound,
  onClose,
  duplicateOf,
}: {
  onFound: (serial: string) => void;
  onClose: () => void;
  /** Name of another asset already carrying this serial, if any - a duplicate is worth saying out loud here,
   *  since the usual cause is the same machine being added twice. */
  duplicateOf?: (serial: string) => string | undefined;
}) {
  const { toast } = useToast();
  const [hit, setHit] = useState<{ serial: string; format: string } | null>(null);
  const [duplicate, setDuplicate] = useState<string | undefined>(undefined);
  const fileRef = useRef<HTMLInputElement | null>(null);

  function take(raw: string, scan: Scan) {
    // Our own sticker encodes a deep link (or the tag text), not the serial. Scanning it here is an easy
    // mistake to make with two barcodes side by side on the same laptop, so say which one was read.
    const ours = parseScanPayload(raw);
    if (ours && "id" in ours) {
      toast({ variant: "destructive", title: "That is this app's own asset tag", description: "Scan the manufacturer's serial barcode on the device itself." });
      return;
    }
    const serial = cleanScannedSerial(raw);
    if (!serial) return;
    setHit({ serial, format: scan.format });
    setDuplicate(duplicateOf?.(serial));
    onFound(serial);
    stopCamera();
  }

  const scanner = useCodeScanner(take, { formats: SERIAL_FORMATS });
  const { cameraState, startCamera, stopCamera, decodeFiles } = scanner;

  // The panel only exists because somebody pressed Scan, so open the camera without a second press - and
  // release it on the way out. Without the cleanup, StrictMode's mount/unmount/mount (web/src/main.tsx) ran two
  // `getUserMedia` calls with nothing stopping the first, and any unmount that did not go through `close()`
  // left the sensor held.
  useEffect(() => {
    void startCamera();
    return () => stopCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function close() {
    stopCamera();
    onClose();
  }

  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3 sm:col-span-2">
      <div className="flex items-center gap-2">
        <ScanLine className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Scan the serial barcode</span>
        <button type="button" onClick={close} className="ml-auto rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Close scanner">
          <X className="h-4 w-4" />
        </button>
      </div>

      {hit ? (
        <div className="space-y-2">
          <div className="flex items-start gap-2 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-success">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0">
              <div className="font-mono break-all">{hit.serial}</div>
              <div className="text-xs opacity-80">Read from {FORMAT_LABEL[hit.format] ?? "the label"} and put in the serial field.</div>
            </div>
          </div>
          {duplicate && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <span>
                <span className="font-medium">{duplicate}</span> already has this serial. Check you are not adding the same device twice.
              </span>
            </div>
          )}
          <div className="flex gap-2">
            {/* Disabled while a start is in flight: a double-press is two `getUserMedia` calls racing, which is
                the production route into the orphaned-stream failure the generation guard in lib/scanner.ts
                now catches. */}
            <Button type="button" size="sm" variant="outline" className="flex-1" disabled={cameraState === "starting"} onClick={() => { setHit(null); setDuplicate(undefined); return startCamera(); }}>
              <Camera className="h-4 w-4" /> Scan another
            </Button>
            <Button type="button" size="sm" variant="outline" className="flex-1" onClick={close}>Done</Button>
          </div>
        </div>
      ) : (
        <>
          {cameraState === "on" ? (
            <ScanPreview scanner={scanner} />
          ) : (
            <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed text-center text-xs text-muted-foreground">
              {cameraState === "unavailable" ? <CameraOff className="h-5 w-5" /> : <ScanLine className="h-5 w-5" />}
              {cameraState === "unavailable" ? "Camera unavailable - upload a photo of the label instead" : cameraState === "starting" ? "Starting the camera…" : "Camera is off"}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Hold the label about 10 cm from the lens and fill the frame with the barcode.{hasNativeDetector() ? "" : " This browser decodes in software, so give it a second per frame."}
          </p>
          {/* Nowrap button labels cannot be squeezed by `flex-1`; the row wraps instead of growing. */}
          <div className="flex flex-wrap gap-2">
            {cameraState === "on" ? (
              <>
                <Button type="button" size="sm" variant="outline" className="flex-1" onClick={stopCamera}><CameraOff className="h-4 w-4" /> Stop camera</Button>
                <ScanPauseButton scanner={scanner} className="flex-1" />
              </>
            ) : (
              <Button type="button" size="sm" variant="outline" className="flex-1" loading={cameraState === "starting"} onClick={() => startCamera()}><Camera className="h-4 w-4" /> Start camera</Button>
            )}
            <Button type="button" size="sm" variant="outline" className="flex-1" onClick={() => fileRef.current?.click()}><ImageUp className="h-4 w-4" /> Upload photo</Button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={async (e) => {
                const { hits } = await decodeFiles(e.target.files);
                e.target.value = "";
                if (!hits) toast({ variant: "destructive", title: "No barcode found", description: "Make sure the label is sharp, straight on, and fills a good part of the photo." });
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
