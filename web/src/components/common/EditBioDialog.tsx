import { useEffect, useState } from "react";
import { patch } from "@/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

const MAX = 280;

/** Editor for the public "about me" one-liner (employees/<id>/bio - owner + HR writable). The bio
 *  itself displays via the base employee record; callers reload that on save. */
export function EditBioDialog({
  employeeId,
  current,
  open,
  onOpenChange,
  onSaved,
}: {
  employeeId: string;
  current?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
}) {
  const { toast } = useToast();
  const [value, setValue] = useState(current ?? "");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setValue(current ?? "");
  }, [open, current]);

  async function save() {
    setSaving(true);
    try {
      await patch(`employees/${employeeId}/bio`, { bio: value.trim() || null });
      toast({ title: "Bio saved", variant: "success" });
      onOpenChange(false);
      onSaved?.();
    } catch (e) {
      toast({ title: "Couldn't save bio", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>About me</DialogTitle>
        </DialogHeader>
        <div>
          <Textarea
            value={value}
            onChange={(e) => setValue(e.target.value.slice(0, MAX))}
            rows={3}
            placeholder="A line about what you do and what to ping you for…"
            autoFocus
          />
          <p className="mt-1 text-right text-xs text-muted-foreground">
            {value.length}/{MAX}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
