import * as React from "react";
import { MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useAccessMode } from "@/components/access/AccessModeProvider";
import { AccessTarget } from "@/components/access/AccessTarget";
import { isCustomMethod } from "@/components/access/customMethods";

export type RowAction = {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  destructive?: boolean;
  verb?: string; // the AEP method this action invokes (custom methods get a manage-access icon in access mode)
};

// `objectPath` ("collection/uuid") + `can` scope the per-action access icons to this row's object. In access
// mode, each CUSTOM-method action (approve/publish/lock/...) shows a manage icon; standard edit/delete rely
// on the row's object icon, so they stay un-iconed here.
export function RowActions({ actions, objectPath, can }: { actions: RowAction[]; objectPath?: string; can?: string[] }) {
  const am = useAccessMode();
  if (actions.length === 0) return null;
  const collection = objectPath?.split("/")[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontal className="h-4 w-4" />
          <span className="sr-only">Actions</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {actions.map((a) => {
          const showIcon = am.enabled && !!collection && isCustomMethod(a.verb);
          return (
            <DropdownMenuItem
              key={a.label}
              onClick={a.onClick}
              className={a.destructive ? "text-destructive focus:text-destructive" : ""}
            >
              {a.icon}
              {a.label}
              {showIcon && (
                // Stop the click from selecting (invoking) the action - the icon only opens the ACL modal.
                <span className="ml-auto pl-2" onClick={(e) => e.stopPropagation()}>
                  <AccessTarget target={{ collection: collection!, objectPath, verb: a.verb, can, label: a.label }} />
                </span>
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
