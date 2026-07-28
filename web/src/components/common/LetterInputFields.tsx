import type { LetterTemplateInput } from "@/lib/letterTemplates";
import { Field } from "@/components/common/Field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

// Renders the HR-filled fields a letter template declares (e.g. subject + body for the "Other" letter).
export function LetterInputFields({ inputs, values, onChange }: { inputs: LetterTemplateInput[]; values: Record<string, string>; onChange: (key: string, v: string) => void }) {
  return (
    <>
      {inputs.map((f) => (
        <Field key={f.key} label={f.label + (f.required ? "" : " (optional)")}>
          {f.type === "multiline" ? (
            <Textarea rows={6} value={values[f.key] ?? ""} onChange={(e) => onChange(f.key, e.target.value)} placeholder={f.placeholder} />
          ) : (
            <Input value={values[f.key] ?? ""} onChange={(e) => onChange(f.key, e.target.value)} placeholder={f.placeholder} />
          )}
        </Field>
      ))}
    </>
  );
}

// True when a required field is still blank (used to disable the Generate button).
export function missingRequiredInputs(inputs: LetterTemplateInput[] | undefined, values: Record<string, string>): boolean {
  return !!inputs?.some((f) => f.required && !(values[f.key] ?? "").trim());
}
