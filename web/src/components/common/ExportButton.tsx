import { Download, FileSpreadsheet, FileText } from "lucide-react";
import { AccessAction } from "@/components/access/AccessAction";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

// The one export affordance for views that aren't a DataTable (attendance history, the leave calendar).
// DataTable owns its own copy because it also exports column state; everything else shares this so the
// capability gate, the icon and the CSV/Excel choice can't drift between pages. Who may export at all is the
// virtual `export` capability - the rows themselves are already whatever the caller could read.
export function ExportButton({ canExport, label, onExport, disabled }: {
  canExport: boolean;
  label: string;
  onExport: (format: "csv" | "xlsx") => void;
  disabled?: boolean;
}) {
  if (!canExport) return null;
  return (
    <AccessAction collection="export" label="Data export">
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="icon" className="h-7 w-7" aria-label={label} title={label} disabled={disabled}><Download className="h-3.5 w-3.5" /></Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-44 p-1">
          <button type="button" onClick={() => onExport("csv")} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"><FileText className="h-4 w-4 text-muted-foreground" /> CSV</button>
          <button type="button" onClick={() => onExport("xlsx")} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"><FileSpreadsheet className="h-4 w-4 text-muted-foreground" /> Excel (.xlsx)</button>
        </PopoverContent>
      </Popover>
    </AccessAction>
  );
}
