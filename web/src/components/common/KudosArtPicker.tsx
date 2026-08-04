import { useState } from "react";
import { Check, ImageOff } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { ART_DIECUT_SM, KUDOS_ART_FILES, kudosArtFiles, kudosArtLabel, kudosArtUrl } from "@/lib/kudosArt";

// Pick the stickers a kudos category offers (settings/kudos `art`). Multi-select: choosing that category while
// writing a kudos puts one of them on the card, picked at random from the set, so a category's cards vary instead
// of the wall repeating one image - and the giver can swap or remove it from there. The set is small and every
// sticker carries its own slogan, so this is a plain grid of the artwork rather than a searchable catalogue - the
// picture IS the label. Sits beside the category's IconPicker.

const MAX_PREVIEW = 3; // thumbnails stacked on the trigger before it switches to a count

export function KudosArtPicker({
  value,
  onChange,
  className,
}: {
  value?: string[];
  onChange: (files: string[]) => void; // [] clears
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = kudosArtFiles(value);

  // Order follows KUDOS_ART_FILES rather than click order, so the set reads the same as the grid and the hash
  // lands on the same sticker regardless of the order they were picked in.
  function toggle(file: string) {
    const next = selected.includes(file) ? selected.filter((f) => f !== file) : [...selected, file];
    onChange(KUDOS_ART_FILES.filter((f) => next.includes(f)));
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={selected.length ? `Stickers: ${selected.map(kudosArtLabel).join(", ")}` : "Pick stickers"}
          title={selected.length ? selected.map(kudosArtLabel).join(" · ") : "No stickers - a new kudos in this category starts with no image"}
          className={cn("flex h-9 min-w-12 shrink-0 items-center justify-center gap-0.5 rounded-md border bg-background px-1 hover:bg-accent", className)}
        >
          {selected.length === 0 ? (
            <ImageOff className="h-4 w-4 text-muted-foreground" />
          ) : (
            <>
              {selected.slice(0, MAX_PREVIEW).map((f) => (
                <img key={f} src={kudosArtUrl(f)} alt="" aria-hidden className={cn("h-7 w-6 object-contain", ART_DIECUT_SM)} onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} />
              ))}
              {selected.length > MAX_PREVIEW && <span className="text-[10px] tabular-nums text-muted-foreground">+{selected.length - MAX_PREVIEW}</span>}
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" align="start">
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <p className="text-xs font-medium">Category stickers</p>
          {selected.length > 0 && (
            <button type="button" className="text-xs text-muted-foreground underline" onClick={() => onChange([])}>
              Clear all
            </button>
          )}
        </div>
        <div className="grid max-h-64 grid-cols-3 gap-1 overflow-y-auto">
          {KUDOS_ART_FILES.map((f) => {
            const on = selected.includes(f);
            return (
              <button
                key={f}
                type="button"
                onClick={() => toggle(f)}
                title={kudosArtLabel(f)}
                aria-pressed={on}
                className={cn("relative rounded-md border p-1 hover:bg-accent", on ? "border-primary ring-1 ring-primary" : "border-transparent")}
              >
                <img src={kudosArtUrl(f)} alt={kudosArtLabel(f)} loading="lazy" className={cn("h-16 w-full object-contain", ART_DIECUT_SM)} />
                {on && (
                  <span className="absolute right-0.5 top-0.5 rounded-full bg-primary p-0.5 text-primary-foreground">
                    <Check className="h-2.5 w-2.5" />
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
          {selected.length > 1
            ? `${selected.length} picked - a new kudos in this category starts with one of them at random.`
            : "A new kudos in this category starts with this sticker; the giver can swap or remove it. Pick more than one to vary them."}
        </p>
      </PopoverContent>
    </Popover>
  );
}
