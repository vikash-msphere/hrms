import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// A small "i" icon that reveals explanatory text on hover, focus, or - via `tapToOpen`, which turns it into a
// popover on a coarse pointer - a tap. Use it to keep helper copy out of the layout (so dense forms stay
// short) while still being one gesture away. Its text has no other home, which is exactly the case
// `tapToOpen` exists for: without it this button did nothing at all on a phone.
//
// The glyph stays 14px (it sits inline in a label and a bigger one would shout) but the BOX grows to the
// 36px floor on a finger - the same `min-height`/`min-width` treatment index.css gives every other small
// icon control, rather than a negative margin that would overlap the label beside it and steal its taps.
export function InfoHint({ text, className }: { text: string; className?: string }) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip tapToOpen>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="More information"
            className={cn(
              "inline-flex items-center justify-center align-middle coarse:min-h-9 coarse:min-w-9",
              className,
            )}
          >
            <Info className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs font-normal leading-snug">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
