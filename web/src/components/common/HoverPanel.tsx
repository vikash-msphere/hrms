import * as React from "react";
import { cn } from "@/lib/utils";
import { useMedia } from "@/hooks/useMedia";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";

/**
 * A panel that opens on hover and whose contents can be CLICKED.
 *
 * Deliberately not a `<Tooltip>`. A tooltip is an annotation: it is announced through `aria-describedby`, it
 * is not focusable, and anything interactive inside it is unreachable by keyboard - so a list of links in one
 * is a dead end for anybody not using a mouse. This is a Popover, which has real focus and dismiss behaviour,
 * driven by hover rather than by click.
 *
 * Focus is NOT pulled into the panel on open (`onOpenAutoFocus` prevented): it appears under a pointer that
 * is merely passing through, and stealing the caret from whatever the reader was doing would be worse than
 * the panel is useful. Tab still reaches the contents, because they are in the DOM and focusable.
 *
 * On a COARSE pointer it never opens on hover: a tap would both open the panel and fire the trigger's own
 * action. There the trigger just does its job (the direct-reports cell goes to the org chart, which names
 * everyone anyway).
 */
export function HoverPanel({
  content,
  children,
  className,
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const coarse = useMedia("(pointer: coarse)");
  const [open, setOpen] = React.useState(false);
  const timer = React.useRef<number | null>(null);

  const cancel = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  React.useEffect(() => cancel, []);

  // Opening is delayed so a pointer crossing the cell on its way elsewhere never flashes a panel. Closing is
  // delayed too, and that delay is the whole reason this works: it is the grace period in which the pointer
  // travels the gap from the trigger to the panel without the panel disappearing under it.
  const openSoon = () => {
    if (coarse) return;
    cancel();
    timer.current = window.setTimeout(() => setOpen(true), 150);
  };
  const closeSoon = () => {
    cancel();
    timer.current = window.setTimeout(() => setOpen(false), 140);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <span
          className={cn("inline-flex min-w-0 max-w-full", className)}
          onPointerEnter={openSoon}
          onPointerLeave={closeSoon}
          // Keyboard parity: the trigger is focusable, so focusing it offers the same panel a hover does.
          onFocus={() => !coarse && setOpen(true)}
          onBlur={closeSoon}
        >
          {children}
        </span>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="w-auto min-w-[200px] max-w-[280px] p-2"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onPointerEnter={cancel}
        onPointerLeave={closeSoon}
      >
        {content}
      </PopoverContent>
    </Popover>
  );
}
