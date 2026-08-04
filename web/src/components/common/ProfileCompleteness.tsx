import { Plus } from "lucide-react";
import type { Employee } from "@/types";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type Flags = NonNullable<Employee["profile_completeness"]>;
export type CompletenessKey = keyof Flags;

/** Fixed checklist order; labels match the tab/section each chip jumps to. */
const ITEMS: { key: CompletenessKey; label: string }[] = [
  { key: "photo", label: "Profile photo" },
  { key: "personal", label: "Personal details" },
  { key: "contact", label: "Contact details" },
  { key: "emergency", label: "Emergency contact" },
  { key: "identity", label: "Identity" },
  { key: "bank", label: "Bank details" },
  { key: "signature", label: "Signature" },
];

/** Slim checklist under/inside a profile page: progress bar + one chip per missing section, each
 *  jumping straight to where it's filled in. Data rides the employee record the page already fetched
 *  (server-computed; owner + HR) - no extra requests. Hides itself once everything is filled.
 *
 *  variant="self" (default) is the /profile nudge ("Complete your profile"); variant="record" is the
 *  neutral HR framing on someone else's page ("Record completeness" - about the record, not the viewer).
 *  Sections the server withheld (flag absent, e.g. signature for non-owners) are left out entirely. */
export function ProfileCompleteness({ flags, onItem, variant = "self" }: { flags: Flags; onItem: (key: CompletenessKey) => void; variant?: "self" | "record" }) {
  const items = ITEMS.filter((i) => flags[i.key] !== undefined);
  const missing = items.filter((i) => !flags[i.key]);
  if (missing.length === 0) return null;
  const done = items.length - missing.length;
  const pct = Math.round((done / items.length) * 100);
  return (
    <Card className="mt-4">
      <CardContent className="py-4">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm font-medium">{variant === "record" ? "Record completeness" : "Complete your profile"}</p>
          <p className="text-sm text-muted-foreground">
            <span className="font-semibold text-foreground">{pct}%</span> · {done} of {items.length} done
          </p>
        </div>
        <div
          className="mt-2 h-2 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Profile completeness"
        >
          <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {missing.map((i) => (
            <Button
              key={i.key}
              size="sm"
              variant="outline"
              className="h-7 rounded-full px-2.5 text-xs font-normal"
              onClick={() => onItem(i.key)}
            >
              <Plus className="h-3.5 w-3.5 text-primary" /> {i.label}
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
