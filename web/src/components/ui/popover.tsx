import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn } from "@/lib/utils";
// Every popover is portaled to <body>, which puts it outside the scroll lock of any dialog it was opened
// from - and that lock cancels the wheel over everything it considers outside. See the hook.
import { useWheelScrollFallback } from "@/hooks/useWheelScrollFallback";

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "start", sideOffset = 6, ...props }, ref) => {
  // State, not a ref: the content node exists only while the popover is open, and the fallback below has to
  // re-run when it appears. Whatever ref the caller passed is forwarded the same node.
  const [content, setContent] = React.useState<HTMLDivElement | null>(null);
  useWheelScrollFallback(content);
  const setRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      setContent(node);
      if (typeof ref === "function") ref(node);
      else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
    },
    [ref],
  );

  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={setRef}
        align={align}
        sideOffset={sideOffset}
        // Keep clear of the screen edges and flip/shift rather than overflow. A w-64 popover anchored to a
        // right-aligned control on a 390px screen otherwise hangs off the edge with half its content cut off.
        collisionPadding={12}
        className={cn(
          "z-50 max-h-[var(--radix-popover-content-available-height)] w-64 max-w-[calc(100vw-1.5rem)] overflow-y-auto overscroll-contain rounded-lg border bg-popover p-3 text-popover-foreground shadow-md outline-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
});
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
