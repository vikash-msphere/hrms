import * as React from "react";
import { Upload, X, FileText } from "lucide-react";
import { cn, formatBytes } from "@/lib/utils";

// One file target, wherever a form takes a file: click it, drop onto it, or (on a phone) shoot it.
//
// A bare <input type="file"> is the weakest control in a form - it shows a system button, no size, no way to
// change your mind, and it ignores the drag that is how a PDF actually leaves a mail client. This is the same
// affordance everywhere instead: a dashed target that reports what is attached and can be cleared.
//
// The input stays focusable (sr-only, not hidden) so the whole thing is reachable by keyboard, and the wrapper
// shows the focus ring for it.
export function FileDropField({
  file,
  onFile,
  files,
  onFiles,
  accept,
  /** What may be dropped, in the reader's words ("PDF only", "PDF, image or spreadsheet"). */
  hint,
  /** Offer the camera on a phone - for receipts and photographed paperwork. */
  capture,
  className,
}: {
  file?: File | null;
  onFile?: (f: File | null) => void;
  /** Multi-file mode: pass the list and `onFiles` instead of `file`/`onFile`. */
  files?: File[];
  onFiles?: (f: File[]) => void;
  accept?: string;
  hint?: string;
  capture?: boolean;
  className?: string;
}) {
  const [over, setOver] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const multiple = !!onFiles;
  const list = multiple ? files ?? [] : file ? [file] : [];
  const take = (picked: File[]) => {
    if (multiple) onFiles?.([...(files ?? []), ...picked]);
    else onFile?.(picked[0] ?? null);
  };
  const drop = (index: number) => {
    if (multiple) onFiles?.((files ?? []).filter((_, i) => i !== index));
    else onFile?.(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const picked = Array.from(e.dataTransfer.files ?? []);
        if (picked.length) take(multiple ? picked : picked.slice(0, 1));
      }}
      className={cn(
        "rounded-lg border border-dashed transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-ring/40",
        over ? "border-primary bg-primary/5" : "border-border bg-muted/40",
        className,
      )}
    >
      {list.length > 0 ? (
        <div className="divide-y">
          {list.map((f, i) => (
            <div key={`${f.name}:${f.size}:${i}`} className="flex items-center gap-3 p-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-background">
                <FileText className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{f.name}</p>
                <p className="text-xs text-muted-foreground">{formatBytes(f.size)}</p>
              </div>
              <button
                type="button"
                onClick={() => drop(i)}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label={`Remove ${f.name}`}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
          {/* Kept mounted so adding or swapping a file is one click on the list itself. */}
          <label className="flex cursor-pointer items-center justify-center gap-1.5 px-3 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
            <Upload className="h-3.5 w-3.5" /> {multiple ? "Add another file" : "Change the file"}
            <input ref={inputRef} type="file" accept={accept} multiple={multiple} className="sr-only" onChange={(e) => take(Array.from(e.target.files ?? []))} />
          </label>
        </div>
      ) : (
        <label className="flex cursor-pointer flex-col items-center justify-center gap-1.5 px-4 py-6 text-center">
          <Upload className="h-5 w-5 text-muted-foreground" />
          <span className="text-sm">
            <span className="font-medium text-foreground">{capture ? "Take a photo" : multiple ? "Choose files" : "Choose a file"}</span>
            <span className="text-muted-foreground">{capture ? " or pick one" : multiple ? " or drop them here" : " or drop it here"}</span>
          </span>
          {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
          <input
            ref={inputRef}
            type="file"
            accept={accept}
            multiple={multiple}
            {...(capture ? { capture: "environment" as const } : {})}
            className="sr-only"
            onChange={(e) => take(Array.from(e.target.files ?? []))}
          />
        </label>
      )}
    </div>
  );
}
