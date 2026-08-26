import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, CameraOff, ImageUp, ScanLine, CheckCircle2, KeyRound } from "lucide-react";
import { invoke } from "@/api";
import { idOf } from "@/lib/utils";
import type { Asset } from "@/types";
import { parseScanPayload, ASSET_CONDITION_LABEL } from "@/lib/assetTags";
import { useCodeScanner } from "@/lib/scanner";
import { ScanPreview, ScanPauseButton } from "@/components/assets/ScanPreview";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/common/Field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

// Confirming custody of ONE asset by scanning its sticker: the employee saying "yes, I have this", or an
// admin counting a returned/new item back into stock. The scan is not a formality - the payload travels to
// the server, which matches it against the secret printed inside that asset's QR, so a confirmation cannot
// be produced by anyone who is not holding the thing.
//
// The stocktake screen is the bulk version of this (many assets, one walk-through); this is the single-asset
// one, and it is what a tag's deep link opens straight into.

export type CustodyMode = "acknowledge" | "verify";

const COPY: Record<CustodyMode, { title: string; lead: string; cta: string; done: string }> = {
  acknowledge: {
    title: "Confirm you have this asset",
    lead: "Scan the sticker on the item itself - that scan is what records it as yours.",
    cta: "Yes, I have this",
    done: "Asset confirmed",
  },
  verify: {
    title: "Check this asset into stock",
    lead: "Scan its sticker to record that you are looking at the physical item.",
    cta: "Confirm in stock",
    done: "Asset verified",
  },
};

export function AssetCustodyDialog({
  asset,
  mode,
  presetScan,
  allowManual = mode === "verify",
  onClose,
  onDone,
}: {
  asset: Asset;
  mode: CustodyMode;
  presetScan?: string; // the payload a tag deep link arrived with, so a phone scan needs no second scan
  allowManual?: boolean; // offer the "sticker is unreadable" path (always available to a verifier)
  onClose: () => void;
  onDone: () => Promise<void> | void;
}) {
  const { toast } = useToast();
  const copy = COPY[mode];
  const [scan, setScan] = useState(presetScan ?? "");
  const [manual, setManual] = useState("");
  const [condition, setCondition] = useState("good");
  const [note, setNote] = useState("");
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // A scan is accepted only if it names THIS asset - otherwise the person is holding the wrong laptop, and
  // saying so immediately beats a 400 from the server after they hit confirm.
  const belongsHere = useMemo(() => {
    if (!scan.trim()) return false;
    const parsed = parseScanPayload(scan);
    if (!parsed) return false;
    if ("id" in parsed) return parsed.id === idOf(asset.path);
    return !!asset.asset_tag && parsed.tag.toLowerCase() === asset.asset_tag.toLowerCase();
  }, [scan, asset]);

  function takeScan(raw: string) {
    const parsed = parseScanPayload(raw);
    const mine = parsed && ("id" in parsed ? parsed.id === idOf(asset.path) : !!asset.asset_tag && parsed.tag.toLowerCase() === asset.asset_tag.toLowerCase());
    if (!mine) {
      toast({ variant: "destructive", title: "That tag belongs to a different asset", description: raw.slice(0, 80) });
      return;
    }
    setScan(raw);
    stopCamera();
  }

  const scanner = useCodeScanner(takeScan);
  const { cameraState, startCamera, stopCamera, decodeFiles } = scanner;

  // Straight to the camera when there is nothing to confirm with yet: this dialog exists to be scanned into.
  useEffect(() => {
    if (!presetScan) void startCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function confirm() {
    setBusy(true);
    try {
      await invoke(asset.path, mode, undefined, {
        ...(scan.trim() ? { scan: scan.trim() } : { override: true }),
        condition,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      stopCamera();
      toast({ title: copy.done, variant: "success" });
      await onDone();
      onClose();
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't confirm", description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const ready = belongsHere || (override && !!note.trim());

  return (
    <Dialog open onOpenChange={(v) => { if (!v) { stopCamera(); onClose(); } }}>
      {/* scrollBody keeps Cancel and the confirm on screen while the body - which can grow a camera preview -
          scrolls under them. Without it the actions leave the screen exactly when the scanner appears. */}
      <DialogContent scrollBody className="max-w-lg">
        <DialogHeader><DialogTitle>{copy.title}</DialogTitle></DialogHeader>
        <DialogBody>
        <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <div className="font-medium">{asset.name}</div>
          <div className="text-xs text-muted-foreground">{asset.asset_tag ? <span className="font-mono">{asset.asset_tag}</span> : "no tag"}{asset.serial_number ? ` · SN ${asset.serial_number}` : ""}</div>
        </div>

        {belongsHere ? (
          <div className="flex items-center gap-2 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-success">
            <CheckCircle2 className="h-4 w-4" /> Tag scanned - this is the right asset.
          </div>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">{copy.lead}</p>
            {cameraState === "on" ? (
              <ScanPreview scanner={scanner} />
            ) : (
              <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed text-xs text-muted-foreground">
                {cameraState === "unavailable" ? <CameraOff className="h-5 w-5" /> : <ScanLine className="h-5 w-5" />}
                {cameraState === "unavailable" ? "Camera unavailable - upload a photo of the sticker, or type its tag" : "Camera is off"}
              </div>
            )}
            {/* Nowrap button labels cannot be squeezed by `flex-1`; the row wraps instead of growing. */}
            <div className="flex flex-wrap gap-2">
              {cameraState === "on" ? (
                <>
                  <Button size="sm" variant="outline" className="flex-1" onClick={stopCamera}><CameraOff className="h-4 w-4" /> Stop camera</Button>
                  <ScanPauseButton scanner={scanner} className="flex-1" />
                </>
              ) : (
                <Button size="sm" variant="outline" className="flex-1" loading={cameraState === "starting"} onClick={() => void startCamera()}><Camera className="h-4 w-4" /> Start camera</Button>
              )}
              <Button size="sm" variant="outline" className="flex-1" onClick={() => fileRef.current?.click()}><ImageUp className="h-4 w-4" /> Upload photo</Button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={async (e) => {
                  const { hits } = await decodeFiles(e.target.files);
                  e.target.value = "";
                  if (!hits) toast({ variant: "destructive", title: "No code found", description: "Make sure the sticker is sharp and fills a good part of the photo." });
                }}
              />
            </div>
            <Field label="Or type the tag / scan into this box" hint="USB scanners type here and press Enter by themselves.">
              <Input
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && manual.trim()) takeScan(manual.trim()); }}
                placeholder="e.g. LAP-014"
              />
            </Field>
          </>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Condition">
            <Select value={condition} onValueChange={setCondition}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(ASSET_CONDITION_LABEL).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. scratch on the lid" /></Field>
        </div>

        {/* The escape hatch, deliberately plain and always audited as an unscanned confirmation. */}
        {allowManual && !belongsHere && (
          override ? (
            <Field label="Why you can't scan it" hint="Recorded on the asset's history as a confirmation without a scan.">
              <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. sticker peeled off; serial checked by hand" />
            </Field>
          ) : (
            <button className="self-start text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground" onClick={() => setOverride(true)}>
              <KeyRound className="mr-1 inline h-3 w-3" /> The sticker is missing or unreadable
            </button>
          )
        )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => { stopCamera(); onClose(); }}>Cancel</Button>
          <Button onClick={confirm} loading={busy} disabled={!ready}>{copy.cta}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
