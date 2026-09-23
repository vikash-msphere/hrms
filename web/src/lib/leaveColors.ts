// Preset palette for leave-type colours (hex). Shared by the Leave Types swatch picker and the timeline so a
// type's colour is consistent everywhere. Applied via inline style (dynamic Tailwind classes don't survive purge).
export const LEAVE_COLORS = [
  "#8b5cf6", "#10b981", "#0ea5e9", "#f43f5e", "#f59e0b", "#14b8a6",
  "#6366f1", "#d946ef", "#84cc16", "#f97316", "#06b6d4", "#ec4899",
];

// A leave type's display colour: its configured hex, else a stable palette pick derived from `key` (the leave
// type's id/path), so an uncoloured type gets the same fallback colour everywhere it's shown.
export function leaveColor(configured: string | null | undefined, key = ""): string {
  if (configured) return configured;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return LEAVE_COLORS[h % LEAVE_COLORS.length];
}
