import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Boxes, Camera, CameraOff, ImageUp, ListPlus, Minus, Plus, ScanLine } from "lucide-react";
import { invoke } from "@/api";
import { cn } from "@/lib/utils";
import { parseSerialLines, usableSerials, appendSerial, batchSizes } from "@/lib/assetBulk";
import { cleanScannedSerial, parseScanPayload } from "@/lib/assetTags";
import { SERIAL_FORMATS, useCodeScanner, hasNativeDetector } from "@/lib/scanner";
import { ScanPreview, ScanPauseButton } from "@/components/assets/ScanPreview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, FieldRow } from "@/components/common/Field";
import { Segmented } from "@/components/common/Segmented";
import { WriteDialog } from "@/components/common/WriteDialog";
import { AccessAction } from "@/components/access/AccessAction";
import { useToast } from "@/components/ui/use-toast";
import type { Asset, AssetCategory } from "@/types";

// Adding a delivery, rather than a thing.
//
// Stock arrives in two shapes and they need different forms. A box of twenty USB-C adapters is a NUMBER -
// nothing distinguishes one from another, and typing the same form twenty times is the whole problem. Twenty
// laptops are twenty SERIALS - each is a specific machine, and the serial is what a support call will quote.
// So this dialog has one shared head (what they are, which category, when they arrived) and two tails: a
// quantity, or a list.
//
// Either way the result is one asset row per physical object, because a sticker, a scan and a holder are all
// per object - `services/assets.ts` explains why a quantity column would have no answer to "who has adapter
// number seven". The tags come back as one contiguous run (MS-USB-021…040), which is exactly the sheet the
// printer wants next, so a successful add offers to print them.

/** Kept in step with ASSET_BATCH_MAX in src/services/assets.ts - one call, one bounded delivery. */
const PER_CALL = 100;

type Mode = "quantity" | "serials";
const EMPTY = { mode: "quantity" as Mode, name: "", category: "", quantity: 10, purchase_date: "", notes: "", text: "" };
type Form = typeof EMPTY;

