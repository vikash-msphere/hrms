import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { WRAP_LABELS } from "@/components/common/CardSticker";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { WrapMode } from "@/types";

// How the words treat something standing on a card - the word-processor wrap modes, as one folded control.
//
// Folded because the default is right nearly every time: a picture the words flow around is what a card means by
// a picture, and an author who has not thought about wrapping should not have to. Unfolding is for the one who
// has. The chosen mode stays on the button, so folding puts away the CONTROL and never the answer - nobody has to
// open it to find out what a card is doing.
//
// Used for all three placeable things (a post's sticker, a kudos card's art, a kudos card's recipient), so they
// are one control rather than three that drift.

/** The mode's name, for a header that has to say what something is set to without being opened. */
export const wrapLabel = (value: WrapMode) => WRAP_LABELS.find((w) => w.value === value)?.label ?? "";

/** Just the menu. For a caller that already has a disclosure of its own and only needs what goes inside it. */
export function WrapPicker({ value, onChange, className }: { value: WrapMode; onChange: (wrap: WrapMode) => void; className?: string }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as WrapMode)}>
      <SelectTrigger className={cn("h-7 w-56 max-w-full text-xs", className)}><SelectValue /></SelectTrigger>
      <SelectContent>
        {WRAP_LABELS.map((w) => <SelectItem key={w.value} value={w.value}>{w.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

export function WrapSelect({
  value,
  onChange,
  label = "Wrap",
  className,
}: {
  value: WrapMode;
  onChange: (wrap: WrapMode) => void; // the caller applies withWrap - only it knows the placement being changed
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false); // per instance, so every composer opens folded
  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-2", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="shrink-0">{label}</span>
        {/* Folded, the button carries the answer; open, the select beside it does, and saying it twice only
            invites the reader to check whether the two agree. */}
        {!open && <span className="truncate font-medium text-foreground/80">{wrapLabel(value)}</span>}
      </button>
      {open && <WrapPicker value={value} onChange={onChange} />}
    </div>
  );
}
