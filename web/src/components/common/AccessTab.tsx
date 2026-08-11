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
  return (
    <span className="relative inline-flex items-center">
      <TabsTrigger value={value} className={className}>
        {children}
      </TabsTrigger>
      <AccessTarget target={target} className="absolute -right-1 top-0 h-5 w-5 -translate-y-1/3 bg-background/85 backdrop-blur-sm" />
    </span>
  );
}
