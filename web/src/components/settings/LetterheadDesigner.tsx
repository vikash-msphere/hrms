import * as React from "react";
import { Copy, Image as ImageIcon, Loader2, Monitor, Plus, Printer, RotateCcw, X } from "lucide-react";
import { api, blobUrl, dataUrl, invoke, patch, remove, upload } from "@/api";
import { Field } from "@/components/common/Field";
import { WriteDialog } from "@/components/common/WriteDialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/use-toast";
import {
  LETTERHEAD_SLOTS, LETTERHEAD_TOKENS, STOCK,
  type LetterheadDesign, type LetterheadLine, type LetterheadMedia, type LetterheadSlot, type LetterheadVariant,
} from "@/lib/letterheadDesign";
import type { Letterhead } from "@/types";
import { cn } from "@/lib/utils";

// The letterhead page designer: margins, typeface, palette, the header band, the footer band, a watermark, and
// whether the uploaded artwork is a header mark or full-page stationery. Everything here is one JSON blob on
// the letterhead row (`design`), validated server-side by domain/letterhead.ts.
//
// The preview is the point of the screen. Judging a printed page from a form of numbers is guesswork, so every
// edit re-renders a real sample document - two pages of it, so the continuation header and the page-numbered
// footer can be seen too - through `letterheads/<id>:preview`, which persists nothing.
//
// A blank control means "the stock value", never "nothing": each one placeholders what the page will actually
// use, and clearing it returns the property to unset rather than storing an explicit empty.

const NONE = "__stock"; // Select's stand-in for an unset enum - Radix cannot hold an empty-string value

/** An image slot's human name, for saying which image currently holds a job. */
const slotLabel = (slot: LetterheadSlot) => LETTERHEAD_SLOTS.find((s) => s.slot === slot)?.label ?? slot;

// A chequerboard behind every preview. Letterhead artwork is nearly always a transparent PNG, and on a plain
// panel a white-on-transparent mark looks identical to a broken image - which is exactly how "I can't see the
// uploaded artwork" starts. Pure CSS, and it follows the theme's own border colour.
const CHEQUER =
  "bg-[length:12px_12px] bg-[position:0_0,0_6px,6px_-6px,-6px_0] " +
  "bg-[linear-gradient(45deg,hsl(var(--muted))_25%,transparent_25%),linear-gradient(-45deg,hsl(var(--muted))_25%,transparent_25%),linear-gradient(45deg,transparent_75%,hsl(var(--muted))_75%),linear-gradient(-45deg,transparent_75%,hsl(var(--muted))_75%)] " +
  "bg-background";


// The preview sheet. Stacked above the controls on a phone it takes most of the viewport; beside them from
// `lg` it holds A4 proportion (1:1.414) against the column width, so the paper fills the box rather than
// sitting in a letterbox, and is capped so the dialog never grows taller than the window.
const PREVIEW_BOX = "w-full rounded-md border bg-muted/30 h-[60dvh] lg:h-auto lg:aspect-[1/1.414] lg:max-h-[calc(100dvh-16rem)]";
// The server's own cap (services/letterheads.ts). Checked here too so an oversize file is refused before it is
// uploaded rather than after.
const MAX_ARTWORK_BYTES = 1024 * 1024;

// A file input styled as a button. Refuses oversize or unembeddable artwork here rather than at the server,
// where it would arrive as a failed upload.
function LetterheadPicker({ label, busy, onPick, toast }: { label: string; busy?: boolean; onPick: (file: File) => void; toast: ReturnType<typeof useToast>["toast"] }) {
  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = ""; // so re-picking the same file still fires a change
    if (!f) return;
    if (!/^image\/(png|jpeg)$/.test(f.type)) {
      toast({ variant: "destructive", title: "Use a PNG or JPG", description: "A PDF letterhead can only embed PNG or JPEG artwork." });
      return;
    }
    if (f.size > MAX_ARTWORK_BYTES) {
      toast({ variant: "destructive", title: "Image too large", description: `Use a file under ${Math.round(MAX_ARTWORK_BYTES / 1024 / 1024)} MB.` });
      return;
    }
    onPick(f);
  }
  return (
    <label className={cn("inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-accent", busy && "pointer-events-none opacity-60")}>
      <Plus className="h-4 w-4" /> {label}
      <input type="file" accept="image/png,image/jpeg" className="hidden" onChange={onFile} />
    </label>
  );
}

