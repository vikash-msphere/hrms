import { useEffect, useState } from "react";
import { patch } from "@/api";
import { Textarea } from "@/components/ui/textarea";
import { WriteDialog } from "@/components/common/WriteDialog";
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
  useEffect(() => {
    if (open) setValue(current ?? "");
  }, [open, current]);

  async function save() {
    await patch(`employees/${employeeId}/bio`, { bio: value.trim() || null });
    toast({ title: "Bio saved", variant: "success" });
    onSaved?.();
  }

  const left = MAX - value.length;
  return (
    /* Cmd/Ctrl+Enter submits: the only field is a textarea, where plain Enter has to stay a newline. */
    <WriteDialog
      open={open}
      onClose={() => onOpenChange(false)}
      title="About me"
      description="Shown on your profile and in the directory preview to anyone who can see you."
      collection="employees"
      objectPath={`employees/${employeeId}`}
      guardLabel="bio"
      form={value}
      submitLabel={value.trim() ? "Save" : current ? "Clear bio" : "Save"}
      onSubmit={save}
      className="sm:max-w-md"
    >
      <div>
        <Textarea
          value={value}
          onChange={(e) => setValue(e.target.value.slice(0, MAX))}
          rows={3}
          placeholder="A line about what you do and what to ping you for…"
          autoFocus
        />
        <p className={`mt-1 text-right text-xs ${left <= 20 ? "font-medium text-warning" : "text-muted-foreground"}`}>
          {left <= 20 ? `${left} left` : `${value.length}/${MAX}`}
        </p>
      </div>
    </WriteDialog>
  );
}
