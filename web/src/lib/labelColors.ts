// Preset palette for board label colours (hex). Mid-tone shades so a label chip - the colour as text over a
// ~13% tint of itself - reads on both the light and dark themes. Slate first: it is the uncoloured default.
export const LABEL_COLORS = [
  "#64748b", "#dc2626", "#ea580c", "#d97706", "#65a30d", "#16a34a",
  "#0d9488", "#0891b2", "#2563eb", "#4f46e5", "#7c3aed", "#db2777",
];

export const DEFAULT_LABEL_COLOR = LABEL_COLORS[0];

// The colour for a newly added label: the first preset no existing label uses (skipping the slate default),
// cycling through the palette once every preset is taken.
export function nextLabelColor(used: (string | null | undefined)[]): string {
  const taken = new Set(used.map((c) => c?.toLowerCase()));
  const rest = LABEL_COLORS.slice(1);
  return rest.find((c) => !taken.has(c)) ?? rest[used.length % rest.length];
}
