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
  return (
    <span className="inline-flex items-center">
      <TabsTrigger value={value} className={className}>
        {children}
      </TabsTrigger>
      <AccessTarget target={target} className="-ml-0.5 h-5 w-5" />
    </span>
  );
}
