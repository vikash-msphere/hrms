import { Braces } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Variable } from "./types";

// A value input with a "{{ }}" variable picker beside it. This is what makes data-passing discoverable: the
// author never types a token by hand - they pick from the trigger's fields + earlier steps' captured outputs.
export function TemplatedInput({
  value,
  onChange,
  vars,
  placeholder,
  textarea,
}: {
  value: string;
  onChange: (v: string) => void;
  vars: Variable[];
  placeholder?: string;
  textarea?: boolean;
}) {
  const insert = (token: string) => onChange(`${value ?? ""}${token}`);
  const groups = [...new Set(vars.map((v) => v.group))];
  return (
    <div className="flex items-start gap-1.5">
      {textarea ? (
        <Textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={2} className="flex-1" />
      ) : (
        <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="flex-1" />
      )}
      {vars.length > 0 && (
        <Popover>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" size="icon" title="Insert a variable"><Braces className="h-4 w-4" /></Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="max-h-72 w-64 overflow-y-auto p-1">
            {groups.map((g) => (
              <div key={g} className="mb-1">
                <div className="px-2 py-1 text-xs font-semibold uppercase text-muted-foreground">{g}</div>
                {vars.filter((v) => v.group === g).map((v) => (
                  <button key={v.token} type="button" onClick={() => insert(v.token)} className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-muted">
                    <span className="font-medium">{v.label}</span>
                    <span className="ml-2 font-mono text-xs text-muted-foreground">{v.token}</span>
                  </button>
                ))}
              </div>
            ))}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
