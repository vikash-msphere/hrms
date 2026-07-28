import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

// A small "i" icon that reveals explanatory text on hover/focus. Use it to keep helper copy out of the
// layout (so dense forms stay short) while still being one hover away.
export function InfoHint({ text, className }: { text: string; className?: string }) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" aria-label="More information" className={className}>
            <Info className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs font-normal leading-snug">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
