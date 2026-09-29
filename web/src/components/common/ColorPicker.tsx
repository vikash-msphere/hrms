import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

// A colour choice: a swatch that opens a grid of preset colours, with the native picker underneath for any
// colour outside the presets. `value` is a #rrggbb hex; a value off the palette shows as the custom colour.
export function ColorPicker({ value, onChange, presets, label = "Choose color", className }: {
  value: string;
  onChange: (hex: string) => void;
  presets: readonly string[];
  label?: string;
  className?: string;
}) {
  const current = value.toLowerCase();
  const isPreset = presets.some((c) => c.toLowerCase() === current);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn("h-8 w-8 shrink-0 rounded-md border ring-offset-2 ring-offset-background transition hover:ring-2 hover:ring-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}
          style={{ backgroundColor: value }}
        />
      </PopoverTrigger>
      <PopoverContent className="w-auto p-2">
        <div className="grid grid-cols-6 gap-2">
          {presets.map((c) => {
            const selected = c.toLowerCase() === current;
            return (
              <button
                key={c}
                type="button"
                aria-label={c}
                aria-pressed={selected}
                onClick={() => onChange(c)}
                className={cn("flex h-7 w-7 items-center justify-center rounded-full ring-offset-2 ring-offset-background transition hover:scale-110", selected && "ring-2 ring-ring")}
                style={{ backgroundColor: c }}
              >
                {selected && <Check className="h-3.5 w-3.5 text-white" />}
              </button>
            );
          })}
        </div>
        <label className={cn("mt-2 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted", !isPreset && "text-foreground")}>
          <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="h-6 w-8 cursor-pointer rounded border bg-background p-0.5" />
          {isPreset ? "Custom color" : `Custom color (${value})`}
        </label>
      </PopoverContent>
    </Popover>
  );
}
