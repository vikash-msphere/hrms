import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn } from "@/lib/utils";
import { useMedia } from "@/hooks/useMedia";

// A tooltip, and the `tapToOpen` escape hatch for the ones a finger has to be able to read.
//
// A Radix tooltip is a HOVER surface: it opens on pointer-enter and focus, and a touch is neither. Radix goes
// further and treats `pointerdown` as a dismissal, so on a phone tapping the trigger is the one gesture
// guaranteed NOT to show it.
//
// For most tooltips here that is correct and should stay that way: the trigger is a button, the tooltip
// repeats what the button does, and the tap must run the action rather than explain it. Making every tooltip
// tap-openable would give those triggers two jobs on one tap - mark the goal complete AND pop up the word
// "Mark complete".
//
// `tapToOpen` marks the other kind: a tooltip that carries the only copy of something, hanging off a trigger
// that does nothing else - a column's policy text, why a budget alert fired, what a timeline colour means,
// every `InfoHint`. On a coarse pointer those render as a Popover instead: same content, same placement,
// opened by a tap and dismissed by a tap outside or Escape. The choice is made by the input device, not the
// screen width - a touch laptop at 1440px needs it too.
//
// Focus is deliberately NOT moved into the popover on open: this is an annotation, not a dialog, and pulling
// the caret out of the form the reader is filling in to show them a sentence would cost more than it gives.

const TooltipProvider = TooltipPrimitive.Provider;

/** True when the surrounding <Tooltip> resolved to the tap-driven (Popover) form. */
const TouchContext = React.createContext(false);

function Tooltip({
  children,
  tapToOpen = false,
  ...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Root> & {
  /** Also open on tap, for a tooltip whose text exists nowhere else and whose trigger has no other action. */
  tapToOpen?: boolean;
}) {
  const touch = useMedia("(pointer: coarse)");
  if (!touch || !tapToOpen) return <TooltipPrimitive.Root {...props}>{children}</TooltipPrimitive.Root>;
  // `delayDuration` / `disableHoverableContent` are hover concepts; Popover has no use for them.
  const { open, defaultOpen, onOpenChange } = props;
  return (
    <TouchContext.Provider value>
      <PopoverPrimitive.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
        {children}
      </PopoverPrimitive.Root>
    </TouchContext.Provider>
  );
}

const TooltipTrigger = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger>
>((props, ref) => {
  const touch = React.useContext(TouchContext);
  return touch ? <PopoverPrimitive.Trigger ref={ref} {...props} /> : <TooltipPrimitive.Trigger ref={ref} {...props} />;
});
TooltipTrigger.displayName = TooltipPrimitive.Trigger.displayName;

// Stay off the screen edges rather than being clipped by them. Several tooltips here explain a whole rule
// ("Exact-geometry PDF - immune to print-dialog rescaling"), and a tooltip has no intrinsic width limit: left
// alone it lays that sentence out as one line, which on a phone runs past the viewport with the end of the
// sentence - the part that matters - off screen.
const CONTENT =
  "z-50 max-w-[min(18rem,calc(100vw-1.5rem))] overflow-hidden rounded-md bg-foreground px-2.5 py-1.5 text-xs font-medium text-background shadow-md data-[state=delayed-open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=delayed-open]:fade-in-0 data-[state=open]:animate-in data-[state=open]:fade-in-0";

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => {
  const touch = React.useContext(TouchContext);
  if (touch) {
    return (
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          ref={ref as React.Ref<HTMLDivElement>}
          sideOffset={sideOffset}
          collisionPadding={12}
          onOpenAutoFocus={(e) => e.preventDefault()}
          className={cn(CONTENT, className)}
          {...(props as React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>)}
        />
      </PopoverPrimitive.Portal>
    );
  }
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        collisionPadding={12}
        className={cn(CONTENT, className)}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
});
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
