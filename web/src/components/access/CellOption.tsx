import { cn } from "@/lib/utils";
import { accessTone } from "./permMatrix";

// One access level as a coloured dot + coloured label ("read", "write", "admin", "deny", "none").
//
// A permissions matrix is sixty rows by five roles of one-word values, and as plain grey text nothing about
// it reads at a glance: "write" and "none" have the same weight, and a deny hides in the middle of a column.
// The tone comes from the same `accessTone` the ACL modal uses, so a level looks identical wherever it is
// shown. Radix clones the SELECTED item's children into the trigger, so this one component styles both the
// open menu and the closed control.
export function CellOption({ value }: { value: string }) {
  const tone = accessTone(value);
  return (
    <span className={cn("inline-flex items-center gap-2 whitespace-nowrap font-medium", tone.text)}>
      <span className={cn("h-2 w-2 shrink-0 rounded-full", tone.dot)} />
      {value}
    </span>
  );
}