export function LetterheadDesigner({
  open,
  onClose,
  logo,
  reload,
  isNew,
  onSwitchTo,
}: {
  open: boolean;
  onClose: () => void;
  logo: Letterhead;
  reload: () => void;
  /** This row was created to open this dialog. Closing without saving removes it again, so an abandoned
   *  "Add letterhead" leaves nothing behind. */
  isNew?: boolean;
  /** Point the open dialog at another letterhead - what "Save as a copy" does with the copy it just made. */
  onSwitchTo?: (row: Letterhead) => void;
}) {
  const { toast } = useToast();
  const path = logo.path!;
  const stored = (logo.design ?? {}) as LetterheadDesign;
  const storedPrint = (logo.print_design ?? null) as LetterheadDesign | null;
  // A brand-new letterhead starts with an EMPTY name, not the placeholder row's "New letterhead": the field's
  // own placeholder says what belongs there, and Save stays blocked until it is actually named.
  //
  // `print` is null until the letterhead is given a print page of its own; the controls then edit whichever
  // page `media` names, so there is one set of controls and one preview rather than two editors.
  const [form, setForm] = React.useState({ label: isNew ? "" : logo.label ?? "", design: stored, print: storedPrint });
  const [media, setMedia] = React.useState<LetterheadMedia>("screen");
  const [preview, setPreview] = React.useState<string | null>(null);
  const [rendering, setRendering] = React.useState(false);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  // The images are bytes in object storage, not part of the form: each uploads the moment it is picked, and
  // the preview re-renders from what is stored. `thumbs` holds an object URL per slot for the Artwork tab.
  // Everything here is scoped to the VERSION being edited - the two never read each other's images.
  const [thumbs, setThumbs] = React.useState<Partial<Record<LetterheadSlot, string>>>({});
  const allAssets = (logo.assets ?? {}) as Partial<Record<LetterheadVariant, Partial<Record<LetterheadSlot, { size_bytes?: number }>>>>;
  const [uploading, setUploading] = React.useState<LetterheadSlot | null>(null);
  const [artNonce, setArtNonce] = React.useState(0); // bumped by an upload: what is stored changed, the form did not
  const [copying, setCopying] = React.useState(false);
  const saved = React.useRef(false);
  // Which VERSION is being edited. A version owns its design and its images outright, so everything below -
  // the controls, the image cards, the preview - is that version and only that version. On Print before a
  // print version exists the controls show the screen one READ-ONLY: editing there used to fork a whole
  // second version silently, which is the opposite of "change one thing, change one thing".
  const editingPrint = media === "print" && !!form.print;
  // Whose images everything on screen belongs to. With no print version there is nothing of its own to show,
  // so the preview falls back to the screen version - and the editor says so rather than pretending.
  const shownVariant: LetterheadVariant = media === "print" && form.print ? "print" : "screen";
  const showingPrintPlaceholder = media === "print" && !form.print;
  // ALWAYS this version's own images, never the other's. Showing the screen version's images while the Print
  // tab was selected is what made an image uploaded to Screen look like it had been added to Print as well -
  // with a remove button that could only ever delete from Print, where there was nothing to delete.
  const assets = allAssets[media] ?? {};
  const design = editingPrint ? form.print! : form.design;
  const setDesign = (next: LetterheadDesign | ((d: LetterheadDesign) => LetterheadDesign)) =>
    setForm((f) => {
      const base = editingPrint ? f.print ?? f.design : f.design;
      const value = typeof next === "function" ? next(base) : next;
      return editingPrint ? { ...f, print: value } : { ...f, design: value };
    });

  // Reset during the render that opens the dialog, not in an effect, so the discard guard's baseline is what
  // is actually stored rather than an empty design it would then see as an edit.
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) { setForm({ label: isNew ? "" : logo.label ?? "", design: stored, print: storedPrint }); setMedia("screen"); setPreviewError(null); saved.current = false; }
  }

  // A never-saved new letterhead is not a letterhead - drop the row rather than leaving an empty one in the
  // list. Failure here is silent on purpose: the row is harmless and the reader is already leaving.
  async function close() {
    if (isNew && !saved.current) {
      try { await remove(path, logo.etag); reload(); } catch { /* leave the empty row rather than nag */ }
    }
    onClose();
  }

  // Both pages as the API takes them: an empty design is stored as "no design" (the stock page) rather than as
  // an empty object, and a print page that was never turned on is stored as null - meaning "print as you
  // render", which is not the same as "print on the stock page".
  const writtenPages = () => ({
    design: Object.keys(form.design).length ? form.design : null,
    print_design: form.print && Object.keys(form.print).length ? form.print : null,
  });

  // Split what is on screen off into a NEW letterhead, artwork carried across by the server (the bytes never
  // travel through the browser twice). The dialog then follows the copy, because that is what the reader is
  // now working on - and it counts as saved, so closing it cannot delete anything.
  async function saveAsCopy() {
    setCopying(true);
    try {
      const copy = await api<Letterhead>(`/${path}:duplicate`, {
        method: "POST",
        body: JSON.stringify({ label: `${form.label.trim()} copy`, ...writtenPages() }),
      });
      saved.current = true;
      reload();
      onSwitchTo?.(copy);
      toast({ title: `Saved as "${copy.label}"`, variant: "success" });
    } catch (e) {
      toast({ title: "Couldn't copy", description: (e as Error).message, variant: "destructive" });
    } finally {
      setCopying(false);
    }
  }

  async function uploadArt(slot: LetterheadSlot, file: File) {
    setUploading(slot);
    try {
      // Into THIS version's images. The other version is untouched, which is the whole point of the pair.
      await upload<Letterhead>(path, file, { verb: "uploadImage", params: { slot, variant: media } });
      reload();
      // Both the thumbnails and the preview draw what is now stored server-side, so bump the nonce they watch -
      // the form itself has not changed, and neither would re-fetch on its own.
      setArtNonce((n) => n + 1);
    } catch (e) {
      toast({ title: "Couldn't upload", description: (e as Error).message, variant: "destructive" });
    } finally {
      setUploading(null);
    }
  }

  async function removeArt(slot: LetterheadSlot) {
    setUploading(slot);
    try {
      // From THIS version only. Nothing else has to be cleaned up: an image IS its job, so removing it is
      // what stops the band drawing - no dangling reference to tidy.
      await invoke(path, "deleteImage", undefined, undefined, { slot, variant: media });
      reload();
      setArtNonce((n) => n + 1);
    } catch (e) {
      toast({ title: "Couldn't remove", description: (e as Error).message, variant: "destructive" });
    } finally {
      setUploading(null);
    }
  }

  // Re-render the sample a beat after typing stops: a preview per keystroke would be a PDF render per
  // keystroke, and the page only has to keep up with a reader's eye.
  // A PDF is big enough to be worth an object URL (the iframe streams it), but the URL must OUTLIVE the effect
  // that made it: this re-runs on every edit, and revoking in cleanup pulled the file out from under the
  // iframe still showing it - the preview going blank between keystrokes. So the previous URL is revoked when
  // its replacement has actually arrived, and the last one when the dialog unmounts.
  const snap = JSON.stringify(design);
  const previewUrl = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!open) return;
    let dropped = false;
    const t = setTimeout(() => {
      setRendering(true);
      // `variant` matters even though the draft design is sent inline: it tells the server whose IMAGES to
      // draw. Without it every preview used the screen version's images, so a print version with its own
      // stationery previewed with the screen one's - the leak this whole pair exists to prevent.
      void blobUrl(path, { verb: "preview", body: { design, variant: shownVariant } })
        .then((u) => {
          if (dropped) { URL.revokeObjectURL(u); return; }
          const old = previewUrl.current;
          previewUrl.current = u;
          setPreview(u);
          if (old) URL.revokeObjectURL(old); // the iframe has the new one now
          setPreviewError(null);
        })
        .catch((e: unknown) => { if (!dropped) setPreviewError((e as Error).message); })
        .finally(() => { if (!dropped) setRendering(false); });
    }, 600);
    return () => { dropped = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap, open, path, artNonce]);

  // The one place the preview URL is revoked for good: the dialog is going away, so nothing is showing it.
  React.useEffect(() => () => { if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); }, []);

  // A preview per stored image. Each is its own fetch (the bytes live in object storage and never ride along
  // with the row), so only the slots that hold something are fetched, and each is kept as a DATA URL.
  //
  // Object URLs were wrong here and were why an uploaded image showed as nothing: an upload re-runs this
  // effect twice in quick succession (the nonce, then the reloaded row), and each run's cleanup revoked the
  // URLs the PREVIOUS run had already put on screen - so the <img> ended up pointing at a revoked blob. A data
  // URL is a plain string with no lifetime to get wrong.
  //
  // Keyed by version too: switching Screen/Print must not show the other version's images for a frame.
  const storedSlots = Object.keys(assets).join(",");
  React.useEffect(() => {
    if (!open) return;
    let dropped = false;
    const want = Object.keys(assets) as LetterheadSlot[];
    setThumbs((t) => Object.fromEntries(want.filter((s) => t[s]).map((s) => [s, t[s]!]))); // drop deleted slots, keep the rest on screen
    void Promise.all(
      want.map(async (slot) => {
        try {
          const src = await dataUrl(path, { verb: "image", params: { slot, variant: shownVariant } });
          if (!dropped) setThumbs((t) => ({ ...t, [slot]: src }));
        } catch {
          /* no access to the bytes, or they are gone - the card still lists the slot */
        }
      })
    );
    return () => { dropped = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `assets` is re-derived each render; its KEYS are the dependency
  }, [open, path, storedSlots, artNonce, shownVariant]);

  // Switching version swaps the whole image set, so clear rather than showing the last one's for a beat.
  React.useEffect(() => setThumbs({}), [shownVariant, path]);

  // ── Nested updates. Each band is shallow-merged and then pruned, so clearing the last control in a band
  //    removes the band itself rather than leaving `{}` in the stored blob. ────────────────────────────────
  type D = LetterheadDesign;
  const band = <K extends keyof D>(key: K, value: Partial<NonNullable<D[K]>>) =>
    setDesign((d) => {
      const merged = { ...(d[key] as object), ...value } as Record<string, unknown>;
      for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
      const next = { ...d };
      if (Object.keys(merged).length) (next[key] as unknown) = merged;
      else delete next[key];
      return next;
    });
  const page = (v: Partial<NonNullable<D["page"]>>) => band("page", v);
  const margin = (v: Partial<NonNullable<NonNullable<D["page"]>["margin"]>>) =>
    page({ margin: { ...design.page?.margin, ...v } });
  const background = (v: Partial<NonNullable<D["background"]>>) => band("background", v);
  const header = (v: Partial<NonNullable<D["header"]>>) => band("header", v);
  const footer = (v: Partial<NonNullable<D["footer"]>>) => band("footer", v);
  const watermark = (v: Partial<NonNullable<D["watermark"]>>) => band("watermark", v);
  const headerName = (v: Partial<NonNullable<NonNullable<D["header"]>["name"]>>) => header({ name: { ...design.header?.name, ...v } });
  const headerAddress = (v: Partial<NonNullable<NonNullable<D["header"]>["address"]>>) => header({ address: { ...design.header?.address, ...v } });
  const headerRule = (v: Partial<NonNullable<NonNullable<D["header"]>["rule"]>>) => header({ rule: { ...design.header?.rule, ...v } });
  const footerRule = (v: Partial<NonNullable<NonNullable<D["footer"]>["rule"]>>) => footer({ rule: { ...design.footer?.rule, ...v } });
  const headerMark = (v: Partial<NonNullable<NonNullable<D["header"]>["mark"]>>) => header({ mark: { ...design.header?.mark, ...v } });
  const lines = design.header?.lines ?? [];
  const setLine = (i: number, v: Partial<LetterheadLine>) => header({ lines: lines.map((l, j) => (i === j ? { ...l, ...v } : l)) });

  // Whether each band draws at all. There is nothing to ASSIGN: an image is its job, so the only question per
  // card is "draw it or not", and the answer for one card says nothing about the others.
  const drawn: Record<LetterheadSlot, boolean> = {
    mark: design.header?.mark?.show !== false,
    stationery: design.background?.show !== false,
    watermark: design.watermark?.show !== false,
  };
  // An uploaded watermark image is drawn instead of text, so the text field says so rather than lying.
  const hasWatermarkImage = !!assets.watermark && drawn.watermark;
  function setDrawn(slot: LetterheadSlot, on: boolean) {
    const show = on ? undefined : false; // `undefined` clears the property; the stock answer is "drawn"
    if (slot === "mark") headerMark({ show });
    if (slot === "stationery") background({ show });
    if (slot === "watermark") watermark({ show });
  }

  return (
    <WriteDialog
      open={open}
      onClose={close}
      title={isNew ? "New letterhead" : `Design ${logo.label}`}
      description="The page every document issued on this letterhead prints on. The preview is a real render - two pages of a sample document."
      collection="letterheads"
      objectPath={path}
      form={form}
      submitLabel={isNew ? "Create letterhead" : "Save design"}
      canSubmit={!!form.label.trim()}
      whyNot="Give the letterhead a name."
      guardLabel={isNew ? "this new letterhead" : "this letterhead design"}
      // Wider than any other dialog in the app on purpose: the preview IS the screen, and a page judged at
      // thumbnail size is not judged at all. The controls take what is left, which is still a comfortable
      // two-to-four columns.
      className="sm:max-w-3xl lg:max-w-5xl xl:max-w-7xl"
      footerStart={
        <div className="flex flex-wrap items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => setDesign({})} disabled={!Object.keys(design).length}>
            <RotateCcw className="h-4 w-4" /> {editingPrint ? "Reset the print page" : "Reset to the stock page"}
          </Button>
          {/* Variants are the normal case for a multi-brand org: the same stationery with a different footer,
              a second entity's mark. Copying what is ON SCREEN (not what is stored) means a design can be
              tried out here and kept as a new letterhead without ever saving over the one it came from. */}
          {!isNew && (
            <Button variant="ghost" size="sm" onClick={saveAsCopy} disabled={copying || !form.label.trim()}>
              {copying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />} Save as a copy
            </Button>
          )}
        </div>
      }
      onSubmit={async () => {
        await patch(path, { label: form.label.trim(), ...writtenPages() }, logo.etag);
        saved.current = true;
        reload();
      }}
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <Field label="Name" hint="The entity or brand this letterhead belongs to - what the pickers list it as." className="min-w-0 flex-1 basis-64">
          <Input value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} placeholder="e.g. Acme Technologies Pvt Ltd" className="sm:max-w-md" />
        </Field>
        {/* Which of the letterhead's two VERSIONS everything below belongs to - its settings and its images.
            The print version is optional; until it exists the Print tab offers to create one and shows
            nothing else, rather than displaying the screen version's images as if they were its own. */}
        <Tabs value={media} onValueChange={(v) => setMedia(v as LetterheadMedia)}>
          <TabsList variant="segmented">
            <TabsTrigger value="screen"><Monitor className="h-4 w-4" /> Screen</TabsTrigger>
            <TabsTrigger value="print"><Printer className="h-4 w-4" /> Print</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {media === "print" && form.print && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 p-3">
          <p className="text-xs text-muted-foreground">
            A separate version, with its own settings AND its own images. Nothing here is shared with the screen version - change either one freely.
          </p>
          <Button variant="outline" size="sm" onClick={() => setForm((f) => ({ ...f, print: null }))}>
            Drop the print version
          </Button>
        </div>
      )}
      {/* The preview column is sized in A4 proportion (1:1.414) rather than in fractions of the dialog, so the
          sheet fills it instead of floating in a letterbox: 26rem of paper at `lg`, 32rem once there is room. */}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_26rem] xl:grid-cols-[minmax(0,1fr)_32rem]">
        {/* No print version yet: offer to make one and show NOTHING else. Greying out the real editor put a
            full set of live-looking controls on screen - an Add button that did nothing, a remove button that
            could only delete from a version with no images - over a set of images belonging to the other
            version. An empty state says the true thing instead. */}
        {showingPrintPlaceholder ? (
          <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed p-6">
            <Printer className="h-6 w-6 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">This letterhead prints exactly as it renders</p>
              <p className="mt-1 max-w-prose text-xs text-muted-foreground">
                Documents printed on it use the screen version, shown in the preview. Give printing its own version to change that - it starts as a
                copy of these settings, with no images of its own, and nothing you do to it afterwards touches the screen version.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setForm((f) => ({ ...f, print: { ...f.design } }))}>
              <Plus className="h-4 w-4" /> Add a print version
            </Button>
          </div>
        ) : (
        <Tabs defaultValue="page">
          <TabsList>
            <TabsTrigger value="page">Page</TabsTrigger>
            <TabsTrigger value="header">Header</TabsTrigger>
            <TabsTrigger value="footer">Footer</TabsTrigger>
            <TabsTrigger value="mark">Artwork</TabsTrigger>
          </TabsList>

          <TabsContent value="page" className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Pick label="Paper" value={design.page?.size} onChange={(v) => page({ size: v as "a4" | "letter" })} options={[["a4", "A4"], ["letter", "US Letter"]]} />
              <Pick label="Typeface" value={design.page?.font} onChange={(v) => page({ font: v as "serif" | "sans" })} options={[["serif", "Serif (Times)"], ["sans", "Sans (Helvetica)"]]} />
            </div>
            <div>
              <p className="mb-2 text-sm font-medium">Margins</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Num label="Top" value={design.page?.margin?.top} onChange={(n) => margin({ top: n })} placeholder={STOCK.margin.top} min={18} max={144} />
                <Num label="Right" value={design.page?.margin?.right} onChange={(n) => margin({ right: n })} placeholder={STOCK.margin.right} min={18} max={144} />
                <Num label="Bottom" value={design.page?.margin?.bottom} onChange={(n) => margin({ bottom: n })} placeholder={STOCK.margin.bottom} min={18} max={144} />
                <Num label="Left" value={design.page?.margin?.left} onChange={(n) => margin({ left: n })} placeholder={STOCK.margin.left} min={18} max={144} />
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">Points, 72 to the inch. The body starts inside these, below the header band.</p>
            </div>
            <div>
              <p className="mb-2 text-sm font-medium">Ink</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Colour label="Text" value={design.page?.ink} onChange={(c) => page({ ink: c })} />
                <Colour label="Secondary" value={design.page?.muted} onChange={(c) => page({ muted: c })} />
                <Colour label="Rules" value={design.page?.hairline} onChange={(c) => page({ hairline: c })} />
                <Colour label="Accent" value={design.page?.accent} onChange={(c) => page({ accent: c })} />
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">Accent draws the heavy header rule and table borders. Blank keeps the stock near-black.</p>
            </div>
            {/* TEXT watermark only. An IMAGE watermark is a job an image does, so it is switched on and sized
                on that image's own card in Artwork - not here, where it would be a second place to set the
                same thing. */}
            <div className="space-y-3 border-t pt-4">
              <p className="text-sm font-medium">Watermark</p>
              <Field label="Text" hint="Drawn under the body on every page. Tokens work here. To wash an IMAGE across the page instead, upload one to the watermark card on the Artwork tab.">
                <Input
                  value={design.watermark?.text ?? ""}
                  onChange={(e) => watermark({ text: e.target.value || undefined })}
                  placeholder="e.g. CONFIDENTIAL"
                  disabled={hasWatermarkImage}
                  className="sm:max-w-md"
                />
              </Field>
              {hasWatermarkImage ? (
                <p className="text-xs text-muted-foreground">
                  This version has a watermark image, which is drawn instead of text. Its size, opacity and angle are on its card in Artwork.
                </p>
              ) : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Num label="Size" value={design.watermark?.size} onChange={(n) => watermark({ size: n })} placeholder={STOCK.watermarkSize} min={8} max={400} />
                  <Num label="Opacity" value={design.watermark?.opacity} onChange={(n) => watermark({ opacity: n })} placeholder={STOCK.watermarkOpacity} min={0.02} max={0.5} step={0.01} />
                  <Num label="Angle" value={design.watermark?.angle} onChange={(n) => watermark({ angle: n })} placeholder={STOCK.watermarkAngle} min={-90} max={90} />
                  <Colour label="Colour" value={design.watermark?.color} onChange={(c) => watermark({ color: c })} />
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="header" className="space-y-4">
            <Toggle
              label="Draw the header band"
              checked={design.header?.show !== false}
              onChange={(b) => header({ show: b ? undefined : false })}
              hint="Turn it off for pre-printed stationery that already carries a masthead, then set the height below so the body clears it."
            />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Num label="Band height" value={design.header?.height} onChange={(n) => header({ height: n })} placeholder="auto" min={0} max={400} />
              <Pick label="On later pages" value={design.header?.repeat} onChange={(v) => header({ repeat: v as "full" | "slim" | "none" })} options={[["full", "The full band"], ["slim", "Name + hairline"], ["none", "Nothing"]]} />
            </div>
            {design.header?.show !== false && (
              <>
                <div className="space-y-3 border-t pt-4">
                  <p className="text-sm font-medium">Company name</p>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field label="Text" hint="Blank uses the organization name.">
                      <Input value={design.header?.name?.text ?? ""} onChange={(e) => headerName({ text: e.target.value || undefined })} placeholder={logo.label} />
                    </Field>
                    <div className="grid grid-cols-2 gap-3">
                      <Num label="Size" value={design.header?.name?.size} onChange={(n) => headerName({ size: n })} placeholder={STOCK.nameSize} min={5} max={36} />
                      <Colour label="Colour" value={design.header?.name?.color} onChange={(c) => headerName({ color: c })} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <Pick label="Case" value={design.header?.name?.case} onChange={(v) => headerName({ case: v as "upper" | "asis" })} options={[["upper", "UPPERCASE"], ["asis", "As typed"]]} />
                    <Pick label="Weight" value={design.header?.name?.weight} onChange={(v) => headerName({ weight: v as "regular" | "bold" })} options={[["bold", "Bold"], ["regular", "Regular"]]} />
                    <Toggle label="Show it" checked={design.header?.name?.show !== false} onChange={(b) => headerName({ show: b ? undefined : false })} />
                  </div>
                </div>
                <div className="space-y-3 border-t pt-4">
                  <p className="text-sm font-medium">Address</p>
                  {/* Multiline, because the renderer draws one header line per line typed here - a single-line
                      input made a three-line address impossible to enter. */}
                  <Field label="Text" hint="One line per line. Blank uses the organization address.">
                    <Textarea
                      value={design.header?.address?.text ?? ""}
                      onChange={(e) => headerAddress({ text: e.target.value || undefined })}
                      rows={3}
                      maxLength={600}
                      placeholder={"e.g. Acme Technologies Pvt Ltd\n4th Floor, MG Road\nBengaluru 560001"}
                    />
                  </Field>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <Num label="Size" value={design.header?.address?.size} onChange={(n) => headerAddress({ size: n })} placeholder={STOCK.addressSize} min={5} max={24} />
                    <Colour label="Colour" value={design.header?.address?.color} onChange={(c) => headerAddress({ color: c })} />
                    <Toggle label="Show it" checked={design.header?.address?.show !== false} onChange={(b) => headerAddress({ show: b ? undefined : false })} />
                  </div>
                </div>
                <div className="space-y-3 border-t pt-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">Extra lines</p>
                    {lines.length < 6 && (
                      <Button variant="ghost" size="sm" onClick={() => header({ lines: [...lines, { text: "" }] })}>
                        <Plus className="h-4 w-4" /> Add a line
                      </Button>
                    )}
                  </div>
                  {lines.length === 0 && <p className="text-xs text-muted-foreground">A GST or CIN number, a tagline, a contact strip - whatever sits under the address.</p>}
                  {lines.map((l, i) => (
                    <div key={i} className="flex flex-wrap items-end gap-2">
                      <div className="min-w-0 flex-1 basis-48">
                        <Input value={l.text} onChange={(e) => setLine(i, { text: e.target.value })} placeholder="e.g. CIN U72900KA2019PTC000000 | GSTIN 29AAAAA0000A1Z5" aria-label={`Header line ${i + 1}`} />
                      </div>
                      <div className="w-20"><Num label="Size" value={l.size} onChange={(n) => setLine(i, { size: n })} placeholder={STOCK.lineSize} min={5} max={24} /></div>
                      <div className="w-28"><Pick label="Align" value={l.align} onChange={(v) => setLine(i, { align: v as "left" | "center" | "right" })} options={[["left", "Left"], ["center", "Centre"], ["right", "Right"]]} /></div>
                      <Button variant="ghost" size="icon" aria-label={`Remove line ${i + 1}`} onClick={() => header({ lines: lines.filter((_, j) => j !== i) })}>
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
                <div className="space-y-3 border-t pt-4">
                  <p className="text-sm font-medium">Rule under the band</p>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <Toggle label="Draw it" checked={design.header?.rule?.show !== false} onChange={(b) => headerRule({ show: b ? undefined : false })} />
                    <Num label="Weight" value={design.header?.rule?.weight} onChange={(n) => headerRule({ weight: n })} placeholder={STOCK.headerRuleWeight} min={0.25} max={6} step={0.25} />
                    <Num label="Gap above" value={design.header?.rule?.gap} onChange={(n) => headerRule({ gap: n })} placeholder={0} min={0} max={40} />
                    <Colour label="Colour" value={design.header?.rule?.color} onChange={(c) => headerRule({ color: c })} />
                  </div>
                </div>
              </>
            )}
          </TabsContent>

          <TabsContent value="footer" className="space-y-4">
            <Toggle label="Draw the footer band" checked={!!design.footer?.show} onChange={(b) => footer({ show: b || undefined })} hint="Off by default - the stock page has no footer." />
            {design.footer?.show && (
              <>
                <div className="grid grid-cols-1 gap-3">
                  <Field label="Left" hint={`Tokens: ${LETTERHEAD_TOKENS.map((t) => `{{${t}}}`).join(", ")}.`}>
                    <Input value={design.footer?.left ?? ""} onChange={(e) => footer({ left: e.target.value || undefined })} placeholder="e.g. {{legal_name}}" />
                  </Field>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field label="Centre">
                      <Input value={design.footer?.center ?? ""} onChange={(e) => footer({ center: e.target.value || undefined })} placeholder="e.g. Page {{page}} of {{pages}}" />
                    </Field>
                    <Field label="Right">
                      <Input value={design.footer?.right ?? ""} onChange={(e) => footer({ right: e.target.value || undefined })} placeholder="e.g. {{date}}" />
                    </Field>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Pick label="On which pages" value={design.footer?.pages} onChange={(v) => footer({ pages: v as "all" | "first" | "continuation" })} options={[["all", "Every page"], ["first", "The first only"], ["continuation", "All but the first"]]} />
                  <Num label="Band height" value={design.footer?.height} onChange={(n) => footer({ height: n })} placeholder={STOCK.footerHeight} min={0} max={160} />
                  <Num label="Size" value={design.footer?.size} onChange={(n) => footer({ size: n })} placeholder={STOCK.footerSize} min={5} max={18} />
                  <Colour label="Colour" value={design.footer?.color} onChange={(c) => footer({ color: c })} />
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Toggle label="Rule above" checked={design.footer?.rule?.show !== false} onChange={(b) => footerRule({ show: b ? undefined : false })} />
                  <Num label="Weight" value={design.footer?.rule?.weight} onChange={(n) => footerRule({ weight: n })} placeholder={STOCK.footerRuleWeight} min={0.25} max={6} step={0.25} />
                  <Colour label="Colour" value={design.footer?.rule?.color} onChange={(c) => footerRule({ color: c })} />
                </div>
                <p className="text-xs text-muted-foreground">The body stops above this band, so a deeper footer means a shorter letter per page - never text printed over the footer.</p>
              </>
            )}
          </TabsContent>

          <TabsContent value="mark" className="space-y-3">
            {/* Three cards, one per job, each holding that job's own image and its own settings. There is
                nothing to assign: upload to a card and that job draws it, remove it and the job stops. These
                images belong to the version selected above - the other version has its own. Uploads land
                immediately (they are bytes in object storage, not form state). */}
            <p className="text-xs text-muted-foreground">
              The {media === "print" ? "print" : "screen"} version's images. Each one is separate: adding, changing or removing any of them leaves
              the other two, and the other version, exactly as they are. PNG or JPG under 1 MB each (a PDF can't embed an SVG).
            </p>
            {LETTERHEAD_SLOTS.map((s) => {
              const stored = assets[s.slot];
              const busy = uploading === s.slot;
              return (
                <div key={s.slot} className="space-y-3 rounded-lg border p-3">
                  <div className="flex flex-wrap items-center gap-3">
                    {/* Big enough to actually judge the artwork, on a chequerboard so a transparent PNG reads
                        as transparent rather than as "nothing loaded". Stationery is a whole sheet, so it gets
                        a taller box in A4 proportion; a mark and a watermark are wide chips. */}
                    <div
                      className={cn(
                        "flex shrink-0 items-center justify-center overflow-hidden rounded-md border",
                        CHEQUER,
                        s.slot === "stationery" ? "h-40 w-28" : "h-24 w-36"
                      )}
                    >
                      {thumbs[s.slot] ? (
                        <img src={thumbs[s.slot]} alt={`${s.label} artwork`} className="h-full w-full object-contain p-1.5" />
                      ) : stored ? (
                        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                      ) : (
                        <ImageIcon className="h-6 w-6 text-muted-foreground" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1 basis-40">
                      <p className="text-sm font-medium">{s.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {stored ? `${Math.max(1, Math.round((stored.size_bytes ?? 0) / 1024))} KB · ${drawn[s.slot] ? "drawn" : "not drawn"}` : s.hint}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <LetterheadPicker label={stored ? "Replace" : "Add"} busy={busy} onPick={(f) => uploadArt(s.slot, f)} toast={toast} />
                      {stored && (
                        <Button variant="ghost" size="icon" aria-label={`Remove ${s.label.toLowerCase()}`} disabled={busy} onClick={() => removeArt(s.slot)}>
                          <X className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                  {/* Only worth showing once there is an image: with none, the job draws nothing either way. */}
                  {stored && (
                    <div className="space-y-3 border-t pt-3">
                      <Toggle label="Draw it on this version" checked={drawn[s.slot]} onChange={(on) => setDrawn(s.slot, on)} />
                      {drawn[s.slot] && s.slot === "mark" && (
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                          <Num label="Height" value={design.header?.mark?.height} onChange={(n) => headerMark({ height: n })} placeholder={STOCK.markHeight} min={12} max={140} />
                          <Pick label="Side" value={design.header?.mark?.align} onChange={(v) => headerMark({ align: v as "left" | "right" | "center" })} options={[["right", "Right"], ["left", "Left"], ["center", "Centre"]]} />
                        </div>
                      )}
                      {drawn[s.slot] && s.slot === "stationery" && (
                        <>
                          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                            <Pick label="On which sheets" value={design.background?.pages} onChange={(v) => background({ pages: v as "first" | "all" })} options={[["first", "The first only"], ["all", "Every sheet"]]} />
                            <Num label="Opacity" value={design.background?.opacity} onChange={(n) => background({ opacity: n })} placeholder={1} min={0.05} max={1} step={0.05} />
                          </div>
                          <p className="text-xs text-muted-foreground">
                            Pre-printed stationery draws its own masthead, so you will usually turn the header band off on the Header tab and give
                            it a height instead - measure the printed header in points and use that.
                          </p>
                        </>
                      )}
                      {drawn[s.slot] && s.slot === "watermark" && (
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                          <Num label="Size" value={design.watermark?.size} onChange={(n) => watermark({ size: n })} placeholder={260} min={8} max={400} />
                          <Num label="Opacity" value={design.watermark?.opacity} onChange={(n) => watermark({ opacity: n })} placeholder={STOCK.watermarkOpacity} min={0.02} max={0.5} step={0.01} />
                          <Num label="Angle" value={design.watermark?.angle} onChange={(n) => watermark({ angle: n })} placeholder={STOCK.watermarkAngle} min={-90} max={90} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </TabsContent>
        </Tabs>
        )}

        <div className="space-y-2 lg:sticky lg:top-0 lg:self-start">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">Preview</p>
            {rendering && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>
          {previewError ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">{previewError}</p>
          ) : preview ? (
            <iframe title="Letterhead preview" src={preview} className={cn(PREVIEW_BOX, rendering && "opacity-60")} />
          ) : (
            <div className={cn(PREVIEW_BOX, "flex items-center justify-center text-xs text-muted-foreground")}>Rendering a sample document...</div>
          )}
          <p className="text-xs text-muted-foreground">
            A sample document on the <span className="font-medium">{shownVariant}</span> version{showingPrintPlaceholder ? " - which is what printing uses too, until this letterhead has a print version" : ""}. Nothing is filed.
          </p>
        </div>
      </div>
    </WriteDialog>
  );
}

// ── The four control shapes this editor is made of. Each treats blank as "unset", showing the stock value as
//    its placeholder, so nothing is stored just because a control was looked at. ──────────────────────────
function Num({ label, value, onChange, placeholder, min, max, step }: { label: string; value?: number; onChange: (n: number | undefined) => void; placeholder?: number | string; min?: number; max?: number; step?: number }) {
  return (
    <Field label={label}>
      <Input
        type="number"
        inputMode="decimal"
        value={value ?? ""}
        min={min}
        max={max}
        step={step ?? 1}
        placeholder={String(placeholder ?? "")}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
      />
    </Field>
  );
}

function Colour({ label, value, onChange }: { label: string; value?: string; onChange: (c: string | undefined) => void }) {
  return (
    <Field label={label}>
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          aria-label={label}
          value={value ?? "#111827"}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-10 shrink-0 cursor-pointer rounded-md border bg-background p-1"
        />
        {value && (
          <Button variant="ghost" size="icon" aria-label={`Clear ${label.toLowerCase()}`} onClick={() => onChange(undefined)}>
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
    </Field>
  );
}

function Pick({ label, value, onChange, options, hint }: { label: string; value?: string; onChange: (v: string | undefined) => void; options: [string, string][]; hint?: string }) {
  return (
    <Field label={label} hint={hint}>
      <Select value={value ?? NONE} onValueChange={(v) => onChange(v === NONE ? undefined : v)}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>Stock</SelectItem>
          {options.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
        </SelectContent>
      </Select>
    </Field>
  );
}

function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (b: boolean) => void; hint?: string }) {
  const id = React.useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="flex items-center gap-2 text-sm">
        <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} />
        {label}
      </label>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
