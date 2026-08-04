import { Check, ImagePlus, Move, Scaling, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { IllustrationPicker, type PinnedArt } from "@/components/common/IllustrationPicker";
import { isKudosSticker, kudosArtLabel, kudosCardArtUrl, ART_DIECUT_SM } from "@/lib/kudosArt";
import { DEFAULT_WRAP, MAX_STICKER_SIZE, MIN_STICKER_SIZE, withWrap } from "@/components/common/CardSticker";
import { FoldSection } from "@/components/common/FoldSection";
import { WrapSelect } from "@/components/common/WrapSelect";
import type { StickerLayout } from "@/types";

// The sticker control for the board composer: a short row of the art most worth offering right now, and beside it
// the two dials that decide how it reads - how big, and how strongly. Every post kind uses it, because an
// announcement, a post, a poll and a kudos all carry the same optional picture.
//
// What fills the row is the caller's business and differs by kind: a kudos offers the stickers configured on the
// chosen category, everything else offers art matched against what the author has typed (see
// suggestIllustrations). Either way the row is a shortcut, never the whole choice - "Browse" opens the 1700-item
// picker, and whatever is picked there takes the place of a suggestion so the two can be compared.
//
// Placement is not a mode to opt into: a sticker always has a position, and it is always adjustable. Size and
// opacity live here; moving and resizing happen on the sticker itself in the preview, which is the only place
// they can honestly be shown.
//
// The whole panel is folded by default. A picture is optional on every kind and the words come first, so this
// asks for nothing until someone wants it - and what is on the card is never in doubt while it is shut, because
// the header names the current art and the preview shows it. Removing stays in the header, since taking a
// picture off should not require opening the thing that put it there.

// "good-job.png" -> "Good job"; "celebration-recognition/high-five" -> "High five".
export const stickerLabel = (value: string) =>
  isKudosSticker(value) ? kudosArtLabel(value) : (value.split("/")[1] ?? value).replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());

/** How many suggestions the row offers before the Browse tile. */
const TILES = 3;

