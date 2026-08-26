import { useEffect, useMemo, useRef, useState } from "react";
import { ScanLine, X, Camera, CameraOff, CheckCircle2, CircleDashed, Keyboard, ImageUp, BadgeCheck, PackageSearch, History, Play, PauseCircle, Flag, AlertTriangle } from "lucide-react";
import { create, invoke } from "@/api";
import { cn, idOf, formatDate } from "@/lib/utils";
import { navigate } from "@/router";
import type { Asset, AssetCategory, Employee, Stocktake as Count } from "@/types";
import { useCollection } from "@/hooks/useCollection";
import { parseScanPayload, ASSET_STATUS_LABEL, ASSET_CONDITION_LABEL } from "@/lib/assetTags";
import { SCOPE_PRESETS, inScopeWire, lastClosed, missingPaths, presetOf, scopeStatuses, sightedIn, type ScopePresetId } from "@/lib/stocktake";
import { useCodeScanner, hasNativeDetector } from "@/lib/scanner";
import { ScanPreview, ScanPauseButton } from "@/components/assets/ScanPreview";
import { exportTable } from "@/lib/exportTable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";

// Stocktake: the scanning half of the tag-printing loop, and now a RECORD of the walk rather than a screen
// that forgets. A count is a `stocktakes` row (open until somebody closes it), so progress survives a refresh,
// two people can split the floors into one count, and the missing list ends up stored instead of living in a
// CSV somebody had to remember to click.
//
// It still holds no sightings of its own: every scan is one `:verify` on the asset, carrying the count, and
// the server stamps `last_verified_time` / `last_verified_by` / `last_stocktake` on the row it was already
// updating. So "sighted in this count" is read straight off the assets the page already loaded (sightedIn),
// which is what makes resuming free - and what makes a hundred-item walk a hundred writes and no re-reads.
//
// The scan payload travels with the call rather than being thrown away after matching: it carries the secret
// printed inside that asset's QR, which is what makes a sighting evidence instead of a claim. Sighting
// without a scan ("mark seen") is possible and is recorded as exactly that.

const CONDITIONS = [
  { value: "good", label: "Good" },
  { value: "damaged", label: "Damaged" },
  { value: "missing_parts", label: "Missing parts" },
] as const;

const today = () => new Date().toISOString().slice(0, 10);

