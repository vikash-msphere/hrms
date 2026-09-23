import * as React from "react";
import { TabsTrigger } from "@/components/ui/tabs";
import { AccessTarget } from "@/components/access/AccessTarget";
import type { AccessTargetRef } from "@/components/access/AccessModeProvider";

// A tab trigger that carries its own access-control affordance: in access-management mode a small "manage
// permissions" key sits right on the tab (for the collection that tab edits), instead of floating loose in
// the tab bar or living on a separate page heading. The icon is kept as a SIBLING of the trigger (not nested)
// because both are <button>s - nesting buttons is invalid; the wrapper groups them so the key reads as part
// of the tab. When access mode is off, AccessTarget renders nothing and this is just a plain trigger.
export function AccessTab({
  value,
  target,
  children,
  className,
}: {
  value: string;
  target: AccessTargetRef;
  children: React.ReactNode;
  className?: string;
}) {
  // The key is OVERLAID on the tab's trailing edge rather than laid out after it: an in-flow icon widened
  // every tab the moment the mode turned on, which re-flowed the whole tab bar (and on a crowded workspace
  // pushed the last tab to a second row) just from toggling a UX-only affordance. Overlaid, the bar is
  // byte-identical in both modes and only the icon appears. The trigger keeps a little end padding so the
  // key never lands on the label.
  // `self-stretch` is load-bearing, and the reason is not obvious from either file: a segmented TabsTrigger
  // sizes itself with `h-full`, which resolves against its PARENT - and once that parent is this wrapper
  // rather than the TabsList track, "full" means the span's own content height. The span shrank to the text,
  // so every tab rendered through here came out 28px tall next to a plain sibling trigger at 36px: visibly
  // uneven, and under the touch floor on a phone. Stretching the wrapper to the track restores both.
  // `shrink-0` for the same reason the trigger inside carries it: as a shrinkable item in the scrolling tab
  // strip this wrapper is squeezed narrower than its nowrap label, which then spills over the next tab.
  return (
    <span className="relative inline-flex shrink-0 items-center self-stretch">
      <TabsTrigger value={value} className={className}>
        {children}
      </TabsTrigger>
      <AccessTarget target={target} className="absolute -right-1 top-0 h-5 w-5 -translate-y-1/3 bg-background/85 backdrop-blur-sm" />
    </span>
  );
}