export function StickerField({
  value,
  onChange,
  artUrl,
  layout,
  onLayoutChange,
  suggestions,
  onResetLayout,
  loading,
  label = "Sticker",
  emptyHint,
  pickerTitle = "Choose a sticker",
  pinned,
  pinnedLabel,
  pinnedHint,
  narrow,
  defaultOpen,
}: {
  value: string; // the chosen art; "" = no picture on the card, on any kind
  onChange: (value: string) => void;
  artUrl: string; // what the card actually shows ("" = nothing)
  layout: StickerLayout; // always present - a sticker on a card always has a placement
  onLayoutChange: (layout: StickerLayout) => void;
  suggestions: string[]; // art to offer as tiles, best first
  onResetLayout?: () => void; // present once the author has placed it themselves - puts the card back to default
  loading?: boolean; // suggestions still being worked out - show placeholders rather than an empty row
  label?: string;
  emptyHint?: string;
  pickerTitle?: string;
  pinned?: PinnedArt[]; // an in-house set to show above the catalogue in the browse dialog
  pinnedLabel?: string;
  pinnedHint?: string;
  // Stack the tiles above the dials instead of putting them side by side. The side-by-side layout keys off the
  // VIEWPORT (`sm:`), which is the wrong question when this sits in a fixed-width column of a wide dialog: the
  // viewport is wide, the column is not. The caller knows which it is.
  narrow?: boolean;
  defaultOpen?: boolean;
}) {
  // The current pick always has a tile, even when it is not one of the suggestions (picked from the catalogue, or
  // suggested by earlier wording that has since been edited away) - otherwise choosing it would make it vanish.
  const tiles = (value && !suggestions.includes(value) ? [value, ...suggestions] : suggestions).slice(0, TILES);

  const tileClass =
    "group relative flex aspect-square w-full items-center justify-center rounded-xl border bg-muted/30 p-1.5 transition-all hover:-translate-y-0.5 hover:bg-muted hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  const slider = (name: string, key: "size" | "opacity", min: number, max: number, step: number) => (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="w-12 shrink-0">{name}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={layout[key]}
        onChange={(e) => onLayoutChange({ ...layout, [key]: Number(e.target.value) })}
        className="w-full accent-primary"
        aria-label={`Sticker ${name.toLowerCase()}`}
      />
      <span className="w-8 shrink-0 text-right tabular-nums">{Math.round(layout[key] * 100)}%</span>
    </label>
  );

  return (
    <FoldSection
      title={label}
      defaultOpen={defaultOpen}
      // Shut, the header says what is on the card; open, the tiles do.
      summary={value ? stickerLabel(value) : "None"}
      // Reset appears only once the author has moved the picture off the card's own layout, which is the only
      // time there is anything to go back to.
      actions={
        <>
          {onResetLayout && (
            <button type="button" onClick={onResetLayout} className="underline underline-offset-2 hover:text-foreground">
              Reset
            </button>
          )}
          {value && (
            <button type="button" onClick={() => onChange("")} className="flex items-center gap-1 hover:text-foreground">
              <X className="h-3 w-3" /> Remove
            </button>
          )}
        </>
      }
    >
        <div className={cn("flex flex-col gap-3", !narrow && "sm:flex-row sm:items-start")}>
          {/* Four fixed 92px tiles once there is room for them; full width on a phone (or in a narrow column). */}
          <div className={cn("grid w-full grid-cols-4 gap-2", !narrow && "sm:w-auto sm:shrink-0 sm:grid-cols-[repeat(4,92px)]")}>
            {tiles.map((art) => {
              const on = value === art;
              const name = stickerLabel(art);
              return (
                <button
                  key={art}
                  type="button"
                  // Clicking the chosen tile again clears it, so every tile toggles rather than only selects.
                  onClick={() => onChange(on ? "" : art)}
                  title={on ? `${name} - click again to remove` : name}
                  aria-label={name}
                  aria-pressed={on}
                  className={cn(tileClass, on ? "border-primary ring-2 ring-primary" : "border-border")}
                >
                  <img
                    src={kudosCardArtUrl(art)}
                    alt=""
                    aria-hidden
                    loading="lazy"
                    className={cn("h-full w-full select-none object-contain", ART_DIECUT_SM)}
                    onError={(e) => { e.currentTarget.style.visibility = "hidden"; }}
                  />
                  {on && (
                    <span className="absolute right-1 top-1 rounded-full bg-primary p-0.5 text-primary-foreground">
                      <Check className="h-3 w-3" />
                    </span>
                  )}
                </button>
              );
            })}
  
            {/* Placeholders while the catalogue loads, so the row keeps its height instead of the form jumping when
                the suggestions arrive. */}
            {loading && tiles.length === 0 && [0, 1, 2].map((i) => <div key={i} className="aspect-square w-full animate-pulse rounded-xl bg-muted" />)}
  
            <IllustrationPicker
              value={value || null}
              onPick={(p) => onChange(p ?? "")}
              title={pickerTitle}
              clearLabel="No sticker"
              pinned={pinned}
              pinnedLabel={pinnedLabel}
              pinnedHint={pinnedHint}
            >
              <button type="button" title="Browse all art" className={cn(tileClass, "flex-col gap-1 border-dashed text-muted-foreground hover:text-foreground")}>
                <ImagePlus className="h-4 w-4" />
                <span className="text-[10px] font-medium leading-none">Browse</span>
              </button>
            </IllustrationPicker>
          </div>
  
          {/* The dials sit level with the tiles: choosing the picture and tuning it are one decision. */}
          <div className="w-full min-w-0 flex-1 space-y-3">
            {artUrl ? (
              <>
                <WrapSelect value={layout.wrap ?? DEFAULT_WRAP} onChange={(w) => onLayoutChange(withWrap(layout, w))} />
                {slider("Size", "size", MIN_STICKER_SIZE, MAX_STICKER_SIZE, 0.01)}
                {slider("Opacity", "opacity", 0.05, 1, 0.05)}
                <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 pt-0.5 text-xs text-muted-foreground">
                  You can
                  <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-medium text-foreground"><Move className="h-3 w-3" /> move</span>
                  and
                  <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-medium text-foreground"><Scaling className="h-3 w-3" /> resize</span>
                  it in the preview.
                </p>
              </>
            ) : (
              <p className="pt-1 text-xs text-muted-foreground">{emptyHint ?? "Optional. Sits behind your words - pick one and place it where you like."}</p>
            )}
          </div>
        </div>
    </FoldSection>
  );
}
