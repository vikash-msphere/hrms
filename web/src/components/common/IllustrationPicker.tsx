import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ImageOff, Search } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { illustrationScore, illustrationUrl, loadIllustrationIndex, type IllustrationMeta } from "@/lib/illustrations";

// Browse/search the bundled unDraw set (see web/public/assets/illustrations/README.md) and pick one.
// index.json is fetched the first time any picker opens and cached module-wide by loadIllustrationIndex, so the
// 1700-entry catalogue never weighs on page load.
//
// The grid is never the whole set at once: it pages in PAGE at a time and every thumbnail is loading="lazy", so
// opening the dialog costs one screenful of art no matter how large the set gets.

const PAGE = 60;
const ALL = "__all__";
// The pinned set is selectable as its own category, so choosing a category always decides the whole grid.
const PINNED = "__pinned__";

const humanise = (dir: string) => dir.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());

export type PinnedArt = { value: string; label: string; url: string };

export function IllustrationPicker({
  value,
  onPick,
  children,
  title = "Choose an illustration",
  clearLabel,
  clearHint,
  pinned,
  pinnedLabel = "Stickers",
  pinnedHint,
  pinnedClassName,
}: {
  value?: string | null; // current selection, highlighted in whichever group holds it
  onPick: (path: string | null) => void; // null = cleared
  children: ReactNode; // trigger
  title?: string;
  // Leading "pick nothing" tile. Omit the label and there is no tile - for callers that clear from outside the
  // dialog, where a tile in here would be a second way to say the same thing.
  clearLabel?: string;
  clearHint?: string; // one-liner under it, e.g. what the fallback will be
  // An in-house set shown ABOVE the catalogue, for callers whose own artwork should be the first choice and the
  // 1700-strong general set the fallback - the kudos composer being the case in point.
  pinned?: PinnedArt[];
  pinnedLabel?: string;
  pinnedHint?: string;
  pinnedClassName?: string; // extra classes for pinned thumbnails (the kudos stickers want their dark-mode backing)
}) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState<IllustrationMeta[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<string>(ALL);
  const [limit, setLimit] = useState(PAGE);
  const gridRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);
  // Read at open time only. Kept in refs rather than effect deps: callers build `pinned` inline, so its identity
  // changes on every parent render, and depending on it would reset the browsing state under the user.
  const valueRef = useRef(value);
  const pinnedRef = useRef(pinned);
  valueRef.current = value;
  pinnedRef.current = pinned;

  useEffect(() => {
    if (!open || index) return;
    let live = true;
    setFailed(false);
    loadIllustrationIndex().then(
      (rows) => live && setIndex(rows),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [open, index]);

  // Open showing everything, with the current pick's own category preselected when there is one - so "Change art"
  // lands next to what is already chosen instead of at the top of 1700 unrelated illustrations.
  useEffect(() => {
    if (!open) return;
    // Land on whichever category holds the current pick, so "Change art" opens next to it: the pinned set when it
    // is one of those, else its `<category>/<slug>` directory, else everything. A pinned value has no slash, so
    // treating it as a path would filter the catalogue down to nothing.
    const v = valueRef.current;
    const inPinned = !!v && (pinnedRef.current ?? []).some((p) => p.value === v);
    setCategory(inPinned ? PINNED : (v?.includes("/") ? v.split("/")[0] : "") || ALL);
    setQ("");
    setLimit(PAGE);
    // Deliberately only `open`: this is the open-time reset, not a sync. Anything else here would yank the
    // category or the search term away while the user is browsing.
  }, [open]);

  // Bring the current pick into view once the grid has it.
  useEffect(() => {
    if (open && index) selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [open, index, category]);

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of index ?? []) counts.set(m.dir, (counts.get(m.dir) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [index]);

  const term = q.trim().toLowerCase();
  const shownPinned = useMemo(() => {
    // Off entirely once a real illustration category is picked - a section that ignored the filter would leave the
    // grid showing things the category does not contain.
    if (!term && category !== ALL && category !== PINNED) return [];
    return (pinned ?? []).filter((p) => !term || p.label.toLowerCase().includes(term) || p.value.toLowerCase().includes(term));
  }, [pinned, term, category]);
  const shown = useMemo(() => {
    if (!index) return [];
    // Searching looks across the whole set - narrowing by category at the same time hides matches for no reason.
    if (term) {
      return index
        .map((m) => ({ m, s: illustrationScore(m, term) }))
        .filter((r) => r.s >= 0)
        .sort((a, b) => a.s - b.s || a.m.title.localeCompare(b.m.title))
        .map((r) => r.m);
    }
    if (category === PINNED) return [];
    return category === ALL ? index : index.filter((m) => m.dir === category);
  }, [index, term, category]);

  useEffect(() => setLimit(PAGE), [term, category]);

  function pick(path: string | null) {
    onPick(path);
    setOpen(false);
  }

  // Arrow keys walk the grid; the column count comes from the resolved grid template, so it stays right across
  // breakpoints without hardcoding it. Tab/Enter/Escape are native, since every tile is a real button.
  function onGridKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
    if (!keys.includes(e.key)) return;
    const grid = gridRef.current;
    if (!grid) return;
    const tiles = [...grid.querySelectorAll<HTMLButtonElement>("[data-tile]")];
    const at = tiles.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    const cols = getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length || 1;
    const to =
      e.key === "ArrowLeft" ? at - 1 : e.key === "ArrowRight" ? at + 1 : e.key === "ArrowUp" ? at - cols : e.key === "ArrowDown" ? at + cols : e.key === "Home" ? 0 : tiles.length - 1;
    tiles[Math.max(0, Math.min(tiles.length - 1, to))]?.focus();
  }

  const tileClass = "flex flex-col items-center gap-1 rounded-lg border p-2 text-center transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        {/* Controls stay put while the grid scrolls under them. */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search all illustrations…" className="pl-8" autoFocus />
          </div>
          <Select value={category} onValueChange={setCategory} disabled={!!term || !index}>
            <SelectTrigger className="sm:w-56">
              <SelectValue placeholder="All categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All categories</SelectItem>
              {pinned && pinned.length > 0 && (
                <SelectItem value={PINNED}>
                  {pinnedLabel} <span className="text-muted-foreground">({pinned.length})</span>
                </SelectItem>
              )}
              {categories.map(([dir, n]) => (
                <SelectItem key={dir} value={dir}>
                  {humanise(dir)} <span className="text-muted-foreground">({n})</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <p className="text-xs text-muted-foreground" aria-live="polite">
          {!index
            ? "Loading…"
            : term
              ? // Stickers count as matches too, or a search that hits only those would read "0 matches" with tiles on screen.
                `${shown.length + shownPinned.length} match${shown.length + shownPinned.length === 1 ? "" : "es"} for “${q.trim()}”`
              : category === PINNED
                ? `${shownPinned.length} ${pinnedLabel.toLowerCase()}`
                : `${shown.length} illustration${shown.length === 1 ? "" : "s"}${category === ALL ? "" : ` in ${humanise(category)}`}${shown.length > limit ? ` · showing ${limit}` : ""}`}
        </p>

        <div className="-mx-1 min-h-[18rem] flex-1 overflow-y-auto px-1">
          {failed ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Couldn&apos;t load the illustration list.{" "}
              <button type="button" className="underline" onClick={() => { setFailed(false); setIndex(null); }}>
                Retry
              </button>
            </p>
          ) : !index ? (
            <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
          ) : (
            <>
              {shownPinned.length > 0 && (
                <div className="mb-4">
                  <p className="mb-1.5 flex items-baseline gap-2 text-xs font-medium">
                    {pinnedLabel}
                    {pinnedHint && <span className="font-normal text-muted-foreground">{pinnedHint}</span>}
                  </p>
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5" onKeyDown={onGridKeyDown} role="group" aria-label={pinnedLabel}>
                    {shownPinned.map((pin) => {
                      const selected = pin.value === value;
                      return (
                        <button
                          data-tile
                          key={pin.value}
                          type="button"
                          ref={selected ? selectedRef : undefined}
                          onClick={() => pick(pin.value)}
                          aria-pressed={selected}
                          className={cn(tileClass, "relative", selected ? "border-primary ring-2 ring-primary" : "border-transparent")}
                        >
                          <img src={pin.url} alt="" aria-hidden loading="lazy" className={cn("h-20 w-full select-none object-contain", pinnedClassName)} />
                          <span className="w-full truncate text-xs font-medium">{pin.label}</span>
                          {selected && (
                            <span className="absolute right-1 top-1 rounded-full bg-primary p-0.5 text-primary-foreground">
                              <Check className="h-3 w-3" />
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {shownPinned.length > 0 && shown.length > 0 && <p className="mb-1.5 text-xs font-medium">Illustrations <span className="font-normal text-muted-foreground">the general set</span></p>}
              <div ref={gridRef} className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5" onKeyDown={onGridKeyDown} role="group" aria-label="Illustrations">
                {/* Picking nothing is a choice like any other, so when the caller wants it offered it leads the grid
                    rather than hiding in a stray Clear button - and it says what happens instead. */}
                {clearLabel && (
                  <button
                    data-tile
                    type="button"
                    onClick={() => pick(null)}
                    ref={!value ? selectedRef : undefined}
                    className={cn(tileClass, !value ? "border-primary ring-2 ring-primary" : "border-dashed")}
                  >
                    <span className="flex h-20 w-full items-center justify-center">
                      <ImageOff className="h-6 w-6 text-muted-foreground" aria-hidden />
                    </span>
                    <span className="w-full truncate text-xs font-medium">{clearLabel}</span>
                    {clearHint && <span className="w-full truncate text-[11px] text-muted-foreground">{clearHint}</span>}
                  </button>
                )}

                {shown.slice(0, limit).map((m) => {
                  const path = `${m.dir}/${m.slug}`;
                  const selected = path === value;
                  return (
                    <button
                      data-tile
                      key={path}
                      type="button"
                      ref={selected ? selectedRef : undefined}
                      onClick={() => pick(path)}
                      aria-pressed={selected}
                      className={cn(tileClass, "relative", selected ? "border-primary ring-2 ring-primary" : "border-transparent")}
                    >
                      <img src={illustrationUrl(path)} alt="" aria-hidden loading="lazy" className="h-20 w-full select-none object-contain" />
                      <span className="w-full truncate text-xs font-medium">{m.title}</span>
                      <span className="w-full truncate text-[11px] text-muted-foreground">{humanise(m.dir)}</span>
                      {selected && (
                        <span className="absolute right-1 top-1 rounded-full bg-primary p-0.5 text-primary-foreground">
                          <Check className="h-3 w-3" />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {shown.length === 0 && shownPinned.length === 0 && (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  Nothing matches “{q.trim()}”. Try a plainer word - the set is titled in everyday language ({humanise("celebration-recognition")}, Teamwork, Payday).
                </p>
              )}

              {shown.length > limit && (
                <div className="pt-3 text-center">
                  <Button variant="outline" size="sm" onClick={() => setLimit((n) => n + PAGE)}>
                    Show {Math.min(PAGE, shown.length - limit)} more
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