export function BulkAddAssets({ categories, assets, onClose, onCreated }: {
  categories: AssetCategory[];
  /** The inventory as this page has it, for the "you already have this serial" warning. */
  assets: Asset[];
  onClose: () => void;
  /** What landed, in order. Called for a partial run too (those assets exist and are tagged), so the caller
   *  refreshes and remembers them for the printer WITHOUT closing a dialog that still holds unsent lines. */
  onCreated: (created: Asset[]) => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState<Form>(EMPTY);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const category = useMemo(() => categories.find((c) => c.path === form.category), [categories, form.category]);
  // A category that insists on serials cannot be filled by a quantity: twenty laptops are twenty serials. The
  // form follows the category rather than letting someone find that out from a rejected submit.
  const serialsOnly = !!category?.requires_serial;
  const mode: Mode = serialsOnly ? "serials" : form.mode;

  const parsed = useMemo(() => parseSerialLines(form.text), [form.text]);
  const rows = useMemo(() => usableSerials(parsed), [parsed]);
  const problems = parsed.filter((p) => p.error);

  // Whose serial this already is, if anyone's. Not a validation - two vendors genuinely repeat labels - but the
  // usual cause is the same machine being added twice, which is worth saying before creating it.
  const serialOwner = useMemo(() => {
    const m = new Map(assets.map((a) => [(a.serial_number ?? "").trim().toLowerCase(), a.name]));
    m.delete("");
    return (s: string) => m.get(s.trim().toLowerCase());
  }, [assets]);
  const dupes = rows.filter((r) => serialOwner(r.serial!));

  const total = mode === "quantity" ? form.quantity : rows.length;
  const blockers = [
    !form.name.trim() && "Say what these are.",
    mode === "quantity" && !(form.quantity >= 1) && "Give a quantity of at least one.",
    mode === "serials" && rows.length === 0 && "Add at least one serial number.",
  ];

  async function submit() {
    const shared = {
      name: form.name.trim(),
      ...(form.category ? { category: form.category } : {}),
      ...(form.purchase_date ? { purchase_date: form.purchase_date } : {}),
      ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
    };
    // One call per bounded delivery: the server allocates a tag run per call, and the client is the only side
    // that can say "40 of 120" while it works. Sequential on purpose - a failure stops the run rather than
    // leaving an unknown half of it created.
    const calls: Record<string, unknown>[][] =
      mode === "quantity"
        ? batchSizes(form.quantity, PER_CALL).map((n) => [{ ...shared, quantity: n }])
        : chunkList(rows.map((r) => ({ ...shared, ...(r.name ? { name: r.name } : {}), serial_number: r.serial })), PER_CALL);

    const created: Asset[] = [];
    setProgress({ done: 0, total });
    try {
      for (const items of calls) {
        const { results } = await invoke<{ results: Asset[] }>("assets", "batchCreate", undefined, { items });
        created.push(...(results ?? []));
        setProgress({ done: created.length, total });
      }
    } catch (e) {
      // Whatever landed before the failure is real and already tagged, so say so instead of implying nothing
      // happened - and let WriteDialog show the error with the rest of the list still in the box.
      if (created.length) {
        onCreated(created);
        toast({ variant: "destructive", title: `${created.length} of ${total} added`, description: "The rest were not created - fix the message below and add them." });
      }
      throw e;
    } finally {
      setProgress(null);
    }
    toast({ title: `Added ${created.length} asset${created.length === 1 ? "" : "s"}`, description: "Each waits for a check-in scan. Print their stickers to start.", variant: "success" });
    onCreated(created);
  }

  return (
    <WriteDialog
      open
      onClose={onClose}
      title="Add many assets"
      description="A delivery at a time: a quantity of identical things, or a list of serial numbers. Each one becomes its own record, with its own tag."
      collection="assets"
      guardLabel="delivery"
      form={form}
      draftKey="assets.bulk"
      applyDraft={(d) => setForm({ ...EMPTY, ...d })}
      onStartOver={() => setForm(EMPTY)}
      submitLabel={total > 0 ? `Add ${total} asset${total === 1 ? "" : "s"}` : "Add assets"}
      canSubmit={blockers.every((b) => !b)}
      whyNot={blockers}
      submitAccess={(b) => <AccessAction collection="assets" verb="batchCreate" label="Add assets in bulk">{b}</AccessAction>}
      className="sm:max-w-3xl"
      footerStart={progress ? <span className="text-xs text-muted-foreground">Adding {progress.done} of {progress.total}…</span> : undefined}
      onSubmit={submit}
    >
      <FieldRow>
        <Field label="Category" hint={serialsOnly ? "This kind needs a serial number for each one." : undefined}>
          <Select value={form.category || "none"} onValueChange={(v) => set("category", v === "none" ? "" : v)}>
            <SelectTrigger><SelectValue placeholder="Uncategorised" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Uncategorised</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.path} value={c.path}>{c.display_name}{c.tag_code ? ` (${c.tag_code})` : ""}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Purchase date"><Input type="date" value={form.purchase_date} onChange={(e) => set("purchase_date", e.target.value)} /></Field>
      </FieldRow>
      <Field label={mode === "quantity" ? "What they are" : "Name for all of them"} hint={mode === "serials" ? "A line may end with its own name to override this one." : undefined}>
        <Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder={mode === "quantity" ? "e.g. USB-C to HDMI adapter" : 'e.g. MacBook Pro 14"'} autoFocus />
      </Field>

      {!serialsOnly && (
        <Segmented
          label="How these are counted"
          value={mode}
          onChange={(v) => set("mode", v)}
          options={[
            { value: "quantity", label: "Identical items", hint: "No serial numbers - just how many arrived" },
            { value: "serials", label: "Serial numbers", hint: "One line per device, scanned or pasted" },
          ]}
        />
      )}

      {mode === "quantity" ? (
        <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
          <Field label="How many" hint="Each becomes its own record, so any one of them can be handed to somebody and tracked back.">
            <div className="flex items-center gap-2">
              <Button type="button" size="icon" variant="outline" aria-label="One fewer" onClick={() => set("quantity", Math.max(1, form.quantity - 1))}><Minus className="h-4 w-4" /></Button>
              <Input
                type="number"
                min={1}
                max={PER_CALL * 5}
                value={form.quantity}
                onChange={(e) => set("quantity", Math.max(1, Math.min(PER_CALL * 5, Math.round(Number(e.target.value) || 1))))}
                className="w-24 text-center tabular-nums"
              />
              <Button type="button" size="icon" variant="outline" aria-label="One more" onClick={() => set("quantity", Math.min(PER_CALL * 5, form.quantity + 1))}><Plus className="h-4 w-4" /></Button>
              <div className="ml-auto flex flex-wrap gap-1">
                {[5, 10, 20, 50].map((n) => (
                  <Button key={n} type="button" size="sm" variant={form.quantity === n ? "secondary" : "ghost"} className="h-7 px-2 text-xs tabular-nums" onClick={() => set("quantity", n)}>{n}</Button>
                ))}
              </div>
            </div>
          </Field>
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <Boxes className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            {form.quantity} separate records{category?.tag_code ? `, tagged on the ${category.tag_code} run` : ""}. They carry no serial numbers, so the tag on the sticker is what tells them apart.
          </p>
        </div>
      ) : (
        <SerialList
          text={form.text}
          onText={(t) => set("text", t)}
          scanning={scanning}
          onScanning={setScanning}
          parsed={parsed}
          serialOwner={serialOwner}
        />
      )}

      <Field label="Notes (optional)" hint="Copied onto every record in this delivery - the PO number, who signed for it.">
        <Textarea rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
      </Field>

      <p className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <ScanLine className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
        Nothing here is assigned to anybody: handing something over is a scan, one thing at a time. The whole
        delivery waits as “Awaiting check-in” until its tags are printed and scanned.
      </p>
      {dupes.length > 0 && (
        <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
          <span>{dupes.length === 1 ? "One serial is" : `${dupes.length} serials are`} already in the inventory. They will be added again - check you are not entering the same devices twice.</span>
        </p>
      )}
      {problems.length > 0 && (
        <p className="text-xs text-muted-foreground">{problems.length} line{problems.length === 1 ? "" : "s"} will be skipped - see the list above.</p>
      )}
    </WriteDialog>
  );
}

