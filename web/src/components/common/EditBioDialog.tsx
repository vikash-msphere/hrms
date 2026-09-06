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

  // Line breaks are kept (the profile renders them), so only the noise goes: trailing spaces on each
  // line, and runs of three-plus newlines squashed to one blank line - a bio is not a document, and a
  // ten-line gap in the middle of one is always a paste artefact rather than intent.
  const clean = value
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  async function save() {
    await patch(`employees/${employeeId}/bio`, { bio: clean || null });
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
      submitLabel={clean ? "Save" : current ? "Clear bio" : "Save"}
      onSubmit={save}
      className="sm:max-w-md"
    >
      <div>
        <Textarea
          value={value}
          onChange={(e) => setValue(e.target.value.slice(0, MAX))}
          rows={4}
          placeholder="A line about what you do and what to ping you for…"
          autoFocus
        />
        {/* The counter used to sit alone on the right, which left the box silent about the two things
            people got wrong: that Enter is a newline here (not submit) and that those newlines survive. */}
        <div className="mt-1.5 flex items-start justify-between gap-3 text-xs">
          <p className="text-muted-foreground">Line breaks are kept. ⌘/Ctrl + Enter saves.</p>
          <p className={`shrink-0 tabular-nums ${left <= 20 ? "font-medium text-warning" : "text-muted-foreground"}`}>
            {left <= 20 ? `${left} left` : `${value.length}/${MAX}`}
          </p>
        </div>
      </div>
    </WriteDialog>
  );
}
