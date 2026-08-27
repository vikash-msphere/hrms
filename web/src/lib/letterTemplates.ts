import { useCollection } from "@/hooks/useCollection";

// The letter types available to generate, read from the `letter-templates` collection (scoped to what the
// caller may READ - the per-template access gate, managed via the ACL icon). The picker carries the resource
// `path` (the generate call references it); the full block content is resolved server-side at generation time.
export type LetterTemplateInput = { key: string; label: string; type?: "text" | "multiline"; placeholder?: string; required?: boolean };
export type LetterTemplateOption = { path: string; label: string; category?: string; letterhead?: string; inputs?: LetterTemplateInput[]; blocks?: { kind: string }[] };

export function useLetterTemplates(): LetterTemplateOption[] {
  const { rows } = useCollection<{ path: string; label: string; category?: string; letterhead?: string; inputs?: LetterTemplateInput[]; blocks?: { kind: string }[] }>("letter-templates");
  return rows.map((t) => ({ path: t.path, label: t.label, category: t.category, letterhead: t.letterhead, inputs: t.inputs, blocks: t.blocks }));
}

// Group template options by category (preserving first-seen order), for grouped pickers. Untyped go last.
export function groupByCategory(options: LetterTemplateOption[]): { category: string; items: LetterTemplateOption[] }[] {
  const groups: { category: string; items: LetterTemplateOption[] }[] = [];
  for (const o of options) {
    const cat = o.category?.trim() || "Other";
    let g = groups.find((x) => x.category === cat);
    if (!g) { g = { category: cat, items: [] }; groups.push(g); }
    g.items.push(o);
  }
  return groups;
}