// The serial half of the form: type, paste, or hold the camera over box after box. The preview is the point -
// a mis-read serial that got created anyway is the failure this exists to prevent.
function SerialList({ text, onText, scanning, onScanning, parsed, serialOwner }: {
  text: string;
  onText: (t: string) => void;
  scanning: boolean;
  onScanning: (v: boolean) => void;
  parsed: ReturnType<typeof parseSerialLines>;
  serialOwner: (serial: string) => string | undefined;
}) {
  const { toast } = useToast();
  const [scanned, setScanned] = useState(0);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // The scanner fires from a loop that outlives a render, so it reads the text through a ref rather than a
  // captured value - otherwise the second scan of a session overwrites the first.
  const textRef = useRef(text);
  textRef.current = text;

  const scanner = useCodeScanner((raw) => {
    // Our own sticker encodes a deep link, not the serial - an easy mistake with two barcodes on one laptop.
    if (parseScanPayload(raw)) {
      toast({ variant: "destructive", title: "That is this app's own asset tag", description: "Scan the manufacturer's serial barcode on the device itself." });
      return;
    }
    const serial = cleanScannedSerial(raw);
    if (!serial) return;
    const next = appendSerial(textRef.current, serial);
    if (!next.added) return; // the same label drifting back into frame
    textRef.current = next.text;
    onText(next.text);
    setScanned((n) => n + 1);
  }, { formats: SERIAL_FORMATS });
  const { cameraState, startCamera, stopCamera, decodeFiles } = scanner;

  // The camera belongs to the scanning state, both ways: closing the panel must release it.
  useEffect(() => {
    if (scanning) void startCamera();
    else stopCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning]);

  return (
    <div className="space-y-2">
      <Field
        label="Serial numbers"
        hint="One per line. A comma, tab or | then a name overrides the shared one. Lines starting with # are ignored."
        action={
          <Button type="button" size="sm" variant="ghost" className="-my-1 h-6 gap-1 px-1.5 text-xs" onClick={() => onScanning(!scanning)}>
            <ScanLine className="h-3.5 w-3.5" /> {scanning ? "Close scanner" : "Scan them in"}
          </Button>
        }
      >
        <Textarea
          value={text}
          onChange={(e) => onText(e.target.value)}
          rows={6}
          className="font-mono text-xs"
          placeholder={"C02XK1FTQ6LR\nDMPQ3LL/A, MacBook Air 13\n5CD1234ABC"}
        />
      </Field>

      {scanning && (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ScanLine className="h-4 w-4 text-muted-foreground" />
            Keep scanning
            <span className="ml-auto text-xs font-normal text-muted-foreground tabular-nums">{scanned} added this session</span>
          </div>
          {cameraState === "on" ? (
            <ScanPreview scanner={scanner} />
          ) : (
            <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed text-center text-xs text-muted-foreground">
              {cameraState === "unavailable" ? <CameraOff className="h-5 w-5" /> : <Camera className="h-5 w-5" />}
              {cameraState === "unavailable" ? "Camera unavailable - upload photos of the labels instead" : cameraState === "starting" ? "Starting the camera…" : "Camera is off"}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Each label lands as a new line as it is read - work through the boxes without pressing anything.
            {hasNativeDetector() ? "" : " This browser decodes in software, so give it a second per label."}
          </p>
          {/* "Stop camera" / "Pause" / "Upload photos" are `whitespace-nowrap` labels, so `flex-1` cannot
              shrink them below their text - the row grows instead. Letting it wrap is the only way three
              labelled buttons fit a 360px screen. */}
          <div className="flex flex-wrap gap-2">
            {cameraState === "on" ? (
              <>
                <Button type="button" size="sm" variant="outline" className="flex-1" onClick={stopCamera}><CameraOff className="h-4 w-4" /> Stop camera</Button>
                <ScanPauseButton scanner={scanner} className="flex-1" />
              </>
            ) : (
              <Button type="button" size="sm" variant="outline" className="flex-1" loading={cameraState === "starting"} onClick={() => void startCamera()}><Camera className="h-4 w-4" /> Start camera</Button>
            )}
            <Button type="button" size="sm" variant="outline" className="flex-1" onClick={() => fileRef.current?.click()}><ImageUp className="h-4 w-4" /> Upload photos</Button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={async (e) => {
                const { hits, misses } = await decodeFiles(e.target.files);
                e.target.value = "";
                if (misses) toast({ variant: hits ? "default" : "destructive", title: `${misses} photo${misses === 1 ? "" : "s"} had no readable barcode`, description: "A sharp, straight-on shot that fills the frame reads best." });
              }}
            />
          </div>
        </div>
      )}

      {parsed.length > 0 && (
        <div className="max-h-64 overflow-y-auto rounded-lg border">
          <table className="w-full text-sm">
            <tbody className="divide-y">
              {parsed.map((p) => {
                const owner = p.serial ? serialOwner(p.serial) : undefined;
                return (
                  <tr key={p.line} className={cn(p.error && "bg-destructive/5", owner && "bg-amber-500/5")}>
                    <td className="w-10 px-2 py-1.5 text-right text-xs tabular-nums text-muted-foreground">{p.line}</td>
                    {p.error ? (
                      <td className="px-2 py-1.5 text-xs text-destructive" colSpan={2}>
                        <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
                        {p.error} - <span className="font-mono">{p.raw}</span>
                      </td>
                    ) : (
                      <>
                        <td className="px-2 py-1.5 font-mono text-xs break-all">{p.serial}</td>
                        <td className="px-2 py-1.5 text-right">
                          <span className="inline-flex flex-wrap items-center justify-end gap-1">
                            {p.name && <span className="text-xs text-muted-foreground">{p.name}</span>}
                            {owner && <Badge variant="warning">Already on {owner}</Badge>}
                          </span>
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        <ListPlus className="mr-1 inline h-3.5 w-3.5" />
        {usableSerials(parsed).length} to add{parsed.length !== usableSerials(parsed).length ? ` · ${parsed.length - usableSerials(parsed).length} to fix` : ""}
      </p>
    </div>
  );
}

// Split a list into runs of at most `size` - the item-level companion of lib/assetBulk#batchSizes.
function chunkList<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