export function Stocktake({ onClose, initialCountId }: { onClose: () => void; initialCountId?: string }) {
  const { toast } = useToast();
  const confirm = useConfirm();
  // Assets and counts are read through the shared store, so this modal reuses what the Assets page already
  // fetched and a `:verify` response can be folded straight back into the rows every view is watching.
  const { rows: assets, setRows: setAssets } = useCollection<Asset>("assets");
  const { rows: counts, setRows: setCounts, reload: reloadCounts } = useCollection<Count>("stocktakes");
  const { rows: assetCategories } = useCollection<AssetCategory>("asset-categories");
  const { rows: employees } = useCollection<Employee>("employees");

  const [openPath, setOpenPath] = useState<string | null>(null); // the count being walked
  const [manual, setManual] = useState("");
  const [condition, setCondition] = useState<string>("good"); // sticky: a walk is mostly "good", and asking per item would crawl
  const [starting, setStarting] = useState(false);
  const [closing, setClosing] = useState(false);
  const [newLabel, setNewLabel] = useState(`Stocktake ${today()}`);
  const [newPreset, setNewPreset] = useState<ScopePresetId>("office");
  const [newCategory, setNewCategory] = useState("all");
  const [failed, setFailed] = useState<Record<string, string>>({}); // asset path -> why the sighting did not save
  const [checkedIn, setCheckedIn] = useState<string[]>([]); // sightings that also counted something into stock
  const fileRef = useRef<HTMLInputElement | null>(null);
  const foundRef = useRef(new Set<string>()); // unexpected payloads already logged, so a sticker in frame is one find

  const catName = (p?: string) => (p ? (assetCategories.find((c) => c.path === p)?.display_name ?? "") : "");
  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (p?: string) => (p ? (m.get(idOf(p)) ?? "someone") : "someone");
  }, [employees]);

  const open = useMemo(() => counts.filter((c) => c.status === "open" && !c.delete_time), [counts]);
  const session = useMemo(() => counts.find((c) => c.path === openPath) ?? null, [counts, openPath]);

  // Walk straight into the count the caller asked for (the Stocktakes page links here to scan into one), or
  // into the only open one: the common case is one person resuming their own walk, and making them pick it off
  // a list first would be a click that answers nothing.
  useEffect(() => {
    if (openPath) return;
    const asked = initialCountId ? open.find((c) => idOf(c.path) === initialCountId) : undefined;
    if (asked) setOpenPath(asked.path);
    else if (!initialCountId && open.length === 1) setOpenPath(open[0]!.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open.length, initialCountId]);

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

  // The audit scope, as the COUNT declared it (not as this screen's dropdowns happen to be set): the stored
  // scope is what its missing list will mean, so the walk and the report have to be filtering the same set.
  const scope = useMemo(() => (session ? assets.filter((a) => inScopeWire(session.scope, a)) : []), [assets, session]);

  // What the LAST closed count could not find. Shown as a chip on the not-seen rows, because "missing last
  // time too" is the difference between a thing somebody walked past and a thing that is actually gone - and
  // the person holding the scanner is the only one who can act on it, right now, without navigating anywhere.
  const missedLastTime = useMemo(() => missingPaths(lastClosed(counts)), [counts]);
  const lastCount = useMemo(() => lastClosed(counts), [counts]);
  // Which preset the last count's scope was, if any: only then can it be offered as a one-click repeat.
  const repeatablePreset = useMemo(() => {
    const statuses = lastCount?.scope?.statuses;
    return SCOPE_PRESETS.find((p) => (p.statuses ? !!statuses && statuses.length === p.statuses.length && p.statuses.every((s) => statuses.includes(s)) : !statuses?.length))?.id;
  }, [lastCount]);

  const seen = useMemo(() => (session ? scope.filter((a) => sightedIn(session, a)) : []), [scope, session]);
  const remaining = useMemo(() => (session ? scope.filter((a) => !sightedIn(session, a)) : []), [scope, session]);
  // Newest sighting first, so the last thing scanned is the first thing you can check.
  const sightedLog = useMemo(
    () => [...seen].sort((a, b) => (b.last_verified_time ?? "").localeCompare(a.last_verified_time ?? "")),
    [seen],
  );
  const flagged = seen.filter((a) => a.condition && a.condition !== "good").length;
  // Only categories something in the inventory is filed under: a catalog entry with no assets is not a useful filter.
  const categories = useMemo(() => {
    const used = new Set(assets.map((a) => a.category).filter((c): c is string => !!c));
    return assetCategories.filter((c) => used.has(c.path));
  }, [assets, assetCategories]);

  async function startCount() {
    setStarting(true);
    try {
      const body = {
        label: newLabel.trim() || `Stocktake ${today()}`,
        scope: {
          ...(scopeStatuses(newPreset) ? { statuses: scopeStatuses(newPreset) } : {}),
          ...(newCategory === "all" ? {} : { categories: [newCategory] }),
        },
      };
      const row = await create<Count>("stocktakes", body);
      setCounts((prev) => [row, ...prev.filter((c) => c.path !== row.path)]);
      setOpenPath(row.path);
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't start the count", description: (e as Error).message });
    } finally {
      setStarting(false);
    }
  }

  // One sighting = one `:verify` carrying this count. The raw scan goes with it, so the server can tell a real
  // scan from a hand-typed tag, and anything that was waiting to be counted in comes back as `in_stock`.
  //
  // Ticking a row off by hand skips the only evidence this screen exists to collect, and for a row awaiting
  // check-in it is what puts the asset into stock, so that path asks first. A real scan does not: the scan IS
  // the deliberate act, and a confirm per item would make a hundred-item walk unusable.
  async function recordSighting(a: Asset, raw?: string) {
    if (!session) return;
    if (sightedIn(session, a)) return; // already counted in this walk
    if (!raw) {
      const ok = await confirm({
        title: "Record this as seen without scanning?",
        description: `"${a.name}" is logged as confirmed by hand${a.status === "pending_verification" ? " and counted into stock" : ""}. The trail records it as an unscanned confirmation.`,
        confirmLabel: "Mark seen",
      });
      if (!ok) return;
    }
    const wasPending = a.status === "pending_verification";
    try {
      const updated = await invoke<Asset>(a.path, "verify", undefined, {
        ...(raw ? { scan: raw } : { override: true, note: "marked seen during a stocktake walk-through" }),
        ...(condition === "good" ? {} : { condition }),
        stocktake: session.path,
      });
      // Fold the reserialized asset back into the shared rows rather than refetching the inventory: that is
      // what keeps a long walk from costing a list read per scan (resourceStore VERB_SIDE_EFFECTS).
      setAssets((prev) => prev.map((r) => (r.path === updated.path ? updated : r)));
      setFailed(({ [a.path]: _gone, ...rest }) => rest);
      if (wasPending) setCheckedIn((prev) => [a.path, ...prev]);
    } catch (e) {
      // A failed save must not silently look like a sighting: the row stays in "not seen" and says why.
      setFailed((prev) => ({ ...prev, [a.path]: (e as Error).message }));
      toast({ variant: "destructive", title: `Couldn't record ${a.asset_tag ?? a.name}`, description: (e as Error).message });
    }
  }

  // A scan that matches nothing is the finding this whole exercise is for: something is here that the
  // inventory does not know about. Logged against the count, not dropped into a toast.
  async function recordFound(raw: string) {
    if (!session) return;
    // The camera re-reads whatever is in front of it every few seconds, so an unknown sticker left in frame
    // would log the same find over and over. Once per payload per session is the finding.
    if (foundRef.current.has(raw)) return;
    foundRef.current.add(raw);
    try {
      const updated = await invoke<Count>(session.path, "recordFound", undefined, { scan: raw });
      setCounts((prev) => prev.map((c) => (c.path === updated.path ? updated : c)));
      toast({ title: "Logged as an unexpected find", description: raw.slice(0, 80) });
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't log that scan", description: (e as Error).message });
    }
  }

  function handleScan(raw: string): boolean {
    const parsed = parseScanPayload(raw);
    const asset = parsed ? ("id" in parsed ? byId.get(parsed.id) : byTag.get(parsed.tag.toLowerCase())) : undefined;
    if (!asset) {
      void recordFound(raw);
      return true; // it WAS handled: the find is now on the record
    }
    void recordSighting(asset, raw);
    return true;
  }

  function submitManual() {
    const t = manual.trim();
    if (!t) return;
    if (handleScan(t)) setManual("");
  }

  const scanner = useCodeScanner(handleScan);
  const { cameraState, startCamera, stopCamera, decodeFiles } = scanner;

  async function uploadPhotos(files: FileList | null) {
    if (!files?.length) return;
    const { hits, misses } = await decodeFiles(files);
    if (misses > 0) {
      toast({
        variant: hits ? "default" : "destructive",
        title: hits ? `${hits} scanned, ${misses} unreadable` : "No code found",
        description: "Make sure the sticker is sharp and fills a good part of the photo.",
      });
    }
  }

  function exportMissing() {
    exportTable(
      "stocktake-missing",
      ["Tag", "Name", "Category", "Status", "Last verified"],
      remaining.map((a) => [a.asset_tag ?? "", a.name, catName(a.category), ASSET_STATUS_LABEL[a.status] ?? a.status, a.last_verified_time ? formatDate(a.last_verified_time.slice(0, 10)) : "never"]),
      "csv",
    );
  }

  // Closing freezes the numbers and the missing list, and asks the holders of missing kit to go and look. It
  // cannot be undone (another walk is another count), so it asks first and says what it is about to do.
  async function closeCount() {
    if (!session) return;
    const held = remaining.filter((a) => a.assigned_to).length;
    const ok = await confirm({
      title: `Close "${session.label}"?`,
      description:
        `${seen.length} of ${scope.length} sighted, ${remaining.length} missing. The result is frozen as it stands now and cannot be reopened` +
        (held ? `, and the ${held} missing item${held === 1 ? "" : "s"} that someone is holding will be notified to go and look.` : ".") +
        (remaining.length ? " Anything you have not scanned yet counts as missing." : ""),
      confirmLabel: "Close count",
    });
    if (!ok) return;
    setClosing(true);
    try {
      const updated = await invoke<Count>(session.path, "close");
      setCounts((prev) => prev.map((c) => (c.path === updated.path ? updated : c)));
      stopCamera();
      toast({ title: `Count closed: ${updated.result?.counts?.missing ?? 0} missing`, variant: "success" });
      setOpenPath(null);
      void reloadCounts();
      // The result is a record now, so hand them to the record: the page shows the frozen numbers, the missing
      // list, and what turns up afterwards.
      onClose();
      navigate(`stocktakes/${idOf(updated.path)}`);
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't close the count", description: (e as Error).message });
    } finally {
      setClosing(false);
    }
  }

  function pause() {
    stopCamera();
    onClose();
  }

  const presetLabel = session ? presetOf(session.scope) : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) pause();
      }}
    >
      {/* dvh, not vh: on a phone `vh` counts the space behind the browser's own chrome, so a 92vh overlay
          puts its header under the address bar and its footer under the tab bar. */}
      <div className="flex h-full max-h-[92dvh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border bg-background shadow-lg">
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <ScanLine className="h-5 w-5 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">{session ? session.label : "Stocktake"}</h2>
            <p className="truncate text-xs text-muted-foreground">
              {session
                ? `Started ${formatDate((session.start_time ?? "").slice(0, 10))} by ${empName(session.started_by)}${presetLabel ? ` · ${presetLabel}` : ""}. Scans keep saving as you go.`
                : "Scan each sticker you can physically see. What is left over is your missing list, and closing the count keeps it."}
            </p>
          </div>
          {/* The secondary actions drop to their glyph on a phone: the header is one line with a title in it,
              and three labelled buttons leave the count's name no room to be read at all. */}
          {session ? (
            <>
              <Button variant="ghost" size="sm" onClick={pause} aria-label="Pause" title="Leave the count open and come back to it"><PauseCircle className="h-4 w-4" /> <span className="hidden sm:inline">Pause</span></Button>
              <Button variant="outline" loading={closing} onClick={closeCount}><Flag className="h-4 w-4" /> <span className="hidden sm:inline">Close</span> count</Button>
            </>
          ) : (
            <Button variant="ghost" size="sm" aria-label="Past counts" onClick={() => { onClose(); navigate("stocktakes"); }}><History className="h-4 w-4" /> <span className="hidden sm:inline">Past counts</span></Button>
          )}
          <Button variant="ghost" size="sm" onClick={pause} aria-label="Close"><X className="h-4 w-4" /></Button>
        </div>

        {/* No count open: start one, or resume one. The closed ones are records and live on the Stocktakes
            page, which can also say what turned up after each count - something this tool cannot. */}
        {!session && (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {(
              <div className="mx-auto max-w-lg space-y-4">
                {open.length > 0 && (
                  <div className="rounded-lg border p-3">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Counts already open</div>
                    {open.map((c) => (
                      <div key={c.path} className="flex items-center gap-2 border-b py-2 text-sm last:border-b-0">
                        <span className="min-w-0 flex-1 truncate">{c.label}</span>
                        <span className="flex-shrink-0 text-xs text-muted-foreground">{empName(c.started_by)} · {formatDate((c.start_time ?? "").slice(0, 10))}</span>
                        <Button size="sm" variant="outline" onClick={() => setOpenPath(c.path)}><Play className="h-4 w-4" /> Resume</Button>
                      </div>
                    ))}
                    <p className="mt-2 text-[11px] text-muted-foreground">Anyone scanning into the same count adds to it, so a floor each is one count, not two.</p>
                  </div>
                )}
                <div className="space-y-3 rounded-lg border p-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Start a count</div>
                  <div>
                    <label className="mb-1 block text-xs text-muted-foreground" htmlFor="st-label">What to call it</label>
                    <Input id="st-label" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="e.g. Q3 2026 - Bengaluru office" />
                  </div>
                  <div>
                    <div className="mb-1 text-xs text-muted-foreground">What to count</div>
                    <Select value={newPreset} onValueChange={(v) => setNewPreset(v as ScopePresetId)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {SCOPE_PRESETS.map((p) => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <p className="mt-1 text-[11px] text-muted-foreground">{SCOPE_PRESETS.find((p) => p.id === newPreset)?.hint}</p>
                  </div>
                  <div>
                    <div className="mb-1 text-xs text-muted-foreground">Category</div>
                    <Select value={newCategory} onValueChange={setNewCategory}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All categories</SelectItem>
                        {categories.map((c) => <SelectItem key={c.path} value={c.path}>{c.display_name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button className="w-full" loading={starting} onClick={startCount}><Play className="h-4 w-4" /> Start counting</Button>
                  <p className="text-[11px] text-muted-foreground">The scope decides what the missing list means, so it is fixed once the count is closed.</p>
                </div>
                {/* Most counts repeat the last one. Say how the last one went and offer its scope in one click,
                    so a quarterly walk is comparable to the previous quarter instead of subtly re-cut. */}
                {lastCount && (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
                    <History className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      Last count <span className="font-medium">{lastCount.label}</span> closed {formatDate((lastCount.closed_time ?? "").slice(0, 10))}
                      {(lastCount.result?.counts?.missing ?? 0) > 0 ? `, ${lastCount.result!.counts!.missing} unfound.` : ", all accounted for."}
                    </span>
                    {repeatablePreset && (
                      <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => { setNewPreset(repeatablePreset); setNewCategory(lastCount.scope?.categories?.[0] ?? "all"); }}>
                        Repeat its scope
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {session && (
          // Scanner beside the count on a laptop, above it on a phone - which is also the device that
          // actually has the camera, so this is the layout that matters most here.
          <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
            <div className="flex w-full flex-shrink-0 flex-col gap-3 border-b p-4 lg:w-[340px] lg:border-b-0 lg:border-r">
              <div>
                {cameraState === "on" ? (
                  <ScanPreview scanner={scanner} />
                ) : (
                  <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed text-xs text-muted-foreground">
                    {cameraState === "unavailable" ? <CameraOff className="h-5 w-5" /> : <Camera className="h-5 w-5" />}
                    {cameraState === "unavailable" ? "Camera unavailable - upload a photo or use the input below" : "Camera is off"}
                  </div>
                )}
                {/* Nowrap button labels cannot be squeezed by `flex-1`; the row wraps instead of growing. */}
                <div className="mt-2 flex flex-wrap gap-2">
                  {cameraState === "on" ? (
                    <>
                      <Button size="sm" variant="outline" className="flex-1" onClick={stopCamera}><CameraOff className="h-4 w-4" /> Stop</Button>
                      <ScanPauseButton scanner={scanner} className="flex-1" />
                    </>
                  ) : (
                    <Button size="sm" variant="outline" className="flex-1" loading={cameraState === "starting"} onClick={() => void startCamera()}>
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
                      void uploadPhotos(e.target.files);
                      e.target.value = ""; // the same file can be re-picked
                    }}
                  />
                </div>
                {!hasNativeDetector() && (
                  <p className="mt-1 text-[11px] text-muted-foreground">This browser has no built-in scanner, so decoding happens in software - hold each sticker still for a moment.</p>
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

              {/* Condition rides along with the next sightings. Sticky rather than per item: a walk is mostly
                  "good", and the exception is what is worth a click. */}
              <div>
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Condition to record</div>
                <div className="flex gap-1">
                  {CONDITIONS.map((c) => (
                    <button
                      key={c.value}
                      className={cn(
                        "flex-1 rounded-md border px-2 py-1.5 text-[11px]",
                        condition === c.value ? "border-primary bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted",
                      )}
                      onClick={() => setCondition(c.value)}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
                {condition !== "good" && <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">Everything you sight next is recorded as {ASSET_CONDITION_LABEL[condition] ?? condition}.</p>}
              </div>

              <div className="mt-auto rounded-md border bg-muted/40 p-3 text-center">
                <div className="text-2xl font-semibold">{seen.length}<span className="text-base font-normal text-muted-foreground"> / {scope.length}</span></div>
                <div className="text-xs text-muted-foreground">sighted in this count</div>
                {(flagged > 0 || (session.found?.length ?? 0) > 0) && (
                  <div className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                    {flagged > 0 && `${flagged} flagged`}{flagged > 0 && (session.found?.length ?? 0) > 0 && " · "}{(session.found?.length ?? 0) > 0 && `${session.found!.length} unexpected`}
                  </div>
                )}
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
                        // Tag, name, one or two status chips and a button: more than a phone can hold on one
                        // line, and this list is read on a phone by definition - it is the device doing the
                        // scanning. The row wraps, and the name carries a real basis so the break can happen.
                        <div key={a.path} className="flex flex-wrap items-center gap-2 border-b py-1.5 text-xs last:border-b-0">
                          <span className="w-24 flex-shrink-0 truncate font-mono sm:w-28">{a.asset_tag ?? "-"}</span>
                          <span className="min-w-0 flex-1 basis-32 truncate">{a.name}</span>
                          {/* Missing in the previous count too: the difference between something walked past
                              and something actually gone. Worth chasing NOW, while a scanner is in hand. */}
                          {missedLastTime.has(a.path) && (
                            <span className="flex flex-shrink-0 items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive" title={`Also missing in ${lastCount?.label}`}>
                              <History className="h-3 w-3" /> missing last time
                            </span>
                          )}
                          {failed[a.path] ? (
                            <span className="flex flex-shrink-0 items-center gap-1 text-amber-600 dark:text-amber-400"><AlertTriangle className="h-3 w-3" /> {failed[a.path]}</span>
                          ) : (
                            <span className="flex-shrink-0 text-muted-foreground">{a.last_verified_time ? `last seen ${formatDate(a.last_verified_time.slice(0, 10))}` : "never verified"}</span>
                          )}
                          <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" title="Record it as sighted without scanning the tag - logged as an unscanned confirmation" onClick={() => recordSighting(a)}>Mark seen (no scan)</Button>
                        </div>
                      ))
                    )}
                  </div>
                </div>
                <div className="flex min-h-0 flex-col">
                  <div className="flex items-center gap-2 px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Sighted ({seen.length})
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
                    {sightedLog.length === 0 ? (
                      <p className="py-6 text-center text-xs text-muted-foreground">Scans land here as you go, and stay here if you come back later.</p>
                    ) : (
                      sightedLog.map((a) => (
                        <div key={a.path} className="flex flex-wrap items-center gap-2 border-b py-1.5 text-xs last:border-b-0">
                          <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-success" />
                          <span className="w-24 flex-shrink-0 truncate font-mono sm:w-28">{a.asset_tag ?? "-"}</span>
                          <span className="min-w-0 flex-1 basis-32 truncate">{a.name}</span>
                          {/* A sighting that also SETTLED something is worth calling out: it moved the asset
                              from "we think we have it" to counted stock. */}
                          {checkedIn.includes(a.path) && <span className="flex flex-shrink-0 items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success"><BadgeCheck className="h-3 w-3" /> checked in</span>}
                          {a.condition && a.condition !== "good" && <span className="flex-shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-600 dark:text-amber-400">{ASSET_CONDITION_LABEL[a.condition] ?? a.condition}</span>}
                          {/* A ticked-off row and a scanned one are not the same evidence, and the list says so. */}
                          {a.last_verified_scanned === false && <span className="flex-shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">no scan</span>}
                          <span className="flex-shrink-0 text-muted-foreground">{a.last_verified_by ? empName(a.last_verified_by) : ""}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
              {/* Kit that is here but not in the inventory. Nothing else in the app can surface this. */}
              {(session.found?.length ?? 0) > 0 && (
                <div className="max-h-32 overflow-y-auto border-t px-4 py-2">
                  <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><PackageSearch className="h-3.5 w-3.5" /> Found, not in the inventory ({session.found!.length})</div>
                  {session.found!.map((f, i) => (
                    <div key={`${f.scan_time}-${i}`} className="flex items-center gap-2 py-0.5 text-xs">
                      <span className="min-w-0 flex-1 truncate font-mono">{f.raw || f.note}</span>
                      <span className="flex-shrink-0 text-muted-foreground">{empName(f.by)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
