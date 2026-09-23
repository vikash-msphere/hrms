import { cn } from "@/lib/utils";
import { WRAP_LABELS } from "@/components/common/CardSticker";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { WrapMode } from "@/types";

// How the words treat something standing on a card - the word-processor wrap modes, as one control.
//
// A labelled row with the menu on it, the same shape as the Size and Opacity rows it sits with: one control is
// not worth a disclosure, and a menu that says what it is set to needs no summary beside it. Used for every
// placeable thing (a post's sticker, a kudos card's art, a kudos card's recipient), so they are one control
// rather than three that drift.

/** Just the menu, unlabelled. For a caller whose own heading already says what it is for. */
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
  return (
    <div className={cn("flex min-w-0 items-center gap-2 text-xs text-muted-foreground", className)}>
      <span className="w-12 shrink-0">{label}</span>
      <WrapPicker value={value} onChange={onChange} className="w-full" />
    </div>
  );
}
